import { Column, Entity, PrimaryColumn } from 'typeorm';

/** One row (`id = default`) for repository security controls. */
@Entity('gateway_settings')
export class GatewaySettings {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_gateway_settings' })
  id!: string;

  @Column({ name: 'session_token_days', type: 'int', default: 30 })
  sessionTokenDays!: number;

  /** Daily check whether reserved internal names exist on public registries. Off: it sends those names out. */
  @Column({ name: 'namespace_collision_check', type: 'boolean', default: false })
  namespaceCollisionCheck!: boolean;

  /** Artifact cache switched on or off in Settings. Null follows ARTIFACT_CACHE_ENABLED. */
  @Column({ name: 'artifact_cache_enabled', type: 'boolean', nullable: true, default: null })
  artifactCacheEnabled!: boolean | null;

  /** Artifact cache limits set in Settings (maxSizeGb, maxFiles, maxAgeDays, maxIdleDays, maxFileMb). A missing field follows the environment. */
  @Column({ name: 'artifact_cache_limits', type: 'jsonb', nullable: true, default: null })
  artifactCacheLimits!: Record<string, number> | null;
}
