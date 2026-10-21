import { Component, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { FailedJob, JobRunRow, JobsService, QueueCounts, ScheduledJob, ScheduleRow } from '../../services/jobs.service';
import { EpssService, EpssStatus } from '../../services/epss.service';
import { ToastService } from '../../services/toast.service';
import { StatusPillComponent } from '../../shared/status-pill.component';

const JOB_LABELS: Record<ScheduledJob, string> = {
  'namespace-collision-check': 'Namespace collision check',
  'malicious-feed-sync': 'Malicious feed sync',
  'monitor-retention-purge': 'Monitoring and history retention',
  'epss-sync': 'EPSS scores sync',
  'event-retention-purge': 'Ledger and audit retention',
};

const QUEUE_LABELS: Record<string, string> = {
  webhooks: 'Webhook deliveries',
  scheduled: 'Scheduled jobs',
  email: 'Email',
  monitor: 'Monitoring rechecks',
};

/** Durations as people say them: "every 24 hours", "every 60 minutes", "every 3 days". */
export function everyLabel(ms: number | null): string {
  if (!ms) return 'Off';
  const minutes = ms / 60_000;
  if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = minutes / 60;
  if (hours < 48 || hours % 24 !== 0) return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
  return `Every ${hours / 24} days`;
}

/** One line for a run: what it did, e.g. "checked 12, found 1" or "skipped: setting is off". */
export function runSummary(run: JobRunRow): string {
  if (run.status === 'failed') return run.error ?? 'Failed';
  const result = run.result ?? {};
  if (typeof result['skipped'] === 'string') return result['skipped'] === 'off' ? 'Skipped: the setting is off' : `Skipped: ${result['skipped']}`;
  const parts = Object.entries(result)
    .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
    .map(([key, value]) => `${key} ${value}`);
  return parts.join(', ') || (run.status === 'running' ? 'Running…' : 'Done');
}

/** Settings → Jobs (Security only): queues, the cluster-wide schedules and their runs, failed jobs. */
@Component({
  selector: 'app-jobs-settings',
  standalone: true,
  imports: [DatePipe, DecimalPipe, RouterLink, StatusPillComponent],
  template: `
    <section class="dg-card mb-4">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Queues</h2>
          <span class="dg-card-hint">Background work shared by all DepGate replicas. Failed jobs are kept for 7 days.</span>
        </div>
        <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="load()"><span class="material-symbols-outlined">refresh</span> Refresh</button>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        @if (!available) {
          <div class="dg-callout is-warning mx-3 mb-3" data-testid="jobs-unavailable">
            <span class="material-symbols-outlined" aria-hidden="true">warning</span>
            <div>The job queue is unavailable. Downloads still work, and webhooks and email are sent directly.</div>
          </div>
        }
        <div class="dg-table-wrap">
          <table class="dg-table" data-testid="jobs-queues">
            <thead><tr><th>Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th></tr></thead>
            <tbody>
              @for (q of queues; track q.name) {
                <tr>
                  <td><span class="dg-cell-primary">{{ queueLabel(q.name) }}</span> <span class="dg-cell-sub font-mono">{{ q.name }}</span></td>
                  <td>{{ q.waiting }}</td>
                  <td>{{ q.active }}</td>
                  <td>{{ q.delayed }}</td>
                  <td [class.text-danger]="q.failed > 0">{{ q.failed }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <section class="dg-card mb-4">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Schedules</h2>
          <span class="dg-card-hint">Each job runs once per interval across the cluster.</span>
        </div>
        <a class="dg-btn dg-btn-ghost dg-btn-sm" routerLink="/audit/jobs" data-testid="jobs-history-link">
          <span class="material-symbols-outlined">history</span> Run history in Jobs &amp; Feeds
        </a>
      </div>
      <div class="dg-table-wrap">
        <table class="dg-table" data-testid="jobs-schedules">
          <thead><tr><th>Job</th><th>Interval</th><th>Next run</th><th>Last run</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody>
            @for (s of schedules; track s.job) {
              <tr [attr.data-testid]="'schedule-' + s.job">
                <td><span class="dg-cell-primary">{{ jobLabel(s.job) }}</span></td>
                <td>{{ every(s.everyMs) }}</td>
                <td class="text-xs">{{ s.nextRunAt ? (s.nextRunAt | date: 'MMM d, HH:mm') : '—' }}</td>
                <td>
                  @if (s.runs[0]; as last) {
                    <app-status-pill [value]="last.status" [label]="last.status" [tone]="tone(last.status)" />
                    <span class="dg-cell-sub">{{ last.startedAt | date: 'MMM d, HH:mm:ss' }} · {{ last.trigger }}</span>
                    <span class="dg-cell-sub" data-testid="schedule-last-summary">{{ summary(last) }}</span>
                  } @else {
                    <span class="dg-text-muted">Never</span>
                  }
                </td>
                <td class="col-actions">
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="runNow(s.job)" [disabled]="running === s.job || !available"
                    [attr.data-testid]="'run-now-' + s.job">Run now</button>
                </td>
              </tr>
              @if (s.job === 'epss-sync' && epss; as e) {
                <tr class="schedule-detail" data-testid="epss-details">
                  <td colspan="5">
                    @if (!e.enabled) {
                      <div class="schedule-detail-note" data-testid="epss-disabled">
                        <span class="material-symbols-outlined" aria-hidden="true">info</span>
                        EPSS is off (EPSS_ENABLED=false), so no vulnerability has an EPSS score.
                      </div>
                    } @else if (e.stale) {
                      <div class="schedule-detail-note is-warning" data-testid="epss-stale">
                        <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                        {{ e.scoreDate ? 'EPSS data is older than ' + e.staleAfterHours + ' hours.' : 'EPSS data has never been synced.' }}
                        Policies use the last good data.
                      </div>
                    }
                    <dl class="schedule-detail-facts">
                      <div><dt>Scores from</dt><dd data-testid="epss-score-date">{{ e.scoreDate ? (e.scoreDate | date: 'MMM d, y') : 'Never synced' }}</dd></div>
                      <div><dt>CVEs</dt><dd data-testid="epss-rows">{{ e.rowCount != null ? (e.rowCount | number) : '—' }}</dd></div>
                      <div><dt>Model</dt><dd>{{ e.modelVersion ?? '—' }}</dd></div>
                      <div class="schedule-detail-source">
                        <dt>Source</dt>
                        <dd data-testid="epss-source">
                          @if (e.feedSource) {
                            <span class="font-mono epss-source">{{ e.feedSource }}</span>
                            @if (e.feedSource.includes('github')) { <span class="dg-chip dg-chip-warning">GitHub backup</span> }
                          } @else {
                            —
                          }
                        </dd>
                      </div>
                    </dl>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    </section>

    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Failed jobs</h2>
          <span class="dg-card-hint">Last 7 days, up to 500 per queue.</span>
        </div>
      </div>
      @if (failed.length === 0) {
        <p class="dg-form-help px-3 pb-3" data-testid="jobs-no-failed">No failed jobs.</p>
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table" data-testid="jobs-failed">
            <thead><tr><th>Failed</th><th>Queue / job</th><th>Attempts</th><th>Error</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (f of failed; track f.queue + f.id) {
                <tr>
                  <td class="text-xs">{{ f.failedAt | date: 'MMM d, HH:mm:ss' }}</td>
                  <td><span class="dg-cell-primary">{{ f.job }}</span> <span class="dg-cell-sub font-mono">{{ f.queue }} · {{ f.id }}</span></td>
                  <td>{{ f.attempts }} / {{ f.maxAttempts }}</td>
                  <td><span class="dg-cell-truncate text-xs" style="max-width: 320px" [title]="f.error">{{ f.error }}</span></td>
                  <td class="col-actions">
                    <div class="dg-row-actions">
                      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="retry(f)" data-testid="failed-retry">Retry</button>
                      <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="discard(f)" data-testid="failed-discard">Discard</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .dg-table tr:has(+ .schedule-detail) td { border-bottom: none; }
    .schedule-detail td { padding-top: 0; }
    .schedule-detail-note { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 0.75rem; color: var(--color-muted); }
    .schedule-detail-note.is-warning { color: var(--warning-fg); }
    .schedule-detail-note .material-symbols-outlined { font-size: 16px; }
    .schedule-detail-facts { display: flex; flex-wrap: wrap; gap: 4px 24px; margin: 0; font-size: 0.75rem; }
    .schedule-detail-facts > div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
    .schedule-detail-facts dt { font-weight: 500; color: var(--color-muted); }
    .schedule-detail-facts dd { margin: 0; display: flex; align-items: center; gap: 6px; min-width: 0; }
    .schedule-detail-source { flex: 1 1 320px; }
    .epss-source { word-break: break-all; }
  `],
})
export class JobsSettingsComponent implements OnInit {
  private jobs = inject(JobsService);
  private epssService = inject(EpssService);
  private toast = inject(ToastService);

