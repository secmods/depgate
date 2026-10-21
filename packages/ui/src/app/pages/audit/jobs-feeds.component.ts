import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { EventsService, JobRunEvent } from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { PageChange, savedPageSize } from '../../shared/pagination.component';
import { EventColumn, EventTableComponent } from '../../shared/event-table.component';
import { TimeRange, TimeRangeComponent, rangeBounds } from '../../shared/time-range.component';
import { durationLabel, jobLabel } from '../../shared/event-labels';
import { runSummary } from '../settings/jobs-settings.component';

/** Jobs & Feeds (requirements_event_streaming.md §10.2, D3): what the background jobs did. Feed status is in Settings → Jobs. */
@Component({
  selector: 'app-jobs-feeds',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, StatusPillComponent, EventTableComponent, TimeRangeComponent],
  styles: [`
    .detail-grid dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 0.8125rem; }
    .detail-grid dt { color: var(--color-muted); font-weight: 500; }
    .detail-grid dd { margin: 0; word-break: break-word; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Jobs &amp; feeds</h1>
          <p class="dg-page-subtitle">Runs of background jobs such as feed syncs and retention purges. Schedules and queue health are in <a routerLink="/settings" [queryParams]="{ tab: 'jobs' }">Settings → Jobs</a>.</p>
        </div>
        <div class="dg-page-actions">
          <button type="button" class="dg-icon-btn" (click)="load()" [disabled]="loading" title="Refresh" aria-label="Refresh">
            <span class="material-symbols-outlined">refresh</span>
          </button>
        </div>
      </header>

      <section class="dg-card">
        <div class="dg-toolbar">
          <app-time-range [range]="range" (rangeChange)="range = $event; applyFilters()" />
          <label class="dg-filter">
            <span>Job</span>
            <select class="dg-select" [(ngModel)]="job" (ngModelChange)="applyFilters()" data-testid="jobs-job-filter">
              <option value="">All</option>
              @for (j of jobs; track j) { <option [value]="j">{{ jobLabel(j) }}</option> }
            </select>
          </label>
          <label class="dg-filter">
            <span>Status</span>
            <select class="dg-select" [(ngModel)]="status" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
              <option value="running">Running</option>
            </select>
          </label>
          <label class="dg-filter">
            <span>Trigger</span>
            <select class="dg-select" [(ngModel)]="trigger" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              <option value="scheduled">Scheduled</option>
              <option value="manual">Run now</option>
              <option value="startup">Startup</option>
            </select>
          </label>
          @if (job || status || trigger || range.preset !== '7d') {
            <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="clearFilters()">Clear filters</button>
          }
        </div>

        <app-event-table [columns]="columns" [rows]="items" [loading]="loading" [offset]="offset" [limit]="limit" [total]="total"
          storageKey="job-runs" emptyIcon="schedule" emptyDescription="Runs of scheduled jobs appear here." testId="jobs-table"
          (pageChange)="onPage($event)">
          <ng-template #cell let-row let-column="column">
            @switch (column) {
              @case ('time') { {{ row.startedAt | date: 'MMM d, y' }} <span class="dg-cell-sub">{{ row.startedAt | date: 'HH:mm:ss' }}</span> }
              @case ('job') { <span class="dg-cell-primary">{{ jobLabel(row.job) }}</span> <span class="dg-cell-sub font-mono">{{ row.job }}</span> }
              @case ('trigger') { {{ triggerLabel(row.trigger) }} }
              @case ('status') { <app-status-pill [value]="row.status" /> }
              @case ('duration') { {{ durationLabel(row.durationMs) }} }
              @case ('summary') { <span class="dg-cell-truncate" style="max-width: 360px" [class.text-danger]="row.status === 'failed'" [title]="summary(row)">{{ summary(row) }}</span> }
            }
          </ng-template>
          <ng-template #detail let-row>
            <div class="detail-grid">
              <dl>
                <dt>Run ID</dt><dd class="font-mono text-xs">{{ row.id }}</dd>
                @if (row.jobId) { <dt>Queue job ID</dt><dd class="font-mono text-xs">{{ row.jobId }}</dd> }
                <dt>Finished</dt><dd>{{ row.finishedAt ? (row.finishedAt | date: 'medium') : 'Still running' }}</dd>
                @if (row.error) { <dt>Error</dt><dd class="text-danger">{{ row.error }}</dd> }
                @for (entry of resultEntries(row); track entry[0]) { <dt>{{ entry[0] }}</dt><dd class="font-mono text-xs">{{ entry[1] }}</dd> }
              </dl>
            </div>
          </ng-template>
        </app-event-table>
      </section>
    </div>
  `,
})
export class JobsFeedsComponent implements OnInit {
  readonly columns: EventColumn[] = [
    { key: 'time', label: 'Time', cellClass: 'col-nowrap' },
    { key: 'job', label: 'Job' },
    { key: 'trigger', label: 'Trigger' },
    { key: 'status', label: 'Status' },
    { key: 'duration', label: 'Duration', cellClass: 'col-nowrap' },
    { key: 'summary', label: 'Summary' },
  ];
  readonly jobLabel = jobLabel;
  readonly durationLabel = durationLabel;
  items: JobRunEvent[] = [];
  jobs: string[] = [];
  job = '';
  status = '';
  trigger = '';
  range: TimeRange = { preset: '7d', fromDay: '', toDay: '' };
  limit = savedPageSize('job-runs', 50);
  offset = 0;
  total = 0;
  loading = false;

  private events = inject(EventsService);
  private toast = inject(ToastService);

  ngOnInit(): void {
    this.load();
  }

  triggerLabel(trigger: string): string {
    return trigger === 'manual' ? 'Run now' : trigger === 'startup' ? 'Startup' : 'Scheduled';
  }

  summary(row: JobRunEvent): string {
    return runSummary({ id: row.id, trigger: row.trigger, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, result: row.result, error: row.error });
  }

  resultEntries(row: JobRunEvent): Array<[string, string]> {
    return Object.entries(row.result ?? {}).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]);
  }

  applyFilters(): void {
    this.offset = 0;
    this.load();
  }

  clearFilters(): void {
    this.job = this.status = this.trigger = '';
    this.range = { preset: '7d', fromDay: '', toDay: '' };
    this.applyFilters();
  }

  load(): void {
    this.loading = true;
    this.events.jobRuns({ job: this.job, status: this.status, trigger: this.trigger, ...rangeBounds(this.range), limit: this.limit, offset: this.offset }).subscribe({
      next: (res) => {
        this.items = res.items;
        this.total = res.total;
        this.jobs = res.jobs;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load job runs');
      },
    });
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }
}
