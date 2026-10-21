import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuditRow, CatalogEvent, CatalogFeature, EventsService } from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { SearchInputComponent } from '../../shared/search-input.component';
import { PageChange, savedPageSize } from '../../shared/pagination.component';
import { EventColumn, EventTableComponent } from '../../shared/event-table.component';
import { TimeRange, TimeRangeComponent, rangeBounds } from '../../shared/time-range.component';
import { EventBannersComponent } from '../../shared/event-banners.component';
import { TARGET_ICONS, TARGET_KINDS, metadataLine } from '../../shared/event-labels';
import { downloadCsv, fetchAllPages, timestampedName } from '../../shared/csv';

/** Audit Log (requirements_event_streaming.md §10.2): who changed what, filtered by the same features Log Streaming uses. */
@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [DatePipe, JsonPipe, FormsModule, SearchInputComponent, EventTableComponent, TimeRangeComponent, EventBannersComponent],
  styles: [`
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px 32px; }
    .detail-grid dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 0.8125rem; }
    .detail-grid dt { color: var(--color-muted); font-weight: 500; }
    .detail-grid dd { margin: 0; color: var(--color-on-surface); word-break: break-word; }
    .reasons { margin: 0; padding-left: 18px; font-size: 0.8125rem; display: flex; flex-direction: column; gap: 4px; }
    .target { display: inline-flex; align-items: center; gap: 6px; }
    .target .material-symbols-outlined { font-size: 16px; color: var(--color-muted); }
    .details-json { margin: 0; font-size: 0.75rem; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Audit log</h1>
          <p class="dg-page-subtitle">Who changed what, plus sign-ins and package checks.</p>
        </div>
        <div class="dg-page-actions">
          <button type="button" class="dg-btn dg-btn-secondary" (click)="exportCsv()" [disabled]="exporting || total === 0">
            @if (exporting) { <span class="dg-spinner is-sm" aria-hidden="true"></span> } @else { <span class="material-symbols-outlined">download</span> }
            Export CSV
          </button>
          <button type="button" class="dg-icon-btn" (click)="load()" [disabled]="loading" title="Refresh" aria-label="Refresh">
            <span class="material-symbols-outlined">refresh</span>
          </button>
        </div>
      </header>

      <app-event-banners kind="audit" />

      <section class="dg-card">
        <div class="dg-toolbar">
          <app-time-range [range]="range" (rangeChange)="range = $event; applyFilters()" />
          <label class="dg-filter">
            <span>Feature</span>
            <select class="dg-select" [(ngModel)]="feature" (ngModelChange)="type = ''; applyFilters()" data-testid="audit-feature-filter">
              <option value="">All</option>
              @for (f of features; track f.feature) { <option [value]="f.feature">{{ f.label }}</option> }
            </select>
          </label>
          <label class="dg-filter">
            <span>Action</span>
            <select class="dg-select" [(ngModel)]="type" (ngModelChange)="applyFilters()" data-testid="audit-action-filter">
              <option value="">All</option>
              @for (e of actions; track e.key) { <option [value]="e.type">{{ e.label }}</option> }
            </select>
          </label>
          <label class="dg-filter">
            <span>Target</span>
            <select class="dg-select" [(ngModel)]="targetKind" (ngModelChange)="applyFilters()">
              <option value="">Any kind</option>
              @for (k of targetKinds; track k.value) { <option [value]="k.value">{{ k.label }}</option> }
            </select>
          </label>
          <app-search-input placeholder="Target name" style="flex-basis: 160px; max-width: 200px" [(value)]="target" (search)="applyFilters()" />
          <app-search-input placeholder="Actor or IP" style="flex-basis: 160px; max-width: 200px" [(value)]="actor" (search)="applyFilters()" />
          @if (hasFilters) {
            <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="clearFilters()">Clear filters</button>
          }
        </div>

        <app-event-table [columns]="columns" [rows]="items" [loading]="loading" [offset]="offset" [limit]="limit" [total]="total"
          storageKey="audit-log" emptyIcon="manage_history" emptyDescription="Changes made by people, API keys and CI tokens appear here." testId="audit-log-table"
          (pageChange)="onPage($event)">
          <ng-template #cell let-row let-column="column">
            @switch (column) {
              @case ('time') { {{ row.createdAt | date: 'MMM d, y' }} <span class="dg-cell-sub">{{ row.createdAt | date: 'HH:mm:ss' }}</span> }
              @case ('actor') {
                <span class="col-nowrap">{{ row.actor.name || (row.actor.kind === 'system' ? 'DepGate' : '—') }}</span>
                @if (row.actor.ip) { <span class="dg-cell-sub font-mono">{{ row.actor.ip }}</span> }
              }
              @case ('action') {
                <span class="dg-cell-primary">{{ actionLabel(row) }}</span>
                <span class="dg-cell-sub font-mono">{{ row.type }}</span>
              }
              @case ('target') {
                @if (row.target.name || row.target.kind) {
                  <span class="target" [title]="row.target.kind || ''">
                    <span class="material-symbols-outlined" aria-hidden="true">{{ targetIcon(row.target.kind) }}</span>
                    <span class="dg-cell-truncate" style="max-width: 220px">{{ row.target.name || row.target.kind }}</span>
                    @if (row.target.version) { <span class="dg-tag">{{ row.target.version }}</span> }
                  </span>
                } @else { — }
              }
              @case ('summary') { <span class="dg-cell-truncate" style="max-width: 360px" [title]="row.summary || ''">{{ row.summary || '—' }}</span> }
            }
          </ng-template>
          <ng-template #detail let-row>
            <div class="detail-grid">
              <div>
                <p class="dg-section-label">Reasons</p>
                @if (row.reasons.length) {
                  <ul class="reasons">@for (r of row.reasons; track $index) { <li>{{ r }}</li> }</ul>
                } @else {
                  <span class="dg-empty">None recorded</span>
                }
                @if (hasDetails(row)) {
                  <p class="dg-section-label mt-3">Details</p>
                  <pre class="dg-code details-json">{{ row.details | json }}</pre>
                }
              </div>
              <div>
                <p class="dg-section-label">Actor</p>
                <dl>
                  <dt>Event ID</dt><dd class="font-mono text-xs">{{ row.id }}</dd>
                  <dt>Actor</dt><dd>{{ row.actor.name || '—' }} <span class="dg-text-muted">({{ row.actor.kind }})</span></dd>
                  <dt>IP address</dt><dd class="font-mono text-xs">{{ row.actor.ip || '—' }}</dd>
                  <dt>User agent</dt><dd class="text-xs">{{ row.actor.userAgent || '—' }}</dd>
                  <dt>Auth method</dt><dd class="text-xs">{{ row.actor.authMethod || '—' }}</dd>
                  @if (metadataLine(row.actor.metadata); as meta) { <dt>Token metadata</dt><dd class="text-xs">{{ meta }}</dd> }
                  @if (row.target.ecosystem) { <dt>Ecosystem</dt><dd>{{ row.target.ecosystem }}</dd> }
                  @if (row.target.repository) { <dt>Repository</dt><dd class="font-mono text-xs">{{ row.target.repository }}</dd> }
                </dl>
              </div>
            </div>
          </ng-template>
        </app-event-table>
      </section>
    </div>
  `,
})
export class AuditLogComponent implements OnInit {
  readonly columns: EventColumn[] = [
    { key: 'time', label: 'Time', cellClass: 'col-nowrap' },
    { key: 'actor', label: 'Actor' },
    { key: 'action', label: 'Action' },
    { key: 'target', label: 'Target' },
    { key: 'summary', label: 'Summary' },
  ];
  readonly targetKinds = TARGET_KINDS;
  readonly metadataLine = metadataLine;
  features: CatalogFeature[] = [];
  private labels = new Map<string, string>();
  items: AuditRow[] = [];
  feature = '';
  type = '';
  targetKind = '';
  target = '';
  actor = '';
  range: TimeRange = { preset: '30d', fromDay: '', toDay: '' };
  limit = savedPageSize('audit-log', 50);
  offset = 0;
  total = 0;
  loading = false;
  exporting = false;

