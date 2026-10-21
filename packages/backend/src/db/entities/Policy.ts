import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type PolicyDecision = 'ALLOW' | 'BLOCK';

/** enforce applies the decision. monitor (Block policies only) blocks nothing and records what it would block. */
export type PolicyMode = 'enforce' | 'monitor';

@Entity('policies')
export class Policy {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_policies' })
  id!: string;

  @Column({ type: 'varchar', length: 256 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'varchar',
    length: 16,
    default: 'BLOCK',
  })
  decision!: PolicyDecision;

  @Column({ type: 'jsonb', default: {} })
  conditions!: Record<string, unknown>;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'enforce' })
  mode!: PolicyMode;

  /** When monitoring started, or when the policy was last switched to enforce. */
  @Column({ name: 'mode_changed_at', type: 'timestamptz', nullable: true })
  modeChangedAt!: Date | null;

  /** Repositories the policy applies to. Empty: every repository. */
  @Column({ name: 'repository_ids', type: 'jsonb', default: [] })
  repositoryIds!: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
