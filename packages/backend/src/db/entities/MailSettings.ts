import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** One row (`id = default`) holding the SMTP server used for invitations and password resets. */
@Entity('mail_settings')
export class MailSettings {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_mail_settings' })
  id!: string;

  @Column({ type: 'varchar', length: 255, default: '' })
  host!: string;

  @Column({ type: 'int', default: 587 })
  port!: number;

  /** True for implicit TLS (usually port 465). False uses STARTTLS when the server offers it. */
  @Column({ type: 'boolean', default: false })
  secure!: boolean;

  @Column({ name: 'smtp_user', type: 'varchar', length: 255, default: '' })
  user!: string;

  /** AES-256-GCM, never returned by the API. */
  @Column({ name: 'password_enc', type: 'text', default: '' })
  passwordEnc!: string;

  @Column({ name: 'from_address', type: 'varchar', length: 255, default: '' })
  fromAddress!: string;

  /** Where email links point, learned from a signed-in Security admin's browser. Empty until one signs in. */
  @Column({ name: 'public_url', type: 'varchar', length: 255, default: '' })
  publicUrl!: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
