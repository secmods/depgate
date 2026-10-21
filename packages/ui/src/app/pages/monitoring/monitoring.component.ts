import { Component, DestroyRef, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MonitorPolicy, MonitorService } from '../../services/monitor.service';
import { ToastService } from '../../services/toast.service';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { MonitorActionsService } from './monitor-actions.service';
import { daysSince, plural, ruleSummary } from './monitoring';

export type MonitorSortKey = 'name' | 'since' | 'packages' | 'downloads' | 'willBlock' | 'approved' | 'lastSeen';
type Tab = 'monitoring' | 'enforced';

const COLUMNS: Array<{ key: MonitorSortKey; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Policy' },
  { key: 'since', label: 'Since' },
  { key: 'packages', label: 'Packages', numeric: true },
  { key: 'downloads', label: 'Downloads', numeric: true },
  { key: 'willBlock', label: 'Will be blocked', numeric: true },
  { key: 'approved', label: 'Approved', numeric: true },
  { key: 'lastSeen', label: 'Last match' },
];

/** Sorts policies by a column; ties keep the policy order. Empty dates sort last when descending. */
export function sortPolicies(items: MonitorPolicy[], key: MonitorSortKey, dir: 'asc' | 'desc'): MonitorPolicy[] {
  const value = (p: MonitorPolicy): number | string => {
    switch (key) {
      case 'name':
        return p.name.toLowerCase();
      case 'since':
        return p.modeChangedAt ? Date.parse(p.modeChangedAt) : 0;
      case 'lastSeen':
        return p.lastSeenAt ? Date.parse(p.lastSeenAt) : 0;
      default:
        return p[key];
    }
  };
  const sign = dir === 'asc' ? 1 : -1;
  return items
    .map((p, index) => ({ p, index, v: value(p) }))
    .sort((a, b) => (a.v < b.v ? -sign : a.v > b.v ? sign : a.index - b.index))
    .map((entry) => entry.p);
}

/**
 * Security → Monitoring: every Block policy in monitor mode, as a sortable table. A row opens
 * the policy's report on its own page, /monitoring/<id> (MON-U1, U2, U5).
 */
