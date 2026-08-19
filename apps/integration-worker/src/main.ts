import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';
import { createServer } from 'node:http';
import { PaymentWorker } from './payment.worker.js';
import { WorkerPaymentAuditSchema } from './payment-audit.schema.js';

@Module({
  imports: [
    NodeFlowModule,
    MongooseModule.forRoot(process.env.MONGODB_URI ?? 'mongodb://mongodb:27017/nodeflow'),
    MongooseModule.forFeature([{ name: 'WorkerPaymentAudit', schema: WorkerPaymentAuditSchema }]),
  ],
  providers: [PaymentWorker],
})
class IntegrationWorkerModule {}

const app = await NestFactory.createApplicationContext(IntegrationWorkerModule);
app.enableShutdownHooks();

const healthPort = Number.parseInt(process.env.WORKER_HEALTH_PORT ?? '3001', 10);
const healthServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
});
healthServer.listen(healthPort, '0.0.0.0', () => {
  console.log(`Integration worker health: http://0.0.0.0:${healthPort}`);
});

const stop = async (): Promise<void> => {
  healthServer.close();
  await app.close();
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
