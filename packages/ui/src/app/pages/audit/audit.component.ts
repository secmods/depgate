import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EventsService, LedgerRow } from '../../services/events.service';
import { ToastService } from '../../services/toast.service';
import { RepositoryService } from '../../services/repository.service';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { PageChange, savedPageSize } from '../../shared/pagination.component';
import { ECOSYSTEMS, ecosystemLabel } from '../../shared/status';
import { downloadCsv, fetchAllPages, timestampedName } from '../../shared/csv';
import { EventColumn, EventTableComponent } from '../../shared/event-table.component';
import { TimeRange, TimeRangeComponent, rangeBounds } from '../../shared/time-range.component';
import { EventBannersComponent } from '../../shared/event-banners.component';
import { decisionLabel, decisionTone, metadataLine } from '../../shared/event-labels';

/** Decision Ledger (requirements_event_streaming.md §10.2): what the gateway refused, and why. */
@Component({
  selector: 'app-audit',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    EcoTagComponent,
    SearchInputComponent,
    StatusPillComponent,
    EventTableComponent,
    TimeRangeComponent,
    EventBannersComponent,
  ],
  styles: [`
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px 32px; }
    .detail-grid dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; font-size: 0.8125rem; }
    .detail-grid dt { color: var(--color-muted); font-weight: 500; }
    .detail-grid dd { margin: 0; color: var(--color-on-surface); word-break: break-word; }
    .reasons { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 0.8125rem; }
    .reasons li { display: flex; gap: 8px; align-items: flex-start; }
    .reasons .material-symbols-outlined { font-size: 16px; margin-top: 1px; }
    .malware-tag { background: var(--danger-bg); color: var(--danger-fg); font-family: inherit; font-weight: 600; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Decision ledger</h1>
          <p class="dg-page-subtitle">Downloads the gateway blocked, and why. Allowed downloads are not listed here.</p>
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

      <app-event-banners kind="ledger" />

      <section class="dg-card">
        <div class="dg-toolbar">
          <app-search-input placeholder="Search by package" style="flex-basis: 200px; max-width: 240px" [(value)]="packageFilter" (search)="applyFilters()" />
          <app-time-range [range]="range" (rangeChange)="range = $event; applyFilters()" />
          <label class="dg-filter">
            <span>Ecosystem</span>
            <select class="dg-select" [(ngModel)]="ecosystem" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              @for (e of ecosystems; track e) { <option [value]="e">{{ label(e) }}</option> }
            </select>
          </label>
          <label class="dg-filter">
            <span>Event</span>
            <select class="dg-select" [(ngModel)]="decision" (ngModelChange)="applyFilters()" data-testid="ledger-decision-filter">
              <option value="">All</option>
              <option value="BLOCK_ENFORCE">Block · Enforce</option>
              <option value="UPSTREAM_UNAVAILABLE">Upstream unavailable</option>
              <option value="MALWARE">Malware (any outcome)</option>
              <option value="ALLOW">Allow (malware let through)</option>
            </select>
          </label>
          <label class="dg-filter">
            <span>Repository</span>
            <select class="dg-select" [(ngModel)]="repository" (ngModelChange)="applyFilters()" data-testid="ledger-repository-filter">
              <option value="">All</option>
              @for (key of repositoryKeys; track key) { <option [value]="key">{{ key }}</option> }
            </select>
          </label>
          <label class="dg-filter">
            <span>Auth</span>
            <select class="dg-select" [(ngModel)]="authMethod" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              <option value="ci_token">CI token</option>
              <option value="api_key">API key</option>
              <option value="registry_token">Registry token</option>
              <option value="password">Password</option>
              <option value="oidc">OIDC</option>
              <option value="saml">SAML</option>
            </select>
          </label>
          <app-search-input placeholder="Policy" style="flex-basis: 140px; max-width: 180px" [(value)]="policy" (search)="applyFilters()" />
          <app-search-input placeholder="Actor or IP" style="flex-basis: 140px; max-width: 180px" [(value)]="actor" (search)="applyFilters()" />
          <app-search-input placeholder="Metadata key=value" style="flex-basis: 170px; max-width: 200px" [(value)]="meta" (search)="applyFilters()" />
          @if (hasFilters) {
            <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="clearFilters()">Clear filters</button>
          }
        </div>

        <app-event-table [columns]="columns" [rows]="items" [loading]="loading" [offset]="offset" [limit]="limit" [total]="total"
          storageKey="ledger" emptyDescription="Refused downloads and unavailable upstreams appear here." testId="ledger-table"
          (pageChange)="onPage($event)">
          <ng-template #cell let-row let-column="column">
            @switch (column) {
              @case ('time') { {{ row.createdAt | date: 'MMM d, y' }} <span class="dg-cell-sub">{{ row.createdAt | date: 'HH:mm:ss' }}</span> }
              @case ('package') {
                <span class="dg-cell-primary">{{ row.packageName || '—' }}</span>
                @if (row.version) { <span class="dg-tag ms-2">{{ row.version }}</span> }
                @if (row.malware) { <span class="dg-tag malware-tag ms-1" data-testid="malware-tag">Malware</span> }
                <div class="mt-1"><app-eco-tag [ecosystem]="row.ecosystem" /></div>
              }
              @case ('repository') { <span class="font-mono text-xs">{{ row.repository || '—' }}</span> }
              @case ('event') { <app-status-pill [value]="row.decision" [label]="decisionLabel(row.decision)" [tone]="decisionTone(row.decision)" /> }
              @case ('policy') { <span class="dg-cell-truncate" style="max-width: 200px" [title]="row.policyName || ''">{{ row.policyName || '—' }}</span> }
              @case ('actor') {
                <span class="col-nowrap">{{ row.actor.name || '—' }}</span>
                @if (row.actor.ip) { <span class="dg-cell-sub font-mono">{{ row.actor.ip }}</span> }
              }
              @case ('build') { <span class="font-mono text-xs">{{ row.build || '—' }}</span> }
            }
          </ng-template>
          <ng-template #detail let-row>
            <div class="detail-grid">
              <div>
                <p class="dg-section-label">Reasons</p>
                @if (row.reasons.length) {
                  <ul class="reasons">
                    @for (r of row.reasons; track $index) {
                      <li><span class="material-symbols-outlined" [class.dg-text-danger]="row.decision !== 'ALLOW'" [class.dg-text-brand]="row.decision === 'ALLOW'">{{ row.decision === 'ALLOW' ? 'info' : 'cancel' }}</span><span>{{ r }}</span></li>
                    }
                  </ul>
                } @else {
                  <span class="dg-empty">None recorded</span>
                }
              </div>
              <div>
                <p class="dg-section-label">Request</p>
                <dl>
                  <dt>Entry ID</dt><dd class="font-mono text-xs">{{ row.id }}</dd>
                  @if (sourceLabel(row); as source) { <dt>Source</dt><dd class="font-mono text-xs" data-testid="audit-source">{{ source }}</dd> }
                  @if (row.policyName || row.policyId) { <dt>Policy</dt><dd>{{ row.policyName || row.policyId }}</dd> }
                  @if (malwareLabel(row); as malware) { <dt>Malware entry</dt><dd class="font-mono text-xs">{{ malware }}</dd> }
                  <dt>Actor</dt><dd>{{ row.actor.name || '—' }} @if (row.actor.kind) { <span class="dg-text-muted">({{ row.actor.kind }})</span> }</dd>
                  <dt>IP address</dt><dd class="font-mono text-xs">{{ row.actor.ip || '—' }}</dd>
                  <dt>User agent</dt><dd class="text-xs">{{ row.actor.userAgent || '—' }}</dd>
                  <dt>Auth method</dt><dd class="text-xs">{{ row.actor.authMethod || '—' }}</dd>
                  @if (metadataLine(row.actor.metadata); as meta) { <dt>Token metadata</dt><dd class="text-xs" data-testid="ledger-metadata">{{ meta }}</dd> }
                </dl>
              </div>
            </div>
          </ng-template>
        </app-event-table>
      </section>
    </div>
  `,
})
export class AuditComponent implements OnInit {
  readonly columns: EventColumn[] = [
    { key: 'time', label: 'Time', cellClass: 'col-nowrap' },
    { key: 'package', label: 'Package' },
    { key: 'repository', label: 'Repository' },
    { key: 'event', label: 'Event', cellClass: 'col-nowrap' },
    { key: 'policy', label: 'Policy' },
    { key: 'actor', label: 'Actor' },
    { key: 'build', label: 'Build' },
  ];
  items: LedgerRow[] = [];
  ecosystems = ECOSYSTEMS;
  ecosystem = '';
  repository = '';
  repositoryKeys: string[] = [];
  decision = '';
  authMethod = '';
  packageFilter = '';
  policy = '';
  actor = '';
  meta = '';
  range: TimeRange = { preset: '7d', fromDay: '', toDay: '' };
  limit = savedPageSize('ledger', 50);
  offset = 0;
  total = 0;
  loading = false;
  exporting = false;

