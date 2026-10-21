import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type JobRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

/** One run of a scheduled job, for Settings → Jobs and the "run now" result. Kept 90 days. */
@Entity('job_runs')
@Index('idx_job_runs_job_started_at', ['job', 'startedAt'])
export class JobRun {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_job_runs' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  job!: string;

  /** BullMQ job ID, so a "run now" can be looked up by the ID it returned. */
  @Column({ name: 'job_id', type: 'varchar', length: 128, nullable: true })
  jobId!: string | null;

  @Column({ type: 'varchar', length: 16 })
  trigger!: 'scheduled' | 'manual' | 'startup';

  @Column({ type: 'varchar', length: 16 })
  status!: JobRunStatus;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error!: string | null;
}
