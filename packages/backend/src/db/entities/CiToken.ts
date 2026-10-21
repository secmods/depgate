import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('ci_tokens')
@Index('idx_ci_tokens_expires_at', ['expiresAt'])
export class CiToken {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_ci_tokens' })
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, string>;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'created_by', type: 'varchar', length: 256 })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
