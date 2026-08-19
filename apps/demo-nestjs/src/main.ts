import 'reflect-metadata';
import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { traceBoundary, traceServiceOperation } from '@nodescope/core';
import { NodeScopeModule } from '@nodescope/instrumentation-nestjs';

interface CreatePaymentBody {
  amount?: number;
  currency?: string;
  fail?: boolean;
}

@Injectable()
class PaymentsService {
  async createPayment(input: CreatePaymentBody): Promise<{ id: string; status: string; amount: number; currency: string }> {
    return traceServiceOperation('PaymentsService', async () => {
      const payment = await traceBoundary({
        type: 'database',
        name: 'PostgreSQL',
        identity: 'database:postgresql:payments',
        operation: 'INSERT payments',
        attributes: { 'db.system.name': 'postgresql', 'db.namespace': 'payments' },
      }, async () => {
        await delay(18 + Math.floor(Math.random() * 20));
        if (input.fail) throw new Error('Simulated PostgreSQL write failure');
        return {
          id: `pay_${Math.random().toString(36).slice(2, 10)}`,
          status: 'created',
          amount: input.amount ?? 125,
          currency: input.currency ?? 'USD',
        };
      });
      return payment;
    });
  }
}

@Controller('payments')
class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  create(@Body() input: CreatePaymentBody): Promise<{ id: string; status: string; amount: number; currency: string }> {
    return this.paymentsService.createPayment(input);
  }
}

@Module({
  imports: [NodeScopeModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
class DemoModule {}

const app = await NestFactory.create(DemoModule);
await app.listen(Number.parseInt(process.env.PORT ?? '3000', 10), '127.0.0.1');
console.log('Demo application: http://127.0.0.1:3000');
console.log("Try: curl -X POST http://127.0.0.1:3000/payments -H 'content-type: application/json' -d '{\"amount\":125}'");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
