import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'payment_audits', timestamps: true })
export class WorkerPaymentAudit {
  @Prop({ required: true, index: true })
  paymentId!: string;

  @Prop({ required: true })
  stage!: string;

  @Prop({ type: Object })
  details?: Record<string, unknown>;
}

export type WorkerPaymentAuditDocument = HydratedDocument<WorkerPaymentAudit>;
export const WorkerPaymentAuditSchema = SchemaFactory.createForClass(WorkerPaymentAudit);
