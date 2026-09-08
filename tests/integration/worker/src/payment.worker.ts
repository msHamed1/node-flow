import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import type { Connection, Model } from 'mongoose';
import { Pool } from 'pg';
import {
  paymentExchange,
  paymentsCreatedQueue,
  paymentsCreatedRoutingKey,
  paymentsSettledQueue,
  paymentsSettledRoutingKey,
  type PaymentCreatedEvent,
  type PaymentSettledEvent,
} from '@mshamed1/node-flow-integration-contracts';
import type { WorkerPaymentAuditDocument } from './payment-audit.schema.js';

@Injectable()
export class PaymentWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly postgres = new Pool({
    host: process.env.POSTGRES_HOST ?? 'postgres',
    port: Number.parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    user: process.env.POSTGRES_USER ?? 'nodeflow',
    password: process.env.POSTGRES_PASSWORD ?? 'nodeflow',
    database: process.env.POSTGRES_DB ?? 'nodeflow',
    max: 3,
  });
  private rabbitConnection?: ChannelModel;
  private rabbitChannel?: Channel;

  constructor(
    @InjectModel('WorkerPaymentAudit')
    private readonly paymentAudits: Model<WorkerPaymentAuditDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await retry(async () => {
      await this.postgres.query('SELECT 1');
    });
    await retry(async () => {
      this.rabbitConnection = await connect(
        process.env.RABBITMQ_URL ?? 'amqp://nodeflow:nodeflow@rabbitmq:5672',
      );
      this.rabbitConnection.on('error', (error) =>
        console.error('Worker RabbitMQ connection error:', error.message),
      );
      this.rabbitChannel = await this.rabbitConnection.createChannel();
      this.rabbitChannel.on('error', (error) =>
        console.error('Worker RabbitMQ channel error:', error.message),
      );
      await this.prepareRabbitTopology(this.rabbitChannel);
    });
    const channel = this.requireRabbitChannel();
    await channel.prefetch(4);
    await channel.consume(paymentsCreatedQueue, (message) => {
      if (message) void this.processCreatedMessage(message);
    });
    await channel.consume(paymentsSettledQueue, (message) => {
      if (message) void this.processSettledMessage(message);
    });
    console.log('Payment worker is consuming payments.created and payments.settled');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.rabbitChannel?.close().catch(() => undefined);
    await this.rabbitConnection?.close().catch(() => undefined);
    await this.postgres.end();
  }

  async processCreatedMessage(message: ConsumeMessage): Promise<void> {
    const event = parseMessage<PaymentCreatedEvent>(message);
    try {
      if (event.failAt === 'worker') {
        await this.requireMongoDatabase().command({ nodeflowInvalidWorkerCommand: 1 });
      }
      await this.paymentAudits
        .findOneAndUpdate(
          { paymentId: event.paymentId },
          { $set: { stage: 'worker.processed', details: { amount: event.amount } } },
          { upsert: true, new: true },
        )
        .exec();
      await this.postgres.query('UPDATE nodeflow_payments SET status = $2 WHERE id = $1', [
        event.paymentId,
        'settled',
      ]);
      const settled: PaymentSettledEvent = {
        paymentId: event.paymentId,
        settledAt: new Date().toISOString(),
      };
      this.publish(paymentsSettledRoutingKey, settled);
      this.requireRabbitChannel().ack(message);
    } catch (error) {
      console.error(`Payment worker failed for ${event.paymentId}:`, error);
      this.requireRabbitChannel().nack(message, false, false);
    }
  }

  async processSettledMessage(message: ConsumeMessage): Promise<void> {
    const event = parseMessage<PaymentSettledEvent>(message);
    try {
      await this.paymentAudits.create({
        paymentId: event.paymentId,
        stage: 'worker.settled-consumed',
        details: { settledAt: event.settledAt },
      });
      this.requireRabbitChannel().ack(message);
    } catch (error) {
      console.error(`Settled-event consumer failed for ${event.paymentId}:`, error);
      this.requireRabbitChannel().nack(message, false, false);
    }
  }

  private async prepareRabbitTopology(channel: Channel): Promise<void> {
    await channel.assertExchange(paymentExchange, 'topic', { durable: true });
    await channel.assertQueue(paymentsCreatedQueue, { durable: true });
    await channel.assertQueue(paymentsSettledQueue, { durable: true });
    await channel.bindQueue(paymentsCreatedQueue, paymentExchange, paymentsCreatedRoutingKey);
    await channel.bindQueue(paymentsSettledQueue, paymentExchange, paymentsSettledRoutingKey);
  }

  private publish(routingKey: string, event: object): boolean {
    return this.requireRabbitChannel().publish(
      paymentExchange,
      routingKey,
      Buffer.from(JSON.stringify(event)),
      { contentType: 'application/json', persistent: true },
    );
  }

  private requireMongoDatabase() {
    const database = this.mongoConnection.db;
    if (!database) throw new Error('MongoDB connection is not ready');
    return database;
  }

  private requireRabbitChannel(): Channel {
    if (!this.rabbitChannel) throw new Error('RabbitMQ channel is not ready');
    return this.rabbitChannel;
  }
}

function parseMessage<T>(message: ConsumeMessage): T {
  return JSON.parse(message.content.toString('utf8')) as T;
}

async function retry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      console.log(`Worker dependency not ready (attempt ${attempt}/30)`);
      await delay(1_000);
    }
  }
  throw lastError;
}
