import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type PackageRepositoryType = 'remote' | 'virtual';

/** Where a remote's packages come from. Only internal remotes may serve reserved namespaces. */
export type RepositorySource = 'public' | 'internal';

@Entity('package_repositories')
@Index('uq_package_repositories_ecosystem_key', ['ecosystem', 'key'], { unique: true })
export class PackageRepository {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_package_repositories' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  ecosystem!: string;

  @Column({ type: 'varchar', length: 64 })
  key!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: PackageRepositoryType;

  @Column({ name: 'upstream_url', type: 'varchar', length: 2048, nullable: true })
  upstreamUrl!: string | null;

  /** Remotes only; virtual repositories ignore it. Unclassified remotes are public (fail closed). */
  @Column({ type: 'varchar', length: 16, default: 'public' })
  source!: RepositorySource;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  /**
   * Remotes only: where the remote stands in the `all` repository's search order (R2), lowest first.
   * Null until someone orders `all`; such remotes come last, by key, as before ordering existed.
   */
  @Column({ name: 'all_position', type: 'int', nullable: true })
  allPosition!: number | null;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled!: boolean;

  @Column({ name: 'is_reserved', type: 'boolean', default: false })
  isReserved!: boolean;

  @Column({ type: 'int', default: 30000 })
  timeoutMs!: number;

  @Column({ type: 'int', default: 3 })
  retryCount!: number;

  @Column({ name: 'auth_type', type: 'varchar', length: 32, nullable: true })
  authType!: string | null;

  @Column({ name: 'auth_encrypted', type: 'text', nullable: true })
  authEncrypted!: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  description!: string | null;

  @Column({ name: 'upstream_registry_id', type: 'uuid', nullable: true })
  upstreamRegistryId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
