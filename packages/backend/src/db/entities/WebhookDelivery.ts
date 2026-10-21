import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { WebhookTarget } from './WebhookTarget.js';

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

/** One event sent (or not) to one webhook. The worker writes it; kept WEBHOOK_DELIVERY_RETENTION_DAYS. */
@Entity('webhook_deliveries')
@Index('idx_webhook_deliveries_target_id_created_at', ['targetId', 'createdAt'])
@Index('idx_webhook_deliveries_created_at', ['createdAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_webhook_deliveries' })
  id!: string;

  /** Time-ordered event ID, the same for every target and every redelivery of the event. */
  @Column({ name: 'event_id', type: 'varchar', length: 36 })
  eventId!: string;

  @Column({ name: 'target_id', type: 'uuid' })
  targetId!: string;

  @ManyToOne(() => WebhookTarget, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'target_id', foreignKeyConstraintName: 'fk_webhook_deliveries_target_id' })
  target?: WebhookTarget;

  @Column({ type: 'varchar', length: 64 })
  event!: string;

  /** The event as sent, without `id`, `attempt` or the signature. */
  @Column({ type: 'jsonb', default: {} })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16 })
  status!: WebhookDeliveryStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'last_status_code', type: 'int', nullable: true })
  lastStatusCode!: number | null;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;
}
