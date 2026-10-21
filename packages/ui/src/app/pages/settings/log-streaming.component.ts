import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router } from '@angular/router';
import { DestinationList, EventsService, StreamDestination } from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { DESTINATION_TYPES } from './stream-destination-form.component';
import type { Tone } from '../../shared/status';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  retrying: { label: 'Retrying', tone: 'warning' },
  auth_failed: { label: 'Auth failed', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' },
  idle: { label: 'Waiting for events', tone: 'info' },
};

/** Settings → Log streaming (requirements_event_streaming.md §10.3): where DepGate sends its events. */
@Component({
  selector: 'app-log-streaming',
  standalone: true,
  imports: [DatePipe, DecimalPipe, EmptyStateComponent, StatusPillComponent],
  styles: [`
    .type { display: inline-flex; align-items: center; gap: 8px; }
    .type-mark { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; flex-shrink: 0;
      background: var(--brand-soft-strong); color: var(--brand-text); font-weight: 700; font-size: 0.6875rem; font-family: var(--font-mono); }
    .num { font-variant-numeric: tabular-nums; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (list?.highVolume?.types?.length) {
      <div class="dg-callout is-warning mb-3" data-testid="streaming-volume-banner">
        <span class="material-symbols-outlined" aria-hidden="true">speed</span>
        <div>
          {{ highVolumeNames() }} events are streamed. At your current traffic that is about
          <strong>{{ list!.highVolume.estimatePerDay | number }}</strong> events a day.
        </div>
      </div>
    }
    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Log streaming</h2>
          <span class="dg-card-hint">Stream the events you choose, including allowed downloads, to Splunk, Datadog, Elastic, Sumo Logic, Syslog or your own collector.</span>
        </div>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else if (!list || list.items.length === 0) {
        <app-empty-state icon="conversion_path" title="No destinations yet" description="Stream policy blocks, malware alerts, admin changes and job failures to your SIEM. Use Add destination above." />
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table" data-testid="destinations-table">
            <thead>
              <tr>
                <th>Destination</th><th>Status</th><th>Events</th><th>Sent (24 h)</th><th>Dropped (24 h)</th><th>Lag</th><th>Last success</th>
                <th class="col-actions"><span class="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (row of list.items; track row.id) {
                <tr [attr.data-testid]="'destination-' + row.id">
                  <td>
                    <span class="type">
                      <span class="type-mark" aria-hidden="true">{{ mark(row) }}</span>
                      <span><span class="dg-cell-primary">{{ row.name }}</span><span class="dg-cell-sub">{{ typeLabel(row) }}</span></span>
                    </span>
                  </td>
                  <td>
                    <app-status-pill [value]="status(row)" [label]="statusInfo(row).label" [tone]="statusInfo(row).tone" />
                    @if (row.health?.lastError && row.health?.status !== 'healthy') {
                      <span class="dg-cell-sub text-danger dg-cell-truncate" style="max-width: 260px" [title]="row.health!.lastError!">{{ row.health!.lastError }}</span>
                    }
                    @if (row.health?.pausedUntil) { <span class="dg-cell-sub">Retrying at {{ row.health!.pausedUntil | date: 'HH:mm' }}</span> }
                  </td>
                  <td class="num">{{ selectionLabel(row) }}</td>
                  <td class="num">{{ (row.health?.sent24h ?? 0) | number }}</td>
                  <td class="num" [class.text-danger]="dropped(row) > 0">
                    {{ dropped(row) | number }}
                    @if (row.health?.lastLoss; as loss) {
                      <span class="dg-cell-sub">{{ loss.count | number }} lost on {{ loss.at | date: 'MMM d, HH:mm' }}</span>
                    }
                  </td>
                  <td class="num">{{ lagLabel(row) }}</td>
                  <td>{{ row.health?.lastSuccessAt ? (row.health!.lastSuccessAt | date: 'MMM d, HH:mm:ss') : '—' }}</td>
                  <td class="col-actions">
                    <div class="dg-row-actions">
                      <button type="button" class="dg-icon-btn" (click)="test(row)" [disabled]="testingId === row.id" title="Send test event" aria-label="Send test event">
                        @if (testingId === row.id) { <span class="dg-spinner is-sm"></span> } @else { <span class="material-symbols-outlined">send</span> }
                      </button>
                      <button type="button" class="dg-icon-btn" (click)="openEdit(row)" title="Edit" aria-label="Edit" [attr.data-testid]="'edit-destination-' + row.id">
                        <span class="material-symbols-outlined">edit</span>
                      </button>
                      <button type="button" class="dg-icon-btn is-danger" (click)="remove(row)" title="Delete" aria-label="Delete">
                        <span class="material-symbols-outlined">delete</span>
                      </button>
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
})
export class LogStreamingComponent implements OnInit {
  list: DestinationList | null = null;
  loading = false;
  testingId: string | null = null;
  private totalEvents = 0;

  private events = inject(EventsService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private router = inject(Router);

  ngOnInit(): void {
    this.load();
    this.events.catalog().subscribe({
      next: (catalog) => (this.totalEvents = catalog.features.reduce((n, f) => n + f.groups.reduce((m, g) => m + g.events.length, 0), 0)),
      error: () => undefined,
    });
  }

  load(): void {
    this.loading = !this.list;
    this.events.destinations().subscribe({
      next: (list) => {
        this.list = list;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Could not load the destinations');
      },
    });
  }

  mark(row: StreamDestination): string {
    return DESTINATION_TYPES.find((t) => t.type === row.type)?.mark ?? '?';
  }

  typeLabel(row: StreamDestination): string {
    const label = DESTINATION_TYPES.find((t) => t.type === row.type)?.label ?? row.type;
    if (row.type === 'syslog') return `${label} · ${row.settings['transport']?.toUpperCase() ?? ''} · ${row.settings['format']?.toUpperCase() ?? ''}`;
    if (row.type === 'http') return `${label} · ${row.settings['method'] || 'POST'} ${row.settings['url'] ?? ''}`;
    if (row.settings['url']) return `${label} · ${row.settings['url']}`;
    return label;
  }

  status(row: StreamDestination): string {
    if (!row.enabled) return 'disabled';
    if (row.type === 'jsonl') return 'healthy';
    return row.health?.status ?? 'idle';
  }

  statusInfo(row: StreamDestination): { label: string; tone: Tone } {
    return STATUS[this.status(row)] ?? STATUS['idle'];
  }

  selectionLabel(row: StreamDestination): string {
    const n = row.selection.events.length;
    const f = row.selection.features.length;
    if (f === 0 && n === 0) return 'None';
    const parts: string[] = [];
    if (f) parts.push(`${f} feature${f === 1 ? '' : 's'}`);
    if (n) parts.push(`${n} event${n === 1 ? '' : 's'}`);
    return parts.join(' + ');
  }

  dropped(row: StreamDestination): number {
    return Object.values(row.health?.dropped24h ?? {}).reduce((n, v) => n + v, 0);
  }

  lagLabel(row: StreamDestination): string {
    const s = row.health?.lagSeconds;
    if (s === null || s === undefined || row.type === 'jsonl') return '—';
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    return `${(s / 3600).toFixed(1)} h`;
  }

  highVolumeNames(): string {
    const names = (this.list?.highVolume.types ?? []).map((t) => (t === 'ALLOW' ? 'Allow' : 'Block · Monitor'));
    return names.join(' and ');
  }

  openAdd(): void {
    void this.router.navigate(['/settings/log-streaming/new']);
  }

  openEdit(row: StreamDestination): void {
    void this.router.navigate(['/settings/log-streaming', row.id, 'edit']);
  }

  test(row: StreamDestination): void {
    this.testingId = row.id;
    this.events.testSaved(row.id).subscribe({
      next: (result) => {
        this.testingId = null;
        if (result.ok) this.toast.success(`Test event delivered${result.status ? ` (HTTP ${result.status})` : ''}`);
        else this.toast.error(`Test event not delivered: ${result.error || result.reply || 'no answer'}`);
        this.load();
      },
      error: (err) => {
        this.testingId = null;
        this.toast.error(err.error?.error ?? 'The test could not be sent');
      },
    });
  }

  async remove(row: StreamDestination): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete destination',
      message: `Stop sending events to ${row.name} and delete it? Events not yet sent to it are dropped.`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    this.events.deleteDestination(row.id).subscribe({
      next: () => {
        this.toast.success('Destination deleted');
        this.load();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not delete the destination'),
    });
  }
}
