import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One row (`id = default`): who may sign in with single sign-on (requirements_sso.md §5.2, R11). */
@Entity('auth_settings')
export class AuthSettings {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_auth_settings' })
  id!: string;

  /** Lower-case domain names. Every single sign-on must use one of them. */
  @Column({ name: 'allowed_domains', type: 'jsonb', default: () => `'[]'` })
  allowedDomains!: string[];

  /** On: a person with an allowed domain and no DepGate account is added as User on first sign-in. */
  @Column({ name: 'allow_unlisted_sso', type: 'boolean', default: true })
  allowUnlistedSso!: boolean;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
