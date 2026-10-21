import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** The Audit Log (requirements_event_streaming.md §5.1): who changed what. */
@Entity('audit_events')
@Index('idx_audit_events_created', ['createdAt'])
@Index('idx_audit_events_type', ['type', 'createdAt'])
@Index('idx_audit_events_target', ['targetKind', 'targetId'])
@Index('idx_audit_events_actor', ['actorName', 'createdAt'])
export class AuditEvent {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_audit_events' })
  id!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'varchar', length: 48 })
  type!: string;

  @Column({ name: 'actor_kind', type: 'varchar', length: 16 })
  actorKind!: string;

  @Column({ name: 'actor_id', type: 'varchar', length: 64, nullable: true })
  actorId!: string | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 256, nullable: true })
  actorName!: string | null;

  @Column({ name: 'actor_ip', type: 'varchar', length: 64, nullable: true })
  actorIp!: string | null;

  @Column({ name: 'actor_user_agent', type: 'text', nullable: true })
  actorUserAgent!: string | null;

  @Column({ name: 'actor_auth_method', type: 'varchar', length: 16, nullable: true })
  actorAuthMethod!: string | null;

  @Column({ name: 'actor_metadata', type: 'jsonb', nullable: true })
  actorMetadata!: Record<string, string> | null;

  @Column({ name: 'target_kind', type: 'varchar', length: 32, nullable: true })
  targetKind!: string | null;

  @Column({ name: 'target_id', type: 'varchar', length: 128, nullable: true })
  targetId!: string | null;

  @Column({ name: 'target_name', type: 'varchar', length: 512, nullable: true })
  targetName!: string | null;

  @Column({ name: 'target_ecosystem', type: 'varchar', length: 32, nullable: true })
  targetEcosystem!: string | null;

  @Column({ name: 'target_version', type: 'varchar', length: 128, nullable: true })
  targetVersion!: string | null;

  @Column({ name: 'target_repository', type: 'varchar', length: 128, nullable: true })
  targetRepository!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  summary!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  reasons!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;
}
