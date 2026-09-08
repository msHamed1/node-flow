import { traceBoundary } from '@mshamed1/node-flow';

export const DEMO_REDIS = Symbol('DEMO_REDIS');
export const DEMO_MONGO = Symbol('DEMO_MONGO');
export const DEMO_QUEUE = Symbol('DEMO_QUEUE');
export const DEMO_INVENTORY_API = Symbol('DEMO_INVENTORY_API');

export interface DemoRedis {
  read(key: string): Promise<{ key: string; found: boolean }>;
}

export interface DemoMongo {
  insert(collection: string, value: unknown): Promise<{ id: string }>;
}

export interface DemoQueue {
  publish(topic: string, value: unknown): Promise<void>;
}

export interface DemoInventoryApi {
  reserve(sku: string): Promise<{ sku: string; reserved: boolean }>;
}

export const simulatedInfrastructureProviders = [
  {
    provide: DEMO_REDIS,
    useValue: {
      read(key: string) {
        return traceBoundary(
          { type: 'redis', name: 'Redis', identity: 'redis:session-cache', operation: 'GET' },
          async () => {
            await delay(5);
            return { key, found: true };
          },
        );
      },
    } satisfies DemoRedis,
  },
  {
    provide: DEMO_MONGO,
    useValue: {
      insert(collection: string, _value: unknown) {
        return traceBoundary(
          {
            type: 'database',
            name: 'MongoDB',
            identity: 'database:mongodb:payments',
            operation: `INSERT ${collection}`,
            attributes: { 'db.system.name': 'mongodb', 'db.namespace': collection },
          },
          async () => {
            await delay(14);
            return { id: `doc_${Math.random().toString(36).slice(2, 9)}` };
          },
        );
      },
    } satisfies DemoMongo,
  },
  {
    provide: DEMO_QUEUE,
    useValue: {
      publish(topic: string, _value: unknown) {
        return traceBoundary(
          {
            type: 'queue',
            name: 'RabbitMQ',
            identity: 'queue:rabbitmq',
            operation: `PUBLISH ${topic}`,
            attributes: { 'messaging.system': 'rabbitmq', 'messaging.destination.name': topic },
          },
          async () => delay(7),
        );
      },
    } satisfies DemoQueue,
  },
  {
    provide: DEMO_INVENTORY_API,
    useValue: {
      reserve(sku: string) {
        return traceBoundary(
          {
            type: 'external-http',
            name: 'inventory.example.local',
            identity: 'external-http:inventory.example.local',
            operation: 'POST /reservations',
          },
          async () => {
            await delay(22);
            return { sku, reserved: true };
          },
        );
      },
    } satisfies DemoInventoryApi,
  },
] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
