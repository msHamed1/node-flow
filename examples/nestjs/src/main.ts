import 'reflect-metadata';
import { Body, Controller, Inject, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';
import {
  DEMO_INVENTORY_API,
  DEMO_MONGO,
  DEMO_QUEUE,
  DEMO_REDIS,
  simulatedInfrastructureProviders,
  type DemoInventoryApi,
  type DemoMongo,
  type DemoQueue,
  type DemoRedis,
} from './simulated-infrastructure.js';
import {
  PAYMENTS_DATABASE,
  simulatedPostgresProvider,
  type CreatePaymentInput,
  type PaymentRecord,
  type PaymentsDatabase,
} from './simulated-postgres.js';

@Injectable()
class AuthService {
  constructor(@Inject(DEMO_REDIS) private readonly redis: DemoRedis) {}

  async login(email: string): Promise<{ authenticated: boolean; email: string }> {
    await this.redis.read(`session:${email}`);
    return { authenticated: true, email };
  }
}

@Injectable()
class PaymentsService {
  constructor(
    @Inject(DEMO_MONGO) private readonly mongo: DemoMongo,
    @Inject(DEMO_QUEUE) private readonly queue: DemoQueue,
  ) {}

  async createPayment(input: CreatePaymentInput): Promise<PaymentRecord> {
    const document = await this.mongo.insert('payments', input);
    await this.queue.publish('payments.created', document);
    return {
      id: document.id,
      status: 'created',
      amount: input.amount ?? 125,
      currency: input.currency ?? 'USD',
    };
  }
}

@Injectable()
class InventoryService {
  constructor(@Inject(DEMO_INVENTORY_API) private readonly inventoryApi: DemoInventoryApi) {}

  reserve(sku: string): Promise<{ sku: string; reserved: boolean }> {
    return this.inventoryApi.reserve(sku);
  }
}

@Injectable()
class OrdersService {
  constructor(
    @Inject(PAYMENTS_DATABASE) private readonly database: PaymentsDatabase,
    private readonly inventory: InventoryService,
  ) {}

  async createOrder(input: { sku?: string; amount?: number }): Promise<{
    orderId: string;
    inventory: { sku: string; reserved: boolean };
  }> {
    const inventory = await this.inventory.reserve(input.sku ?? 'nodeflow-demo');
    const record = await this.database.insert({ amount: input.amount ?? 85, currency: 'USD' });
    return { orderId: record.id, inventory };
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() input: { email?: string }): Promise<{ authenticated: boolean; email: string }> {
    return this.auth.login(input.email ?? 'developer@example.com');
  }
}

@Controller('payments')
class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  create(@Body() input: CreatePaymentInput): Promise<PaymentRecord> {
    return this.payments.createPayment(input);
  }
}

@Controller('orders')
class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() input: { sku?: string; amount?: number }): Promise<{
    orderId: string;
    inventory: { sku: string; reserved: boolean };
  }> {
    return this.orders.createOrder(input);
  }
}

@Module({
  imports: [NodeFlowModule],
  controllers: [AuthController, PaymentsController, OrdersController],
  providers: [
    AuthService,
    PaymentsService,
    OrdersService,
    InventoryService,
    simulatedPostgresProvider,
    ...simulatedInfrastructureProviders,
  ],
})
class DemoModule {}

const app = await NestFactory.create(DemoModule);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
await app.listen(port, '127.0.0.1');
console.log(`Demo application: http://127.0.0.1:${port}`);
console.log('Generate architecture traffic: yarn demo:traffic');
