import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { canonicalPackageName } from '../../services/package-name.js';

export type WaiverRequestStatus = 'pending' | 'approved' | 'rejected';

@Entity('waiver_requests')
@Index('idx_waiver_requests_requested_by_id_status', ['requestedById', 'status'])
@Index('idx_waiver_requests_status', ['status'])
@Index('idx_waiver_requests_ecosystem_package_name', ['ecosystem', 'packageName'])
export class WaiverRequest {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_waiver_requests' })
  id!: string;

  @Column({ name: 'package_name', type: 'varchar', length: 512 })
  packageName!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  /** Specific version, a range expression, or '*' for any version */
  @Column({ type: 'varchar', length: 128 })
  version!: string;

  /** Repositories the waiver is asked for. Empty: every repository. Copied to the exception on approval. */
  @Column({ name: 'repository_ids', type: 'jsonb', default: [] })
  repositoryIds!: string[];

  /** Expiry the requester asked for. Approval may use a different date. */
  @Column({ name: 'requested_expires_at', type: 'timestamptz' })
  requestedExpiresAt!: Date;

  /** Expiry the reviewer set. This is the date copied onto the exception. */
  @Column({ name: 'approved_expires_at', type: 'timestamptz', nullable: true })
  approvedExpiresAt!: Date | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: WaiverRequestStatus;

  @Column({ name: 'requested_by', type: 'varchar', length: 256 })
  requestedBy!: string;

  @Column({ name: 'requested_by_id', type: 'varchar', length: 256 })
  requestedById!: string;

  @Column({ name: 'reviewed_by', type: 'varchar', length: 256, nullable: true })
  reviewedBy!: string | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote!: string | null;

  @Column({ name: 'exception_id', type: 'uuid', nullable: true })
  exceptionId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  /** Lookups compare canonical names; `update()` and raw SQL skip this, so their callers canonicalize. */
  @BeforeInsert()
  @BeforeUpdate()
  canonicalizeName(): void {
    if (this.packageName != null && this.ecosystem != null) {
      this.packageName = canonicalPackageName(this.ecosystem, this.packageName);
    }
  }
}
