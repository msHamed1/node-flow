export const paymentExchange = 'nodeflow.payments';
export const paymentsCreatedQueue = 'payments.created';
export const paymentsSettledQueue = 'payments.settled';
export const paymentsCreatedRoutingKey = 'payments.created';
export const paymentsSettledRoutingKey = 'payments.settled';

export type IntegrationFailure =
  'postgres' | 'mongodb' | 'redis' | 'rabbitmq' | 'http' | 'business' | 'worker';

export interface FullFlowInput {
  amount: number;
  currency?: string;
  idempotencyKey?: string;
  failAt?: IntegrationFailure;
}

export interface PaymentCreatedEvent {
  paymentId: string;
  amount: number;
  currency: string;
  failAt?: IntegrationFailure;
  createdAt: string;
}

export interface PaymentSettledEvent {
  paymentId: string;
  settledAt: string;
}