@Component({
  selector: 'app-monitoring',
  standalone: true,
  imports: [DatePipe, DecimalPipe, EmptyStateComponent, SearchInputComponent, StatusPillComponent],
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Monitoring</h1>
          <p class="dg-page-subtitle">
            Policies in monitor mode record what they would block without blocking it. Review the results, approve what you need, then enforce.
          </p>
        </div>
        <div class="dg-page-actions">
          <button type="button" class="dg-btn dg-btn-primary" (click)="newPolicy()">
            <span class="material-symbols-outlined">add</span> New policy
          </button>
        </div>
      </header>

      <nav class="dg-tabs" role="tablist">
        <button type="button" class="dg-tab" role="tab" [class.is-active]="tab === 'monitoring'" [attr.aria-selected]="tab === 'monitoring'" (click)="setTab('monitoring')">
          <span class="material-symbols-outlined">visibility</span> Monitoring
          @if (tab === 'monitoring' && all.length > 0) { <span class="dg-chip">{{ all.length }}</span> }
        </button>
        <button type="button" class="dg-tab" role="tab" [class.is-active]="tab === 'enforced'" [attr.aria-selected]="tab === 'enforced'" (click)="setTab('enforced')" data-testid="tab-enforced">
          <span class="material-symbols-outlined">history</span> Recently enforced
        </button>
      </nav>

      <section class="dg-card">
        @if (loading) {
          <div class="dg-loading"><span class="dg-spinner"></span></div>
        } @else if (all.length === 0) {
          @if (tab === 'monitoring') {
            <app-empty-state icon="visibility" title="No policies are monitoring"
              description="Create a Block policy and choose Monitor only to see what it would block, without breaking installs.">
              <button type="button" class="dg-btn dg-btn-primary" (click)="newPolicy()">
                <span class="material-symbols-outlined">add</span> New policy
              </button>
            </app-empty-state>
          } @else {
            <app-empty-state icon="history" title="Nothing enforced in the last 30 days"
              description="Enforced policies keep a read-only report here for 30 days." />
          }
        } @else {
          <div class="dg-toolbar">
            <app-search-input placeholder="Search policies" [(value)]="search" (search)="applyView()" />
            <span class="dg-toolbar-spacer"></span>
            <span class="dg-card-hint">
              {{ tab === 'monitoring' ? 'Open a policy to review, approve and enforce.' : 'Read-only for 30 days after enforcing.' }}
            </span>
          </div>
          @if (rows.length === 0) {
            <app-empty-state icon="search_off" title="No policies match" [compact]="true" />
          } @else {
            <div class="dg-table-wrap">
              <table class="dg-table" data-testid="monitor-policies">
                <thead>
                  <tr>
                    @for (col of columns; track col.key) {
                      <th [class.text-end]="col.numeric" [attr.aria-sort]="ariaSort(col.key)">
                        <button type="button" class="mon-sort" (click)="sortBy(col.key)" [attr.data-testid]="'sort-' + col.key">
                          {{ col.key === 'since' && tab === 'enforced' ? 'Enforced' : col.label }}
                          <span class="material-symbols-outlined" aria-hidden="true">{{ sortIcon(col.key) }}</span>
                        </button>
                      </th>
                    }
                    <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of rows; track p.id) {
                    <tr class="is-clickable" (click)="open(p)" [attr.data-testid]="'policy-row-' + p.id">
                      <td class="mon-name">
                        <span class="d-flex align-items-center gap-2 flex-wrap">
                          <span class="dg-cell-primary">{{ p.name }}</span>
                          @if (!p.isEnabled && p.mode === 'monitor') { <app-status-pill value="DISABLED" label="Off" /> }
                          @if (p.rechecking) { <app-status-pill value="rechecking" label="Rechecking…" tone="info" /> }
                          @if (p.capped) { <app-status-pill value="capped" label="Row limit reached" tone="warning" /> }
                        </span>
                        <span class="dg-cell-sub dg-cell-truncate" [title]="summary(p).detail">{{ summary(p).label }} · {{ summary(p).detail }}</span>
                      </td>
                      <td class="col-nowrap">
                        {{ p.modeChangedAt | date: 'MMM d, y' }}
                        <span class="dg-cell-sub">{{ ago(p.modeChangedAt) }}</span>
                      </td>
                      <td class="text-end">{{ p.packages | number }}</td>
                      <td class="text-end">{{ p.downloads | number }}</td>
                      <td class="text-end"><span class="fw-semibold" [class.text-danger]="p.willBlock > 0">{{ p.willBlock | number }}</span></td>
                      <td class="text-end">
                        {{ p.approved | number }}
                        @if (p.partlyApproved) { <span class="dg-cell-sub">+{{ p.partlyApproved }} partly</span> }
                      </td>
                      <td class="col-nowrap dg-text-variant">{{ p.lastSeenAt ? (p.lastSeenAt | date: 'MMM d, HH:mm') : '—' }}</td>
                      <td class="col-actions col-nowrap">
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="$event.stopPropagation(); open(p)">View</button>
                        @if (p.mode === 'monitor') {
                          <button type="button" class="dg-btn dg-btn-primary dg-btn-sm ms-1" (click)="$event.stopPropagation(); enforce(p)"
                            [attr.data-testid]="'enforce-' + p.id">Enforce</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      </section>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .mon-sort {
      display: inline-flex; align-items: center; gap: 2px; padding: 0; border: 0; background: transparent;
      font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; cursor: pointer; white-space: nowrap;
    }
    .mon-sort .material-symbols-outlined { font-size: 16px; opacity: 0.6; }
    .mon-sort:hover { color: var(--brand-text); }
    .mon-name { min-width: 200px; max-width: 420px; }
  `],
})
export class MonitoringComponent implements OnInit {
  tab: Tab = 'monitoring';
  all: MonitorPolicy[] = [];
  rows: MonitorPolicy[] = [];
  loading = false;
  loaded = false;
  search = '';
  sortKey: MonitorSortKey = 'willBlock';
  sortDir: 'asc' | 'desc' = 'desc';

  readonly columns = COLUMNS;
  readonly plural = plural;

  private monitor = inject(MonitorService);
  private actions = inject(MonitorActionsService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      // Links from before the report had its own page.
      const legacy = params.get('policy');
      if (legacy) {
        this.router.navigate(['/monitoring', legacy], { replaceUrl: true });
        return;
      }
      const tab: Tab = params.get('tab') === 'enforced' ? 'enforced' : 'monitoring';
      if (tab !== this.tab || !this.loaded) {
        this.tab = tab;
        this.load();
      }
    });
  }

  summary(p: MonitorPolicy) {
    return ruleSummary(p.conditions);
  }

  /** "Today", "1 day ago", "12 days ago". */
  ago(iso: string | null): string {
    const days = daysSince(iso);
    return days === 0 ? 'Today' : `${plural(days, 'day')} ago`;
  }

  setTab(tab: Tab): void {
    if (tab === this.tab) return;
    this.router.navigate([], { queryParams: { tab: tab === 'enforced' ? 'enforced' : null } });
  }

  load(): void {
    this.loading = true;
    this.loaded = true;
    const tab = this.tab;
    this.monitor.policies(tab).subscribe({
      next: (res) => {
        if (tab !== this.tab) return;
        this.all = res.items;
        this.loading = false;
        this.applyView();
        this.monitor.refreshCount();
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load monitoring policies');
      },
    });
  }

  applyView(): void {
    const term = this.search.trim().toLowerCase();
    const matching = term
      ? this.all.filter((p) => p.name.toLowerCase().includes(term) || ruleSummary(p.conditions).detail.toLowerCase().includes(term))
      : this.all;
    this.rows = sortPolicies(matching, this.sortKey, this.sortDir);
  }

  sortBy(key: MonitorSortKey): void {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      // Names read A–Z; counts and dates read largest or newest first.
      this.sortDir = key === 'name' ? 'asc' : 'desc';
    }
    this.applyView();
  }

  sortIcon(key: MonitorSortKey): string {
    if (this.sortKey !== key) return 'unfold_more';
    return this.sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward';
  }

  ariaSort(key: MonitorSortKey): string | null {
    if (this.sortKey !== key) return null;
    return this.sortDir === 'asc' ? 'ascending' : 'descending';
  }

  open(p: MonitorPolicy): void {
    this.router.navigate(['/monitoring', p.id]);
  }

  async enforce(p: MonitorPolicy): Promise<void> {
    if (await this.actions.enforce(p)) this.load();
  }

  newPolicy(): void {
    void this.router.navigate(['/policies/new'], { queryParams: { mode: 'monitor', returnUrl: '/monitoring' } });
  }
}
