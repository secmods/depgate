import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('audit_logs')
@Index('idx_audit_logs_created_at', ['createdAt'])
@Index('idx_audit_logs_ecosystem_package_name', ['ecosystem', 'packageName'])
@Index('idx_audit_logs_decision', ['decision'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_audit_logs' })
  id!: string;

  @Column({ name: 'requester_ip', type: 'varchar', length: 64, nullable: true })
  requesterIp!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  requester!: string | null;

  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ name: 'package_name', type: 'varchar', length: 512 })
  packageName!: string;

  @Column({ name: 'resolved_version', type: 'varchar', length: 128, nullable: true })
  resolvedVersion!: string | null;

  /** Repository key the package request went through (`default`, `all`, or a custom key). Null for admin events. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  repository!: string | null;

  @Column({ type: 'varchar', length: 32 })
  decision!: string;

  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @Column({ name: 'policy_name', type: 'varchar', length: 256, nullable: true })
  policyName!: string | null;

  @Column({ name: 'condition_reasons', type: 'jsonb', nullable: true })
  conditionReasons!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, string> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
