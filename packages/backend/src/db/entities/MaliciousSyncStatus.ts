import { Column, Entity, PrimaryColumn } from 'typeorm';

export type MaliciousSyncRunStatus = 'idle' | 'running' | 'completed' | 'failed';
export type MaliciousSyncTrigger = 'manual' | 'scheduled';

/** One row (`id = default`) for the in-progress or latest malicious feed sync. */
@Entity('malicious_sync_status')
export class MaliciousSyncStatus {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_malicious_sync_status' })
  id!: string;

  @Column({ type: 'varchar', length: 16, default: 'idle' })
  status!: MaliciousSyncRunStatus;

  @Column({ type: 'varchar', length: 16, nullable: true })
  trigger!: MaliciousSyncTrigger | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phase!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  ecosystem!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  mode!: string | null;

  @Column({ type: 'int', nullable: true })
  added!: number | null;

  @Column({ type: 'int', nullable: true })
  removed!: number | null;

  @Column({ type: 'int', nullable: true })
  updated!: number | null;

  @Column({ type: 'int', nullable: true })
  total!: number | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'watermark_before', type: 'varchar', length: 40, nullable: true })
  watermarkBefore!: string | null;

  @Column({ name: 'watermark_after', type: 'varchar', length: 40, nullable: true })
  watermarkAfter!: string | null;
}
