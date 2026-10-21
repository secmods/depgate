import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  JoinColumn,
  ManyToOne,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { Policy } from './Policy.js';
import { canonicalPackageName } from '../../services/package-name.js';

@Entity('exceptions')
@Index('idx_exceptions_ecosystem_package_name_version', ['ecosystem', 'packageName', 'version'])
@Index('idx_exceptions_expires_at', ['expiresAt'])
@Index('idx_exceptions_policy_id', ['policyId'])
export class Exception {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_exceptions' })
  id!: string;

  @Column({ name: 'package_name', type: 'varchar', length: 512 })
  packageName!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  /**
   * null: the exception covers every policy. Set: it only stops that policy from matching
   * (an approval from the Monitoring page). The malicious packages list ignores scoped exceptions.
   */
  @Column({ name: 'policy_id', type: 'uuid', nullable: true })
  policyId!: string | null;

  @ManyToOne(() => Policy, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'policy_id', foreignKeyConstraintName: 'fk_exceptions_policy_id' })
  policy?: Policy | null;

  /** Repositories the exception applies to. Empty: every repository. */
  @Column({ name: 'repository_ids', type: 'jsonb', default: [] })
  repositoryIds!: string[];

  /** Specific version or '*' for any version */
  @Column({ type: 'varchar', length: 128 })
  version!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'approved_by', type: 'varchar', length: 256 })
  approvedBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  /** Lookups compare canonical names; `update()` and raw SQL skip this, so their callers canonicalize. */
  @BeforeInsert()
  @BeforeUpdate()
  canonicalizeName(): void {
    if (this.packageName != null && this.ecosystem != null) {
      this.packageName = canonicalPackageName(this.ecosystem, this.packageName);
    }
  }
}
