import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type AuthTokenPurpose = 'invite' | 'reset';

/** A single-use link sent by email. Only the SHA-256 of the token is stored. */
@Entity('auth_tokens')
@Index('uq_auth_tokens_token_hash', ['tokenHash'], { unique: true })
@Index('idx_auth_tokens_user_id', ['userId'])
export class AuthToken {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_auth_tokens' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 16 })
  purpose!: AuthTokenPurpose;

  @Column({ name: 'token_hash', type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
