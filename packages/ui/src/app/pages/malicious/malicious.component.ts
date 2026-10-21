import { Component, OnInit, OnDestroy, inject, Injector, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { forkJoin, interval, Subscription } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
import { MODAL_PKG, MODAL_DATA } from '../../tokens';
import { MaliciousService, MaliciousPackage, SyncStatus } from '../../services/malicious.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ecosystemLabel } from '../../shared/status';
import { OverrideDialogComponent } from './override-dialog.component';
import { MaliciousFormDialogComponent } from './malicious-form-dialog.component';
import { MaliciousViewDialogComponent } from './malicious-view-dialog.component';

const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'crates.io', 'rubygems'];

@Component({
  selector: 'app-malicious',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, FormsModule, EcoTagComponent, EmptyStateComponent, PaginationComponent,
    SearchInputComponent, StatusPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Malware packages</h1>
          <p class="dg-page-subtitle">Known malware from the threat feed and your own entries. Downloads are blocked unless overridden.</p>
          <p class="dg-page-meta">
            <span class="material-symbols-outlined" aria-hidden="true">schedule</span>
            @if (lastSyncAt) {
              Last synced {{ lastSyncAt | date: 'medium' }}
            } @else {
              Not synced yet
            }
            @if (syncSummary) {
              <span aria-hidden="true">·</span> {{ syncSummary }}
            }
          </p>
        </div>
        <div class="dg-page-actions">
          <button type="button" class="dg-btn dg-btn-secondary" (click)="sync()" [disabled]="!metadataLoaded || syncBusy">
            @if (syncBusy) {
              <span class="dg-spinner is-sm" aria-hidden="true"></span> {{ syncProgress }}
            } @else {
              <span class="material-symbols-outlined">sync</span> Sync feed
            }
          </button>
          <button type="button" class="dg-btn dg-btn-primary" (click)="openAdd()">
            <span class="material-symbols-outlined">add</span> Add package
          </button>
        </div>
      </header>

      <div class="dg-stats">
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Tracked packages</div>
            <div class="dg-stat-value">{{ counts.all | number }}</div>
            <div class="dg-stat-meta">Feed and custom entries</div>
          </div>
          <span class="dg-stat-icon tone-brand"><span class="material-symbols-outlined">bug_report</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">From threat feed</div>
            <div class="dg-stat-value">{{ counts.all - counts.custom | number }}</div>
            <div class="dg-stat-meta">Synced advisories</div>
          </div>
          <span class="dg-stat-icon tone-neutral"><span class="material-symbols-outlined">rss_feed</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Custom entries</div>
            <div class="dg-stat-value">{{ counts.custom | number }}</div>
            <div class="dg-stat-meta">Added by your team</div>
          </div>
          <span class="dg-stat-icon tone-neutral"><span class="material-symbols-outlined">edit_note</span></span>
        </div>
        <div class="dg-stat">
          <div>
            <div class="dg-stat-label">Allowed overrides</div>
            <div class="dg-stat-value">{{ counts.allowed | number }}</div>
            <div class="dg-stat-meta">Bypassing the block</div>
          </div>
          <span class="dg-stat-icon tone-warning"><span class="material-symbols-outlined">verified_user</span></span>
        </div>
      </div>

      <section class="dg-card">
        <div class="dg-toolbar">
          <app-search-input placeholder="Search by package name" [(value)]="nameFilter" (search)="applyFilters()" />
          <label class="dg-filter">
            <span>Ecosystem</span>
            <select class="dg-select" [(ngModel)]="ecosystem" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              @for (e of ecosystems; track e) {
                <option [value]="e">{{ label(e) }}</option>
              }
            </select>
          </label>
          <label class="dg-filter">
            <span>Source</span>
            <select class="dg-select" [(ngModel)]="source" (ngModelChange)="applyFilters()">
              <option value="all">All</option>
              <option value="feed">Threat feed</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label class="dg-filter">
            <span>Status</span>
            <select class="dg-select" [(ngModel)]="status" (ngModelChange)="applyFilters()">
              <option value="">All</option>
              <option value="BLOCK">Blocked</option>
              <option value="ALLOW">Allowed</option>
            </select>
          </label>
        </div>

        @if (loading) {
          <div class="dg-loading"><span class="dg-spinner"></span></div>
        } @else if (items.length === 0) {
          <app-empty-state icon="bug_report" title="No packages match these filters"
            description="Change the filters, sync the threat feed, or add a custom entry." />
        } @else {
          <div class="dg-table-wrap">
            <table class="dg-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Ecosystem</th>
                  <th>Advisory</th>
                  <th>Versions</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of items; track row.id) {
                  <tr>
                    <td><span class="dg-cell-primary">{{ row.name }}</span></td>
                    <td><app-eco-tag [ecosystem]="row.ecosystem" /></td>
                    <td><span class="dg-cell-truncate font-mono text-xs" [title]="row.reason || ''">{{ row.reason || '—' }}</span></td>
                    <td><span class="dg-tag">{{ row.versionRange || 'all versions' }}</span></td>
                    <td class="col-nowrap">{{ row.source === 'custom' ? 'Custom' : 'Threat feed' }}</td>
                    <td><app-status-pill [value]="row.overrideStatus" [label]="row.overrideStatus === 'ALLOW' ? 'Allowed' : 'Blocked'" /></td>
                    <td class="col-actions">
                      <div class="dg-row-actions">
                        <button type="button" class="dg-icon-btn" (click)="openView(row)" title="View details" aria-label="View details">
                          <span class="material-symbols-outlined">visibility</span>
                        </button>
                        <button type="button" class="dg-icon-btn" (click)="openOverride(row)" title="Change decision" aria-label="Change decision">
                          <span class="material-symbols-outlined">gavel</span>
                        </button>
                        @if (row.source === 'custom') {
                          <button type="button" class="dg-icon-btn" (click)="openEdit(row)" title="Edit" aria-label="Edit">
                            <span class="material-symbols-outlined">edit</span>
                          </button>
                          <button type="button" class="dg-icon-btn is-danger" (click)="confirmDelete(row)" title="Delete" aria-label="Delete">
                            <span class="material-symbols-outlined">delete</span>
                          </button>
                        }
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="items.length" storageKey="malware" (pageChange)="onPage($event)" />
      </section>
    </div>
  `,
})
export class MaliciousComponent implements OnInit, OnDestroy {
  items: MaliciousPackage[] = [];
  ecosystems = ECOSYSTEMS;
  source: 'all' | 'custom' | 'feed' = 'all';
  status: '' | 'BLOCK' | 'ALLOW' = '';
  ecosystem = '';
  nameFilter = '';
  syncStatus: SyncStatus | null = null;
  metadataLoaded = false;
  syncStarting = false;
  limit = savedPageSize('malware', 20);
  offset = 0;
  total = 0;
  loading = false;
  lastSyncAt: string | null = null;
  counts = { all: 0, custom: 0, allowed: 0 };

  private pollSub?: Subscription;
  private malicious = inject(MaliciousService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);

  get syncBusy(): boolean {
    return this.syncStarting || this.syncStatus?.status === 'running';
  }

  get syncProgress(): string {
    const s = this.syncStatus;
    if (s?.phase === 'fetching') return s.ecosystem ? `Syncing ${ecosystemLabel(s.ecosystem)}…` : 'Syncing…';
    if (s?.added != null && s?.total != null) return `Syncing ${s.added.toLocaleString()} / ${s.total.toLocaleString()}`;
    return 'Syncing…';
  }

  get syncSummary(): string {
    const s = this.syncStatus;
    if (!s || s.status === 'running') return '';
    if (s.status === 'failed') return 'Last sync failed';
    if (s.mode === 'none') return 'No changes in last sync';
    return `${(s.added ?? 0).toLocaleString()} added in last sync`;
  }

  ngOnInit(): void {
    this.load();
    this.loadCounts();
    this.loadMetadata();
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  loadMetadata(): void {
    this.malicious.getMetadata().subscribe({
      next: (m) => {
        this.lastSyncAt = m.lastSyncAt ?? null;
        this.syncStatus = m.syncStatus ?? null;
        this.metadataLoaded = true;
        if (this.syncStatus?.status === 'running') this.startPolling();
      },
      error: () => (this.metadataLoaded = true),
    });
  }

  loadCounts(): void {
    forkJoin({
      all: this.malicious.list({ source: 'all', limit: 1 }),
      custom: this.malicious.list({ source: 'custom', limit: 1 }),
      allowed: this.malicious.list({ source: 'all', status: 'ALLOW', limit: 1 }),
    }).subscribe({
      next: (r) => (this.counts = { all: r.all.total, custom: r.custom.total, allowed: r.allowed.total }),
    });
  }

  applyFilters(): void {
    this.offset = 0;
    this.load();
  }

  load(): void {
    this.loading = true;
    this.malicious.list({
      ecosystem: this.ecosystem || undefined,
      name: this.nameFilter || undefined,
      source: this.source,
      status: this.status || undefined,
      limit: this.limit,
      offset: this.offset,
    }).subscribe({
      next: (res) => {
        this.items = res.items;
        this.total = res.total;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load malware packages');
      },
    });
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  sync(): void {
    if (this.syncBusy) return;
    this.syncStarting = true;
    this.syncStatus = { status: 'running', startedAt: new Date().toISOString(), phase: 'fetching' };
    this.malicious.sync().subscribe({
      next: () => this.startPolling(),
      error: (err) => {
        if (err.status === 409) {
          this.toast.info(err.error?.error ?? 'A sync is already running');
          this.startPolling();
          return;
        }
        this.syncStarting = false;
        this.syncStatus = null;
        this.toast.error(err.error?.error ?? 'Sync failed');
      },
    });
  }

  private startPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(2000).pipe(
      switchMap(() => this.malicious.getMetadata()),
      takeWhile((m) => m.syncStatus?.status === 'running', true),
    ).subscribe({
      next: (m) => {
        this.lastSyncAt = m.lastSyncAt ?? null;
        this.syncStatus = m.syncStatus ?? null;
        if (this.syncStatus?.status === 'completed') {
          this.syncStarting = false;
          this.toast.success(this.syncStatus.mode === 'none'
            ? 'Feed is up to date'
            : `Feed synced: ${(this.syncStatus.added ?? 0).toLocaleString()} added`);
          this.load();
          this.loadCounts();
        } else if (this.syncStatus?.status === 'failed') {
          this.syncStarting = false;
          this.toast.error(this.syncStatus.error ?? 'Sync failed');
        }
      },
    });
  }

  private reload(): void {
    this.load();
    this.loadCounts();
  }

  openView(row: MaliciousPackage): void {
    this.modal.open(MaliciousViewDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_PKG, useValue: row }], parent: this.injector }),
    });
  }

  openOverride(row: MaliciousPackage): void {
    const ref = this.modal.open(OverrideDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_PKG, useValue: row }], parent: this.injector }),
    });
    ref.closed.subscribe((reload) => { if (reload) this.reload(); });
  }

  openAdd(): void {
    const ref = this.modal.open(MaliciousFormDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: { editing: false } }], parent: this.injector }),
    });
    ref.closed.subscribe((reload) => {
      if (reload) {
        this.offset = 0;
        this.reload();
      }
    });
  }

  openEdit(row: MaliciousPackage): void {
    const ref = this.modal.open(MaliciousFormDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: { editing: true, pkg: row } }], parent: this.injector }),
    });
    ref.closed.subscribe((reload) => { if (reload) this.load(); });
  }

  async confirmDelete(row: MaliciousPackage): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete custom entry?',
      message: `${row.name} (${ecosystemLabel(row.ecosystem)}) will no longer be blocked by this entry. This can't be undone.`,
      confirmText: 'Delete entry',
    });
    if (!ok) return;
    this.malicious.delete(row.id).subscribe({
      next: () => {
        this.toast.success(`Deleted ${row.name}`);
        this.reload();
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
}
