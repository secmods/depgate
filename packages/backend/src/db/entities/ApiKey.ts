import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('api_keys')
@Index('uq_api_keys_key_hash', ['keyHash'], { unique: true })
export class ApiKey {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_api_keys' })
  id!: string;

  @Column({ name: 'key_hash', type: 'varchar', length: 64 })
  keyHash!: string;

  @Column({ type: 'varchar', length: 256 })
  name!: string;

  @Column({ type: 'varchar', length: 32, default: 'ServiceAccount' })
  role!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  namespace!: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'request_count', type: 'bigint', default: 0 })
  requestCount!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
