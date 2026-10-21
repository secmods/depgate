import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { EventSelection } from '../../services/events/catalog.js';

export type StreamDestinationType = 'splunk' | 'datadog' | 'elastic' | 'sumo' | 'syslog' | 'http' | 'jsonl';

/** A Log Streaming destination (requirements_event_streaming.md §9). Status lives in Redis, not here. */
@Entity('stream_destinations')
export class StreamDestination {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_stream_destinations' })
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: StreamDestinationType;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  /** The type's non-secret fields (URL, index, site, host, format, …). */
  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>;

  /** The type's secrets as one JSON object, encrypted with the mail and SSO helper. Never returned by the API. */
  @Column({ name: 'secrets_enc', type: 'text', nullable: true })
  secretsEnc!: string | null;

  @Column({ type: 'jsonb', default: { features: [], events: [] } })
  selection!: EventSelection;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