  loading = true;
  available = true;
  queues: QueueCounts[] = [];
  schedules: ScheduleRow[] = [];
  failed: FailedJob[] = [];
  running: ScheduledJob | null = null;
  epss: EpssStatus | null = null;

  ngOnInit(): void {
    this.load();
  }

  jobLabel(job: ScheduledJob): string {
    return JOB_LABELS[job] ?? job;
  }

  queueLabel(name: string): string {
    return QUEUE_LABELS[name] ?? name;
  }

  every(ms: number | null): string {
    return everyLabel(ms);
  }

  summary(run: JobRunRow): string {
    return runSummary(run);
  }

  tone(status: JobRunRow['status']): 'success' | 'danger' | 'info' | 'neutral' {
    return status === 'succeeded' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'info' : 'neutral';
  }

  load(): void {
    this.loading = true;
    this.jobs.overview().subscribe({
      next: (res) => {
        this.available = res.available;
        this.queues = res.queues;
        this.schedules = res.schedules;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Could not load jobs');
      },
    });
    this.jobs.failed().subscribe({ next: (res) => (this.failed = res.items), error: () => (this.failed = []) });
    this.epssService.status().subscribe({ next: (status) => (this.epss = status), error: () => (this.epss = null) });
  }

  runNow(job: ScheduledJob): void {
    this.running = job;
    this.jobs.runNow(job).subscribe({
      next: () => {
        this.running = null;
        this.toast.success(`${this.jobLabel(job)} queued`);
        setTimeout(() => this.load(), 1500);
      },
      error: (err) => {
        this.running = null;
        this.toast.error(err.status === 409 ? `${this.jobLabel(job)} is already running` : (err.error?.error ?? 'Could not run the job'));
      },
    });
  }

  retry(job: FailedJob): void {
    this.jobs.retry(job.queue, job.id).subscribe({
      next: () => {
        this.toast.success('Job retried');
        setTimeout(() => this.load(), 800);
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not retry'),
    });
  }

  discard(job: FailedJob): void {
    this.jobs.discard(job.queue, job.id).subscribe({
      next: () => {
        this.failed = this.failed.filter((f) => !(f.queue === job.queue && f.id === job.id));
        this.toast.success('Failed job discarded');
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not discard'),
    });
  }
}
