import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type UserRole = 'User' | 'Security';
export type UserSource = 'local' | 'sso';
export type LoginMethod = 'password' | 'oidc' | 'saml';

@Entity('users')
@Index('uq_users_email', ['email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_users' })
  id!: string;

  /** Sign-in identity. Stored trimmed and lower-cased. */
  @Column({ type: 'varchar', length: 254 })
  email!: string;

  /** Null until the person accepts their invitation and sets a password. */
  @Column({ name: 'password_hash', type: 'varchar', length: 128, nullable: true })
  passwordHash!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'User' })
  role!: UserRole;

  /** `sso` when single sign-on created the account for someone not listed (requirements_sso.md R11). */
  @Column({ type: 'varchar', length: 16, default: 'local' })
  source!: UserSource;

  /** Set while the account may not sign in by any method; its sessions stop working (R15). */
  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;

  /**
   * Every session token carries the version it was issued under. Raising it ends all of them:
   * disable, role change, password reset and "Sign out everywhere" (requirements_sso.md S3).
   */
  @Column({ name: 'session_version', type: 'int', default: 0 })
  sessionVersion!: number;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: 'last_login_method', type: 'varchar', length: 16, nullable: true })
  lastLoginMethod!: LoginMethod | null;

  @Column({ name: 'last_login_provider_id', type: 'uuid', nullable: true })
  lastLoginProviderId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
