import { traceBoundary } from '@nodescope/core';

export interface CreatePaymentInput {
  amount?: number;
  currency?: string;
  fail?: boolean;
}

export interface PaymentRecord {
  id: string;
  status: string;
  amount: number;
  currency: string;
}

export interface PaymentsDatabase {
  insert(input: CreatePaymentInput): Promise<PaymentRecord>;
}

export const PAYMENTS_DATABASE = Symbol('PAYMENTS_DATABASE');

export const simulatedPostgresProvider = {
  provide: PAYMENTS_DATABASE,
  useValue: {
    insert(input: CreatePaymentInput): Promise<PaymentRecord> {
      // The demo has no external database requirement. This optional boundary
      // represents the span a real instrumented `pg` client creates automatically.
      return traceBoundary(
        {
          type: 'database',
          name: 'PostgreSQL',
          identity: 'database:postgresql:payments',
          operation: 'INSERT payments',
          attributes: { 'db.system.name': 'postgresql', 'db.namespace': 'payments' },
        },
        async () => {
          await delay(18 + Math.floor(Math.random() * 20));
          if (input.fail) throw new Error('Simulated PostgreSQL write failure');
          return {
            id: `pay_${Math.random().toString(36).slice(2, 10)}`,
            status: 'created',
            amount: input.amount ?? 125,
            currency: input.currency ?? 'USD',
          };
        },
      );
    },
  } satisfies PaymentsDatabase,
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
