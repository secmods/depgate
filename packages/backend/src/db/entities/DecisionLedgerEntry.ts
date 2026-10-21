import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The Decision Ledger (requirements_event_streaming.md §5.1): what the gateway refused, and why.
 * BLOCK_ENFORCE, UPSTREAM_UNAVAILABLE, and ALLOW only for a malware-listed version. Older rows may also be
 * INTEGRITY_VIOLATION (artifact integrity checks, removed 2026-10-18).
 * Allowed downloads are counted in the summary tables, never stored row by row.
 */
@Entity('decision_ledger')
@Index('idx_decision_ledger_created', ['createdAt'])
@Index('idx_decision_ledger_decision', ['decision', 'createdAt'])
@Index('idx_decision_ledger_package', ['ecosystem', 'packageName'])
@Index('idx_decision_ledger_malware', ['createdAt'], { where: 'malware' })
export class DecisionLedgerEntry {
  /** The event's id (UUIDv7), so "Copy as JSON" and the SIEM show the same ID. */
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_decision_ledger' })
  id!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'varchar', length: 32 })
  decision!: string;

  /** The version is on the malware list, whatever the decision. Drives the Malware tag and filter. */
  @Column({ type: 'boolean', default: false })
  malware!: boolean;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ name: 'package_name', type: 'varchar', length: 512 })
  packageName!: string;

  @Column({ name: 'resolved_version', type: 'varchar', length: 128, nullable: true })
  resolvedVersion!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  repository!: string | null;

  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @Column({ name: 'policy_name', type: 'varchar', length: 256, nullable: true })
  policyName!: string | null;

  @Column({ name: 'condition_reasons', type: 'jsonb', nullable: true })
  conditionReasons!: string[] | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  requester!: string | null;

  @Column({ name: 'requester_ip', type: 'varchar', length: 64, nullable: true })
  requesterIp!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  /** user, api_key, ci_token, system, anonymous. */
  @Column({ name: 'actor_kind', type: 'varchar', length: 16, nullable: true })
  actorKind!: string | null;

  @Column({ name: 'actor_id', type: 'varchar', length: 64, nullable: true })
  actorId!: string | null;

  @Column({ name: 'auth_method', type: 'varchar', length: 16, nullable: true })
  authMethod!: string | null;

  /** The CI token or API key metadata (build ID, repo, …), and nothing else. */
  @Column({ name: 'actor_metadata', type: 'jsonb', nullable: true })
  actorMetadata!: Record<string, string> | null;

  /** DepGate's own values: source, advisories, cves, epss, malware. */
  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;
}
