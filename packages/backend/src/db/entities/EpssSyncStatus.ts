import { Column, Entity, PrimaryColumn } from 'typeorm';

export type EpssSyncState = 'idle' | 'running' | 'completed' | 'failed';
export type EpssSyncTrigger = 'manual' | 'scheduled' | 'startup';

/** One row (`id = default`) for the in-progress or latest EPSS sync, and the data it loaded. */
@Entity('epss_sync_status')
export class EpssSyncStatus {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'pk_epss_sync_status' })
  id!: string;

  @Column({ type: 'varchar', length: 16, default: 'idle' })
  state!: EpssSyncState;

  @Column({ type: 'varchar', length: 16, nullable: true })
  trigger!: EpssSyncTrigger | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  /** score_date of the data in epss_scores (the last good file), not of a rejected one. */
  @Column({ name: 'score_date', type: 'varchar', length: 32, nullable: true })
  scoreDate!: string | null;

  @Column({ name: 'model_version', type: 'varchar', length: 64, nullable: true })
  modelVersion!: string | null;

  @Column({ name: 'row_count', type: 'int', nullable: true })
  rowCount!: number | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /** Where the stored file came from: the feed URL, or the GitHub backup. */
  @Column({ name: 'feed_source', type: 'varchar', length: 512, nullable: true })
  feedSource!: string | null;
}