  readonly decisionLabel = decisionLabel;
  readonly decisionTone = decisionTone;
  readonly metadataLine = metadataLine;

  private events = inject(EventsService);
  private toast = inject(ToastService);
  private repositories = inject(RepositoryService);

  get hasFilters(): boolean {
    return !!(this.ecosystem || this.repository || this.decision || this.authMethod || this.packageFilter || this.policy || this.actor || this.meta || this.range.preset !== '7d');
  }

  ngOnInit(): void {
    this.load();
    this.repositories.list().subscribe({
      next: (rows) => (this.repositoryKeys = [...new Set(rows.map((row) => row.key))].sort()),
      error: () => undefined,
    });
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  private query(limit: number, offset: number) {
    return {
      ecosystem: this.ecosystem,
      repository: this.repository,
      package: this.packageFilter,
      decision: this.decision,
      authMethod: this.authMethod,
      policy: this.policy,
      actor: this.actor,
      meta: this.meta.includes('=') ? this.meta : '',
      ...rangeBounds(this.range),
      limit,
      offset,
    };
  }

  applyFilters(): void {
    this.offset = 0;
    this.load();
  }

  clearFilters(): void {
    this.ecosystem = this.repository = this.decision = this.authMethod = this.packageFilter = this.policy = this.actor = this.meta = '';
    this.range = { preset: '7d', fromDay: '', toDay: '' };
    this.applyFilters();
  }

  load(): void {
    this.loading = true;
    this.events.ledger(this.query(this.limit, this.offset)).subscribe({
      next: (res) => {
        this.items = res.items;
        this.total = res.total;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load the ledger');
      },
    });
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  /** The remote that served the download, e.g. `npm/acme-artifactory (internal)`. */
  sourceLabel(row: LedgerRow): string {
    const source = row.details['source'] as { repository?: string; type?: string } | undefined;
    if (!source?.repository) return '';
    return source.type ? `${source.repository} (${source.type})` : source.repository;
  }

  malwareLabel(row: LedgerRow): string {
    const malware = row.details['malware'] as { id?: string; source?: string } | undefined;
    return malware?.id ? `${malware.id}${malware.source ? ` (${malware.source})` : ''}` : '';
  }

  async exportCsv(): Promise<void> {
    this.exporting = true;
    try {
      const { items, truncated } = await fetchAllPages((limit, offset) => this.events.ledger(this.query(limit, offset)));
      downloadCsv(
        timestampedName('depgate-ledger'),
        ['Time', 'Event', 'Malware', 'Ecosystem', 'Package', 'Version', 'Repository', 'Policy', 'Reasons', 'Actor', 'IP address', 'User agent', 'Auth method', 'Build', 'Entry ID'],
        items.map((r) => [
          r.createdAt, r.decision, r.malware ? 'yes' : '', r.ecosystem, r.packageName, r.version, r.repository, r.policyName,
          r.reasons.join('; '), r.actor.name, r.actor.ip, r.actor.userAgent, r.actor.authMethod, r.build, r.id,
        ])
      );
      if (truncated) this.toast.warning(`Exported the first ${items.length.toLocaleString()} entries. Narrow the filters to export the rest.`);
    } catch (err) {
      this.toast.error((err as { error?: { error?: string } })?.error?.error ?? 'Export failed');
    } finally {
      this.exporting = false;
    }
  }
}
