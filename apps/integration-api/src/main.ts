import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';
import { AuditListener } from './audit.listener.js';
import { IntegrationController } from './integration.controller.js';
import { IntegrationService } from './integration.service.js';
import { PaymentAuditSchema, PlayerSchema } from './schemas.js';

@Module({
  imports: [
    NodeFlowModule,
    EventEmitterModule.forRoot(),
    MongooseModule.forRoot(process.env.MONGODB_URI ?? 'mongodb://mongodb:27017/nodeflow'),
    MongooseModule.forFeature([
      { name: 'PaymentAudit', schema: PaymentAuditSchema },
      { name: 'Player', schema: PlayerSchema },
    ]),
  ],
  controllers: [IntegrationController],
  providers: [IntegrationService, AuditListener],
})
class IntegrationApiModule {}

const app = await NestFactory.create(IntegrationApiModule);
app.enableShutdownHooks();
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '0.0.0.0';
await app.listen(port, host);
console.log(`NodeFlow integration API: http://${host}:${port}`);
