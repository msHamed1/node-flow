import {
  BadGatewayException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import type { Connection, Model } from 'mongoose';
import { Pool, type PoolClient } from 'pg';
import { createClient } from 'redis';
import {
  paymentExchange,
  paymentsCreatedQueue,
  paymentsCreatedRoutingKey,
  paymentsSettledQueue,
  paymentsSettledRoutingKey,
  type FullFlowInput,
  type PaymentCreatedEvent,
} from '@mshamed1/node-flow-integration-contracts';
import type { PaymentAudit, PaymentAuditDocument, Player, PlayerDocument } from './schemas.js';

interface PaymentRow {
  id: string;
  amount: string;
  currency: string;
  status: string;
}

@Injectable()
export class IntegrationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly postgres = new Pool({
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    user: process.env.POSTGRES_USER ?? 'nodeflow',
    password: process.env.POSTGRES_PASSWORD ?? 'nodeflow',
    database: process.env.POSTGRES_DB ?? 'nodeflow',
    max: 5,
  });
  private readonly redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://redis:6379',
  });
  private rabbitConnection?: ChannelModel;
  private rabbitChannel?: Channel;

  constructor(
    @InjectModel('PaymentAudit')
    private readonly paymentAudits: Model<PaymentAuditDocument>,
    @InjectModel('Player') private readonly players: Model<PlayerDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly events: EventEmitter2,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await retry('PostgreSQL', async () => {
      await this.postgres.query('SELECT 1');
    });
    await this.initializePostgres();
    this.redis.on('error', (error) => console.error('Redis client error:', error.message));
    await retry('Redis', async () => {
      if (!this.redis.isOpen) await this.redis.connect();
      await this.redis.ping();
    });
    await retry('RabbitMQ', async () => {
      this.rabbitConnection = await connect(
        process.env.RABBITMQ_URL ?? 'amqp://nodeflow:nodeflow@rabbitmq:5672',
      );
      this.rabbitConnection.on('error', (error) =>
        console.error('RabbitMQ connection error:', error.message),
      );
      this.rabbitChannel = await this.rabbitConnection.createChannel();
      this.rabbitChannel.on('error', (error) =>
        console.error('RabbitMQ channel error:', error.message),
      );
      await this.prepareRabbitTopology(this.rabbitChannel);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
    await this.rabbitChannel?.close().catch(() => undefined);
    await this.rabbitConnection?.close().catch(() => undefined);
    await this.postgres.end();
  }

  async fullFlow(input: FullFlowInput): Promise<Record<string, unknown>> {
    const paymentId = randomUUID();
    const amount = Number(input.amount);
    const currency = input.currency ?? 'USD';
    if (!Number.isFinite(amount) || amount <= 0)
      throw new ConflictException('amount must be positive');

    if (input.failAt === 'business') throw new Error('Deterministic business failure');
    if (input.failAt === 'redis') await this.redis.sendCommand(['NODEFLOW_INVALID_COMMAND']);

    const idempotencyKey = `nodeflow:idempotency:${input.idempotencyKey ?? paymentId}`;
    const acquired = await this.redis.set(idempotencyKey, 'processing', { NX: true, EX: 60 });
    if (acquired !== 'OK') throw new ConflictException('Duplicate integration request');

    try {
      if (input.failAt === 'postgres') await this.postgres.query('SELECT * FROM nodeflow_missing');
      const row = await this.persistPayment(paymentId, amount, currency);

      const audit = await this.paymentAudits.create({
        paymentId,
        stage: 'api.persisted',
        details: { amount, currency },
      });
      await this.paymentAudits.findById(audit._id).lean().exec();
      if (input.failAt === 'mongodb') {
        await this.requireMongoDatabase().command({ nodeflowInvalidCommand: 1 });
      }

      const risk = await this.checkRisk(amount, input.failAt === 'http');
      const event: PaymentCreatedEvent = {
        paymentId,
        amount,
        currency,
        ...(input.failAt ? { failAt: input.failAt } : {}),
        createdAt: new Date().toISOString(),
      };
      this.events.emit('payment.created.local', event);

      if (input.failAt === 'rabbitmq') {
        const failureChannel = await this.requireRabbitConnection().createChannel();
        failureChannel.on('error', () => undefined);
        try {
          await failureChannel.checkQueue('nodeflow.queue.does.not.exist');
        } finally {
          await failureChannel.close().catch(() => undefined);
        }
      }
      this.publish(this.requireRabbitChannel(), paymentsCreatedRoutingKey, event);
      await this.redis.set(idempotencyKey, 'published', { EX: 60 });
      return { payment: row, risk, auditId: String(audit._id), queued: true };
    } catch (error) {
      await this.redis.del(idempotencyKey).catch(() => undefined);
      throw error;
    }
  }

  async postgresOperations(): Promise<PaymentRow> {
    return this.persistPayment(randomUUID(), 125, 'USD');
  }

  async mongooseOperations(): Promise<{ paymentId: string; aggregateCount: number }> {
    const paymentId = randomUUID();
    const created = await this.paymentAudits.create({ paymentId, stage: 'created' });
    await this.paymentAudits.find({ paymentId }).lean().exec();
    await this.paymentAudits.findOne({ paymentId }).lean().exec();
    await this.paymentAudits.findById(created._id).lean().exec();
    created.stage = 'saved';
    await created.save();
    await this.paymentAudits.updateOne({ paymentId }, { $set: { stage: 'updated' } }).exec();
    await this.paymentAudits
      .findOneAndUpdate({ paymentId }, { $set: { stage: 'find-one-updated' } }, { new: true })
      .lean()
      .exec();
    const aggregate = await this.paymentAudits.aggregate<{ count: number }>([
      { $match: { paymentId } },
      { $count: 'count' },
    ]);
    await this.paymentAudits.deleteOne({ paymentId }).exec();
    return { paymentId, aggregateCount: aggregate[0]?.count ?? 0 };
  }

  async redisOperations(): Promise<Record<string, unknown>> {
    const key = `nodeflow:redis:${randomUUID()}`;
    const counter = `${key}:counter`;
    await this.redis.set(key, 'value');
    const value = await this.redis.get(key);
    const incremented = await this.redis.incr(counter);
    const values = await this.redis.mGet([key, counter]);
    await this.redis.expire(key, 60);
    const ttl = await this.redis.ttl(key);
    await this.redis.del([key, counter]);
    return { value, incremented, values, ttl };
  }

  async rabbitmqOperations(): Promise<{ published: boolean }> {
    const event: PaymentCreatedEvent = {
      paymentId: randomUUID(),
      amount: 50,
      currency: 'USD',
      createdAt: new Date().toISOString(),
    };
    return {
      published: this.publish(this.requireRabbitChannel(), paymentsCreatedRoutingKey, event),
    };
  }

  async httpOperations(fail = false): Promise<Record<string, unknown>> {
    return this.checkRisk(125, fail);
  }

  async getPayment(paymentId: string): Promise<PaymentRow> {
    const result = await this.postgres.query<PaymentRow>(
      'SELECT id, amount, currency, status FROM nodeflow_payments WHERE id = $1',
      [paymentId],
    );
    const payment = result.rows[0];
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async getPlayer(playerId: string): Promise<Record<string, unknown>> {
    const cacheKey = `nodeflow:player:${playerId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return { source: 'redis', player: JSON.parse(cached) as unknown };

    const found = await this.players.findOne({ playerId }).lean().exec();
    const player = found
      ? { playerId: found.playerId, displayName: found.displayName, visits: found.visits }
      : (
          await this.players.create({ playerId, displayName: `Player ${playerId}`, visits: 0 })
        ).toObject();
    await this.players.updateOne({ playerId }, { $inc: { visits: 1 } }).exec();
    await this.redis.set(cacheKey, JSON.stringify(player), { EX: 60 });
    return { source: 'mongodb', player };
  }

  private async initializePostgres(): Promise<void> {
    await this.postgres.query(`
      CREATE TABLE IF NOT EXISTS nodeflow_payments (
        id uuid PRIMARY KEY,
        amount numeric(12, 2) NOT NULL,
        currency text NOT NULL,
        status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  private async persistPayment(
    paymentId: string,
    amount: number,
    currency: string,
  ): Promise<PaymentRow> {
    const client = await this.postgres.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO nodeflow_payments (id, amount, currency, status) VALUES ($1, $2, $3, $4)',
        [paymentId, amount, currency, 'created'],
      );
      await client.query(
        'SELECT id, amount, currency, status FROM nodeflow_payments WHERE id = $1',
        [paymentId],
      );
      const updated = await client.query<PaymentRow>(
        'UPDATE nodeflow_payments SET status = $2 WHERE id = $1 RETURNING id, amount, currency, status',
        [paymentId, 'persisted'],
      );
      await client.query('COMMIT');
      return updated.rows[0]!;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async checkRisk(amount: number, fail: boolean): Promise<Record<string, unknown>> {
    const url = `${process.env.RISK_SERVICE_URL ?? 'http://mock-risk-service:3100'}/risk/check`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount, fail }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new BadGatewayException(body);
    return body;
  }

  private async prepareRabbitTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(paymentExchange, 'topic', { durable: true });
    await channel.assertQueue(paymentsCreatedQueue, { durable: true });
    await channel.assertQueue(paymentsSettledQueue, { durable: true });
    await channel.bindQueue(paymentsCreatedQueue, paymentExchange, paymentsCreatedRoutingKey);
    await channel.bindQueue(paymentsSettledQueue, paymentExchange, paymentsSettledRoutingKey);
  }

  private publish(channel: Channel, routingKey: string, event: object): boolean {
    return channel.publish(paymentExchange, routingKey, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
    });
  }

  private requireMongoDatabase() {
    const database = this.mongoConnection.db;
    if (!database) throw new Error('MongoDB connection is not ready');
    return database;
  }

  private requireRabbitConnection(): ChannelModel {
    if (!this.rabbitConnection) throw new Error('RabbitMQ connection is not ready');
    return this.rabbitConnection;
  }

  private requireRabbitChannel(): Channel {
    if (!this.rabbitChannel) throw new Error('RabbitMQ channel is not ready');
    return this.rabbitChannel;
  }
}

async function retry(name: string, operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      console.log(`${name} not ready (attempt ${attempt}/30)`);
      await delay(1_000);
    }
  }
  throw lastError;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}
