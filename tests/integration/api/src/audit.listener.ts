import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { PaymentCreatedEvent } from '@mshamed1/node-flow-integration-contracts';

@Injectable()
export class AuditListener {
  private handledEvents = 0;

  @OnEvent('payment.created.local')
  handlePaymentCreated(event: PaymentCreatedEvent): void {
    this.handledEvents += 1;
    console.log(`Local payment event handled for ${event.paymentId}`);
  }

  handledCount(): number {
    return this.handledEvents;
  }
}
