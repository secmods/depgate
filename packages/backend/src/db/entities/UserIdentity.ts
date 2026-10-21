import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Ties a DepGate user to one account at one identity provider (requirements_sso.md R11). After the
 * first sign-in, a different account at that provider that carries the same email is refused.
 */
@Entity('user_identities')
@Index('uq_user_identities_provider_id_subject', ['providerId', 'subject'], { unique: true })
@Index('uq_user_identities_user_id_provider_id', ['userId', 'providerId'], { unique: true })
export class UserIdentity {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_user_identities' })
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'provider_id', type: 'uuid' })
  providerId!: string;

  /** OIDC `sub`. */
  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ name: 'email_at_link', type: 'varchar', length: 254 })
  emailAtLink!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;
}
