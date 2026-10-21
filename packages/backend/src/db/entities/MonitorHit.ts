import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Policy } from './Policy.js';

/**
 * One package version a monitor-mode policy would have blocked on a real download.
 * hit_count is the number of downloads seen, folded in from Redis at most once a minute.
 */
@Entity('monitor_hits')
@Index('uq_monitor_hits_policy_id_ecosystem_package_name_version', ['policyId', 'ecosystem', 'packageName', 'version'], { unique: true })
@Index('idx_monitor_hits_policy_id_reason_key', ['policyId', 'reasonKey'])
@Index('idx_monitor_hits_policy_id_ecosystem_package_name', ['policyId', 'ecosystem', 'packageName'])
@Index('idx_monitor_hits_last_seen_at', ['lastSeenAt'])
export class MonitorHit {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_monitor_hits' })
  id!: string;

  @Column({ name: 'policy_id', type: 'uuid' })
  policyId!: string;

  @ManyToOne(() => Policy, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'policy_id', foreignKeyConstraintName: 'fk_monitor_hits_policy_id' })
  policy?: Policy;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ name: 'package_name', type: 'varchar', length: 512 })
  packageName!: string;

  @Column({ type: 'varchar', length: 256 })
  version!: string;

  /** What the report groups by, e.g. a license expression, `cve:CVE-2024-1`, `too_new`. */
  @Column({ name: 'reason_key', type: 'varchar', length: 512 })
  reasonKey!: string;

  @Column({ type: 'jsonb', default: [] })
  reasons!: string[];

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  /** Repository keys downloads were seen on, at most 20. For display and filtering only. */
  @Column({ type: 'jsonb', default: [] })
  repositories!: string[];

  @Column({ name: 'hit_count', type: 'int', default: 1 })
  hitCount!: number;
}
