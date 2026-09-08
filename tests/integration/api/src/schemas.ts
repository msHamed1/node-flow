import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'payment_audits', timestamps: true })
export class PaymentAudit {
  @Prop({ required: true, index: true })
  paymentId!: string;

  @Prop({ required: true })
  stage!: string;

  @Prop({ type: Object })
  details?: Record<string, unknown>;
}

export type PaymentAuditDocument = HydratedDocument<PaymentAudit>;
export const PaymentAuditSchema = SchemaFactory.createForClass(PaymentAudit);

@Schema({ collection: 'players', timestamps: true })
export class Player {
  @Prop({ required: true, unique: true })
  playerId!: string;

  @Prop({ required: true })
  displayName!: string;

  @Prop({ required: true, default: 0 })
  visits!: number;
}

export type PlayerDocument = HydratedDocument<Player>;
export const PlayerSchema = SchemaFactory.createForClass(Player);
