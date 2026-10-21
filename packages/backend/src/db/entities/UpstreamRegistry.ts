import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('upstream_registries')
@Index('idx_upstream_registries_ecosystem_priority', ['ecosystem', 'priority'])
export class UpstreamRegistry {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_upstream_registries' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ type: 'varchar', length: 2048 })
  url!: string;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled!: boolean;

  @Column({ type: 'int', default: 30000 })
  timeoutMs!: number;

  @Column({ type: 'int', default: 3 })
  retryCount!: number;

  @Column({ name: 'auth_type', type: 'varchar', length: 32, nullable: true })
  authType!: string | null;

  @Column({ name: 'auth_encrypted', type: 'text', nullable: true })
  authEncrypted!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
