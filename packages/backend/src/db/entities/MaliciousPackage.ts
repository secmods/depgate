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

export type MaliciousOverrideStatus = 'BLOCK' | 'ALLOW';

export type MaliciousSource = 'default' | 'custom';

@Entity('malicious_packages')
@Index('uq_malicious_packages_name_ecosystem', ['name', 'ecosystem'], { unique: true })
@Index('idx_malicious_packages_lookup', ['ecosystem', 'lookupName'])
export class MaliciousPackage {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_malicious_packages' })
  id!: string;

  @Column({ type: 'varchar', length: 512 })
  name!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  /** `name` as canonicalPackageName spells it; lookups match on this, not on `name`. */
  @Column({ name: 'lookup_name', type: 'varchar', length: 512, nullable: true })
  lookupName!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ name: 'source_url', type: 'text', nullable: true })
  sourceUrl!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'default' })
  source!: MaliciousSource;

  @Column({ name: 'version_range', type: 'varchar', length: 128, nullable: true })
  versionRange!: string | null;

  @Column({
    name: 'override_status',
    type: 'varchar',
    length: 16,
    default: 'BLOCK',
  })
  overrideStatus!: MaliciousOverrideStatus;

  @Column({ name: 'override_reason', type: 'text', nullable: true })
  overrideReason!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @BeforeInsert()
  @BeforeUpdate()
  setLookupName(): void {
    if (this.name != null && this.ecosystem != null) this.lookupName = canonicalPackageName(this.ecosystem, this.name);
  }
}
