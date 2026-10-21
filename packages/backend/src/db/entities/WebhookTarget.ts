import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('webhook_targets')
export class WebhookTarget {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_webhook_targets' })
  id!: string;

  @Column({ type: 'varchar', length: 512 })
  url!: string;

  @Column({ name: 'secret', type: 'text', nullable: true })
  secret!: string | null;

  @Column({ type: 'jsonb', default: [] })
  events!: string[];

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled!: boolean;

  /** Deliveries that failed in a row (after all their retries). A delivered event resets it. */
  @Column({ name: 'consecutive_failures', type: 'int', default: 0 })
  consecutiveFailures!: number;

  @Column({ name: 'last_error', type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  @Column({ name: 'last_failure_at', type: 'timestamptz', nullable: true })
  lastFailureAt!: Date | null;

  /** Set when DepGate disabled the webhook after too many failures; cleared when it is turned on again. */
  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  @Column({ name: 'disabled_reason', type: 'varchar', length: 500, nullable: true })
  disabledReason!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
