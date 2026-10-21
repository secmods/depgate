import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Policy } from './Policy.js';

/** A reserved internal name that also exists on the ecosystem's public registry. */
@Entity('namespace_collisions')
@Index('uq_namespace_collisions_policy_id_ecosystem_name', ['policyId', 'ecosystem', 'name'], { unique: true })
export class NamespaceCollision {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_namespace_collisions' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ type: 'varchar', length: 512 })
  name!: string;

  @Column({ name: 'policy_id', type: 'uuid' })
  policyId!: string;

  @ManyToOne(() => Policy, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'policy_id', foreignKeyConstraintName: 'fk_namespace_collisions_policy_id' })
  policy?: Policy;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ name: 'last_checked_at', type: 'timestamptz' })
  lastCheckedAt!: Date;

  /** Newest version the public registry lists, when it says. */
  @Column({ name: 'public_latest_version', type: 'varchar', length: 256, nullable: true })
  publicLatestVersion!: string | null;
}
