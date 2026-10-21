import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Summary of one ecosystem from the last applied manifest. Hashes and file names are not stored. */
export type MaliciousEcosystemSummary = {
  records: number;
  maxModified: string | null;
  changesRecords: number;
};

/**
 * One row (`id = default`) for the malicious feed cursor.
 * `watermark` is the `generated_at` of the last manifest that was fully applied.
 */
@Entity('malicious_feed_state')
export class MaliciousFeedState {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_malicious_feed_state' })
  id!: string;

  @Column({ type: 'varchar', length: 40 })
  watermark!: string;

  @Column({ name: 'schema_version', type: 'varchar', length: 16 })
  schemaVersion!: string;

  @Column({ name: 'upstream_repo', type: 'text', nullable: true })
  upstreamRepo!: string | null;

  @Column({ name: 'upstream_commit', type: 'varchar', length: 64, nullable: true })
  upstreamCommit!: string | null;

  @Column({ name: 'changes_since', type: 'varchar', length: 40 })
  changesSince!: string;

  @Column({ name: 'changes_window_days', type: 'int' })
  changesWindowDays!: number;

  @Column({ name: 'total_records', type: 'int' })
  totalRecords!: number;

  @Column({ type: 'jsonb', default: {} })
  ecosystems!: Record<string, MaliciousEcosystemSummary>;

  @Column({ name: 'applied_at', type: 'timestamptz' })
  appliedAt!: Date;
}