  private events = inject(EventsService);
  private toast = inject(ToastService);

  get hasFilters(): boolean {
    return !!(this.feature || this.type || this.targetKind || this.target || this.actor || this.range.preset !== '30d');
  }

  /** Audit events of the chosen feature (or every feature), labelled as in the destination form. */
  get actions(): CatalogEvent[] {
    const features = this.feature ? this.features.filter((f) => f.feature === this.feature) : this.features;
    return features.flatMap((f) => f.groups.flatMap((g) => g.events)).filter((e) => e.category === 'audit');
  }

  ngOnInit(): void {
    this.events.catalog().subscribe({
      next: (catalog) => {
        this.features = catalog.features.filter((f) => f.groups.some((g) => g.events.some((e) => e.category === 'audit')));
        for (const f of catalog.features) for (const g of f.groups) for (const e of g.events) {
          this.labels.set(e.type, f.groups.length > 1 && g.tab ? `${g.tab} · ${e.label}` : `${f.label} · ${e.label}`);
        }
      },
      error: () => undefined,
    });
    this.load();
  }

  actionLabel(row: AuditRow): string {
    return this.labels.get(row.type) ?? row.type.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  }

  targetIcon(kind: string | null): string {
    return (kind && TARGET_ICONS[kind]) || 'label';
  }

  hasDetails(row: AuditRow): boolean {
    return Object.keys(row.details ?? {}).length > 0;
  }

  private query(limit: number, offset: number) {
    return { feature: this.feature, type: this.type, targetKind: this.targetKind, target: this.target, actor: this.actor, ...rangeBounds(this.range), limit, offset };
  }

  applyFilters(): void {
    this.offset = 0;
    this.load();
  }

  clearFilters(): void {
    this.feature = this.type = this.targetKind = this.target = this.actor = '';
    this.range = { preset: '30d', fromDay: '', toDay: '' };
    this.applyFilters();
  }

  load(): void {
    this.loading = true;
    this.events.auditEvents(this.query(this.limit, this.offset)).subscribe({
      next: (res) => {
        this.items = res.items;
        this.total = res.total;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load the audit log');
      },
    });
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  async exportCsv(): Promise<void> {
    this.exporting = true;
    try {
      const { items, truncated } = await fetchAllPages((limit, offset) => this.events.auditEvents(this.query(limit, offset)));
      downloadCsv(
        timestampedName('depgate-audit-log'),
        ['Time', 'Action', 'Feature', 'Actor', 'Actor kind', 'IP address', 'User agent', 'Auth method', 'Target kind', 'Target', 'Summary', 'Reasons', 'Event ID'],
        items.map((r) => [r.createdAt, r.type, r.feature, r.actor.name, r.actor.kind, r.actor.ip, r.actor.userAgent, r.actor.authMethod, r.target.kind, r.target.name, r.summary, r.reasons.join('; '), r.id])
      );
      if (truncated) this.toast.warning(`Exported the first ${items.length.toLocaleString()} entries. Narrow the filters to export the rest.`);
    } catch (err) {
      this.toast.error((err as { error?: { error?: string } })?.error?.error ?? 'Export failed');
    } finally {
      this.exporting = false;
    }
  }
}
