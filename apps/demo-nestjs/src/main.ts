import 'reflect-metadata';
import { Body, Controller, Inject, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeScopeModule } from '@nodescope/instrumentation-nestjs';
import {
  PAYMENTS_DATABASE,
  simulatedPostgresProvider,
  type CreatePaymentInput,
  type PaymentRecord,
  type PaymentsDatabase,
} from './simulated-postgres.js';

@Injectable()
class PaymentsService {
  constructor(@Inject(PAYMENTS_DATABASE) private readonly paymentsDatabase: PaymentsDatabase) {}

  createPayment(input: CreatePaymentInput): Promise<PaymentRecord> {
    return this.paymentsDatabase.insert(input);
  }
}

@Controller('payments')
class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  create(@Body() input: CreatePaymentInput): Promise<PaymentRecord> {
    return this.paymentsService.createPayment(input);
  }
}

@Module({
  imports: [NodeScopeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, simulatedPostgresProvider],
})
class DemoModule {}

const app = await NestFactory.create(DemoModule);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
await app.listen(port, '127.0.0.1');
console.log(`Demo application: http://127.0.0.1:${port}`);
console.log(
  `Try: curl -X POST http://127.0.0.1:${port}/payments -H 'content-type: application/json' -d '{"amount":125}'`,
);
