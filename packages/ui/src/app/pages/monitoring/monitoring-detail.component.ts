import { Component, DestroyRef, Injector, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgbDropdownModule, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import {
  LastSeenWithin,
  MonitorPackage,
  MonitorPolicy,
  MonitorService,
  MonitorStatusFilter,
  PackageQuery,
  ReasonGroup,
} from '../../services/monitor.service';
import { BreadcrumbService } from '../../services/breadcrumb.service';
import { ToastService } from '../../services/toast.service';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { RepositoryService } from '../../services/repository.service';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS, Tone, ecosystemLabel } from '../../shared/status';
import { timestampedName } from '../../shared/csv';
import { MODAL_DATA } from '../../tokens';
import { PolicyRule } from '../policies/policy-rules';
import { ApproveDialogComponent, ApproveDialogData } from './approve-dialog.component';
import { MonitorActionsService } from './monitor-actions.service';
import {
  STATUS_FILTERS,
  approvalChoices,
  daysSince,
  plural,
  policyRule,
  reasonLabel,
  ruleSummary,
  statusView,
  suggestionText,
} from './monitoring';

const PAGE_SIZE = 50;
const RECHECK_POLL_MS = 3000;

/**
 * Security → Monitoring → one policy: what it would block, grouped by reason then package,
 * with approvals, Export, Enforce and Restart monitoring (MON-U3–U5, MON-X1).
 */
@Component({
  selector: 'app-monitoring-detail',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, PercentPipe, FormsModule, RouterLink, NgbDropdownModule, EcoTagComponent, EmptyStateComponent,
    PaginationComponent, SearchInputComponent, StatusPillComponent,
  ],
  template: `
    <div class="dg-page">
      <a class="mon-back" [routerLink]="['/monitoring']" [queryParams]="policy?.mode === 'enforce' ? { tab: 'enforced' } : {}">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
        {{ policy?.mode === 'enforce' ? 'Recently enforced' : 'Monitoring' }}
      </a>

      @if (notFound) {
        <section class="dg-card">
          <app-empty-state icon="search_off" title="Policy not found" description="It may have been deleted.">
            <a class="dg-btn dg-btn-secondary" routerLink="/monitoring">Back to Monitoring</a>
          </app-empty-state>
        </section>
      } @else if (!policy) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        @let p = policy;
        <header class="dg-page-header">
          <div class="min-w-0">
            <div class="d-flex align-items-center gap-2 flex-wrap">
              <h1 class="dg-page-title" data-testid="detail-title">{{ p.name }}</h1>
              @if (readOnly) {
                <app-status-pill value="ENFORCED" label="Enforced" tone="success" />
              } @else if (!p.isEnabled) {
                <app-status-pill value="DISABLED" label="Disabled" />
              } @else {
                <app-status-pill value="monitoring" label="Monitoring" tone="info" />
              }
            </div>
            <p class="dg-page-subtitle">
              {{ summary.label }} · {{ summary.detail }}
              <br />
              @if (readOnly) {
                Enforced {{ p.modeChangedAt | date: 'MMM d, y' }}
              } @else {
                Monitoring since {{ p.modeChangedAt | date: 'MMM d, y' }} ({{ days === 0 ? 'today' : plural(days, 'day') }})
              }
            </p>
          </div>
          <div class="dg-page-actions">
            <div ngbDropdown class="d-inline-block" placement="bottom-end">
              <button type="button" class="dg-btn dg-btn-secondary" ngbDropdownToggle [disabled]="p.versions === 0" data-testid="detail-export">
                <span class="material-symbols-outlined">download</span> Export
              </button>
              <div ngbDropdownMenu>
                <button type="button" ngbDropdownItem (click)="exportShown('package')">One row per package</button>
                <button type="button" ngbDropdownItem (click)="exportShown('version')">One row per version</button>
              </div>
            </div>
            @if (!readOnly) {
              <button type="button" class="dg-btn dg-btn-primary" (click)="enforce()" data-testid="detail-enforce">
                <span class="material-symbols-outlined">gavel</span> Enforce
              </button>
              <div ngbDropdown class="d-inline-block" placement="bottom-end">
                <button type="button" class="dg-icon-btn mon-more" ngbDropdownToggle aria-label="More actions" title="More actions" data-testid="detail-more">
                  <span class="material-symbols-outlined">more_vert</span>
                </button>
                <div ngbDropdownMenu>
                  <button type="button" ngbDropdownItem (click)="editPolicy()">Edit policy</button>
                  <button type="button" ngbDropdownItem (click)="restart()" data-testid="detail-restart">Restart monitoring</button>
                </div>
              </div>
            }
          </div>
        </header>

        <div class="dg-stats" data-testid="detail-stats">
          <div class="dg-stat"><div>
            <div class="dg-stat-label">Packages</div>
            <div class="dg-stat-value">{{ p.packages | number }}</div>
            <div class="dg-stat-meta">{{ plural(p.versions, 'version') }}</div>
          </div></div>
          <div class="dg-stat"><div>
            <div class="dg-stat-label">Downloads</div>
            <div class="dg-stat-value">{{ p.downloads | number }}</div>
            <div class="dg-stat-meta">@if (p.lastSeenAt) { Last match {{ p.lastSeenAt | date: 'MMM d, HH:mm' }} } @else { No matches yet }</div>
          </div></div>
          <div class="dg-stat"><div>
            <div class="dg-stat-label">Will be blocked</div>
            <div class="dg-stat-value" [class.text-danger]="p.willBlock > 0">{{ p.willBlock | number }}</div>
            <div class="dg-stat-meta">packages on Enforce</div>
          </div></div>
          <div class="dg-stat"><div>
            <div class="dg-stat-label">Approved</div>
            <div class="dg-stat-value">{{ p.approved | number }}</div>
            <div class="dg-stat-meta">@if (p.partlyApproved) { +{{ p.partlyApproved }} partly approved } @else { packages }</div>
          </div></div>
        </div>

        <section class="dg-card" data-testid="monitor-report">
          <div class="dg-card-header">
            <h2 class="dg-card-title">What it would block</h2>
            <span class="dg-card-hint">
              @if (p.retentionDays > 0) {
                Counts cover packages downloaded in the last {{ p.retentionDays }} days.
              } @else {
                Counts cover every package recorded since monitoring started.
              }
            </span>
          </div>

          @if (p.rechecking) {
            <div class="dg-callout mx-3 mb-3" data-testid="report-rechecking">
              <span class="dg-spinner is-sm" aria-hidden="true"></span>
              <div>
                Rechecking…@if (p.recheckProgress; as progress) { <strong data-testid="report-recheck-progress">{{ progress.done | number }} of {{ progress.total | number }} packages</strong>. }
                The rule changed, so recorded versions are being checked again. Ones it no longer matches are removed.
              </div>
            </div>
          } @else if (p.recheckFailed) {
            <div class="dg-callout is-danger mx-3 mb-3" data-testid="report-recheck-failed">
              <span class="material-symbols-outlined" aria-hidden="true">error</span>
              <div class="flex-grow-1">Recheck failed. The report may still list versions the current rule no longer matches.</div>
              @if (!readOnly) {
                <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="retryRecheck()" [disabled]="retryingRecheck" data-testid="report-recheck-retry">Retry</button>
              }
            </div>
          }
          @if (p.capped) {
            <div class="dg-callout is-warning mx-3 mb-3" data-testid="report-capped">
              <span class="material-symbols-outlined" aria-hidden="true">warning</span>
              <div>This policy reached its limit of {{ p.rowLimit | number }} recorded versions. New ones are counted but not listed; the rule may be too broad.</div>
            </div>
          }
          @if (readOnly) {
            <div class="dg-callout mx-3 mb-3">
              <span class="material-symbols-outlined" aria-hidden="true">lock</span>
              <div>Enforced on {{ p.modeChangedAt | date: 'MMM d, y' }}. This read-only report is deleted 30 days after enforcing.</div>
            </div>
          }
          @if (!p.isEnabled && !readOnly) {
            <div class="dg-callout is-warning mx-3 mb-3">
              <span class="material-symbols-outlined" aria-hidden="true">pause_circle</span>
              <div>This policy is off and not recording. Turn it on in Policies.</div>
            </div>
          }

          @if (p.versions === 0) {
            <app-empty-state icon="visibility" title="Nothing to show yet"
              [description]="'Nothing downloaded has matched this policy since ' + (p.modeChangedAt | date: 'MMM d, y') + '.'" />
          } @else {
            <div class="mon-reasons" data-testid="reason-groups">
              <div class="mon-reasons-head">
                <p class="dg-section-label mb-0">By reason</p>
                @if (reasonKey) {
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="setReason('')">Show all reasons</button>
                }
              </div>
              @for (g of reasons; track g.reasonKey) {
                <div class="mon-reason" [class.is-active]="g.reasonKey === reasonKey">
                  <button type="button" class="mon-reason-main" (click)="setReason(g.reasonKey)" [attr.aria-pressed]="g.reasonKey === reasonKey"
                    [attr.data-testid]="'reason-' + g.reasonKey">
                    <span class="mon-reason-label">{{ label(g.reasonKey) }}</span>
                    <span class="mon-reason-bar" aria-hidden="true"><span [style.width.%]="g.share * 100"></span></span>
                    <span class="mon-reason-count">{{ plural(g.packages, 'package') }} · {{ g.downloads | number }} downloads · {{ g.share | percent: '1.0-0' }}</span>
                  </button>
                  @if (!readOnly) {
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="editRule(g)" [title]="suggestion(g.reasonKey)"
                      [attr.data-testid]="'edit-rule-' + g.reasonKey">Edit rule</button>
                  }
                </div>
              }
            </div>

            <div class="dg-toolbar">
              <app-search-input placeholder="Search packages" [(value)]="search" (search)="reloadPackages()" />
              <label class="dg-filter">
                <span>Reason</span>
                <select class="dg-select" [ngModel]="reasonKey" (ngModelChange)="setReason($event)" data-testid="filter-reason">
                  <option value="">All</option>
                  @for (g of reasons; track g.reasonKey) { <option [value]="g.reasonKey">{{ label(g.reasonKey) }}</option> }
                </select>
              </label>
              <label class="dg-filter">
                <span>Ecosystem</span>
                <select class="dg-select" [(ngModel)]="ecosystem" (ngModelChange)="reloadPackages()">
                  <option value="">All</option>
                  @for (e of ecosystems; track e) { <option [value]="e">{{ ecoLabel(e) }}</option> }
                </select>
              </label>
              <label class="dg-filter">
                <span>Repository</span>
                <select class="dg-select" [(ngModel)]="repository" (ngModelChange)="reloadPackages()" data-testid="filter-repository">
                  <option value="">All</option>
                  @for (key of repositoryKeys; track key) { <option [value]="key">{{ key }}</option> }
                </select>
              </label>
              <label class="dg-filter">
                <span>Status</span>
                <select class="dg-select" [(ngModel)]="status" (ngModelChange)="reloadPackages()" data-testid="filter-status">
                  @for (s of statusFilters; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
                </select>
              </label>
              <label class="dg-filter">
                <span>Last downloaded</span>
                <select class="dg-select" [(ngModel)]="lastSeenWithin" (ngModelChange)="onLastSeen()" data-testid="filter-last-seen">
                  <option value="7d">7 days</option>
                  <option value="30d">30 days</option>
                  <option value="90d">90 days</option>
                  <option value="all">All</option>
                </select>
              </label>
              <span class="dg-toolbar-spacer"></span>
              @if (canApprove && checked.size > 0) {
                <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="approveChecked()" data-testid="bulk-approve">
                  Approve {{ plural(checked.size, 'package') }}
                </button>
              }
            </div>

            @if (packagesLoading) {
              <div class="dg-loading"><span class="dg-spinner"></span></div>
            } @else if (packages.length === 0) {
              <app-empty-state icon="filter_alt_off" title="No packages match these filters" [compact]="true" />
            } @else {
              <div class="dg-table-wrap">
                <table class="dg-table" data-testid="monitor-packages">
                  <thead>
                    <tr>
                      @if (canApprove) {
                        <th style="width: 1%">
                          <input type="checkbox" class="form-check-input" [checked]="allChecked" (change)="toggleAll()" aria-label="Select every package on this page" />
                        </th>
                      }
                      <th style="width: 1%"><span class="visually-hidden">Expand</span></th>
                      <th>Package</th>
                      <th>Versions</th>
                      <th>Reason</th>
                      <th class="text-end">Downloads</th>
                      <th>Last downloaded</th>
                      <th>Status</th>
                      <th>Also matched by</th>
                      <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (pkg of packages; track key(pkg)) {
                      <tr [attr.data-testid]="'pkg-' + pkg.packageName">
                        @if (canApprove) {
                          <td>
                            <input type="checkbox" class="form-check-input" [checked]="checked.has(key(pkg))" (change)="toggle(pkg)"
                              [attr.aria-label]="'Select ' + pkg.packageName" />
                          </td>
                        }
                        <td>
                          <button type="button" class="dg-icon-btn" (click)="toggleExpand(pkg)" [attr.aria-expanded]="expanded.has(key(pkg))"
                            [attr.aria-label]="(expanded.has(key(pkg)) ? 'Hide versions of ' : 'Show versions of ') + pkg.packageName">
                            <span class="material-symbols-outlined">{{ expanded.has(key(pkg)) ? 'expand_less' : 'expand_more' }}</span>
                          </button>
                        </td>
                        <td class="mon-pkg">
                          <span class="dg-cell-primary">{{ pkg.packageName }}</span>
                          <app-eco-tag [ecosystem]="pkg.ecosystem" />
                          @if (pkg.repositories?.length) {
                            <span class="dg-cell-sub" data-testid="monitor-repositories">Seen on {{ pkg.repositories!.join(', ') }}</span>
                          }
                        </td>
                        <td class="col-nowrap">
                          {{ plural(pkg.versionCount, 'version') }}
                          @if (pkg.versionRange && pkg.versionCount > 1) {
                            <span class="dg-cell-sub">{{ pkg.versionRange.min }} – {{ pkg.versionRange.max }}</span>
                          } @else if (pkg.versionRange) {
                            <span class="dg-cell-sub">{{ pkg.versionRange.max }}</span>
                          }
                        </td>
                        <td>
                          <span class="dg-cell-primary">{{ label(pkg.reasonKey) }}</span>
                          @if (pkg.reasons[0]) { <span class="dg-cell-sub dg-cell-truncate" [title]="pkg.reasons.join('; ')">{{ pkg.reasons[0] }}</span> }
                        </td>
                        <td class="text-end">{{ pkg.downloads | number }}</td>
                        <td class="col-nowrap dg-text-variant">{{ pkg.lastSeenAt | date: 'MMM d, y' }}</td>
                        <td><app-status-pill [value]="pkg.status" [label]="view(pkg).label" [tone]="view(pkg).tone" /></td>
                        <td>
                          @for (other of pkg.alsoMatchedBy; track other.policyId) {
                            <a class="dg-chip mon-link" [routerLink]="['/monitoring', other.policyId]">{{ other.policyName }}</a>
                          } @empty {
                            <span class="dg-text-muted">—</span>
                          }
                        </td>
                        <td class="col-actions">
                          @if (canApprove && pkg.status !== 'approved') {
                            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="approve([pkg])" [attr.data-testid]="'approve-' + pkg.packageName">Approve</button>
                          }
                        </td>
                      </tr>
                      @if (expanded.has(key(pkg))) {
                        <tr class="mon-versions-row">
                          <td [attr.colspan]="canApprove ? 10 : 9">
                            <table class="dg-table mon-versions">
                              <thead>
                                <tr><th>Version</th><th>Reason</th><th class="text-end">Downloads</th><th>First seen</th><th>Last downloaded</th><th>Status</th><th></th></tr>
                              </thead>
                              <tbody>
                                @for (v of pkg.versions; track v.version) {
                                  <tr>
                                    <td class="font-mono">{{ v.version }}</td>
                                    <td><span class="dg-cell-truncate" [title]="v.reasons.join('; ')">{{ v.reasons.join('; ') || label(v.reasonKey) }}</span></td>
                                    <td class="text-end">{{ v.downloads | number }}</td>
                                    <td class="col-nowrap dg-text-variant">{{ v.firstSeenAt | date: 'MMM d, y' }}</td>
                                    <td class="col-nowrap dg-text-variant">{{ v.lastSeenAt | date: 'MMM d, y' }}</td>
                                    <td>
                                      @if (v.approved) {
                                        <app-status-pill value="approved" [label]="'Approved until ' + (v.approvedUntil | date: 'MMM d, y')" tone="success" />
                                      } @else {
                                        <app-status-pill value="blocked" label="Will be blocked" tone="danger" />
                                      }
                                    </td>
                                    <td class="col-actions">
                                      @if (canApprove && !v.approved) {
                                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="approveVersion(pkg, v.version)">Approve</button>
                                      }
                                    </td>
                                  </tr>
                                }
                              </tbody>
                            </table>
                            @if (pkg.versionCount > pkg.versions.length) {
                              <p class="dg-form-help mt-2 mb-0">Showing the newest {{ pkg.versions.length }} of {{ pkg.versionCount }} versions. Export one row per version for the rest.</p>
                            }
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
              <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="packages.length" storageKey="monitoring-packages" (pageChange)="onPage($event)" />
            }
            <p class="mon-footer">Packages nobody approves are blocked on Enforce. Developers who need one can request a waiver.</p>
          }
        </section>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .mon-back {
      display: inline-flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 0.8125rem; font-weight: 600;
      color: var(--color-on-surface-variant); text-decoration: none;
    }
    .mon-back .material-symbols-outlined { font-size: 18px; }
    .mon-back:hover { color: var(--brand-text); }
    .mon-more.dropdown-toggle::after { display: none; }
    .mon-reasons { padding: 0 16px 12px; display: flex; flex-direction: column; gap: 6px; }
    .mon-reasons-head { display: flex; align-items: center; justify-content: space-between; min-height: 30px; }
    .mon-reason { display: flex; align-items: center; gap: 8px; }
    .mon-reason-main {
      flex: 1 1 auto; display: grid; grid-template-columns: minmax(120px, 220px) minmax(80px, 1fr) auto; align-items: center; gap: 12px;
      padding: 6px 10px; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface-container-lowest);
      text-align: left; cursor: pointer; font-size: 0.8125rem;
    }
    .mon-reason-main:hover { border-color: var(--brand); }
    .mon-reason.is-active .mon-reason-main { border-color: var(--brand); background: var(--brand-soft); }
    .mon-reason-label { font-weight: 600; color: var(--color-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mon-reason-bar { height: 8px; border-radius: 999px; background: var(--color-surface-container); overflow: hidden; }
    .mon-reason-bar > span { display: block; height: 100%; background: var(--brand); border-radius: 999px; }
    .mon-reason-count { color: var(--color-on-surface-variant); white-space: nowrap; }
    .mon-pkg { min-width: 160px; }
    .mon-link { text-decoration: none; margin: 0 4px 4px 0; }
    .mon-link:hover { border-color: var(--brand); }
    .mon-versions-row > td { background: var(--color-surface-container-low); }
    .mon-versions { background: var(--color-surface-container-lowest); }
    .mon-footer { margin: 0; padding: 12px 16px 16px; font-size: 0.8125rem; color: var(--color-on-surface-variant); }
    @media (max-width: 640px) {
      .mon-reason-main { grid-template-columns: 1fr; gap: 4px; }
    }
  `],
})
export class MonitoringDetailComponent implements OnInit {
  policyId = '';
  policy: MonitorPolicy | null = null;
  notFound = false;

  reasons: ReasonGroup[] = [];
  packages: MonitorPackage[] = [];
  packagesLoading = false;
  total = 0;
  offset = 0;
  limit = savedPageSize('monitoring-packages', PAGE_SIZE);

  reasonKey = '';
  ecosystem = '';
  status: MonitorStatusFilter = 'will_block';
  lastSeenWithin: LastSeenWithin = 'all';
  search = '';
  /** Repository key downloads were seen on. */
  repository = '';
  repositoryKeys: string[] = [];

  expanded = new Set<string>();
  checked = new Set<string>();

  readonly ecosystems = ECOSYSTEMS;
  readonly statusFilters = STATUS_FILTERS;
  readonly plural = plural;

  private monitor = inject(MonitorService);
  private actions = inject(MonitorActionsService);
  private crumbs = inject(BreadcrumbService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private destroyRef = inject(DestroyRef);
  private repositories = inject(RepositoryService);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  retryingRecheck = false;

  ngOnInit(): void {
    this.repositories.list().subscribe({
      next: (rows) => (this.repositoryKeys = [...new Set(rows.map((row) => row.key))].sort()),
      error: () => undefined,
    });
    this.destroyRef.onDestroy(() => {
      this.stopPolling();
      this.crumbs.detail.set(null);
    });
    // "Also matched by" links reuse this component for another policy.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.policyId = params.get('id') ?? '';
      this.policy = null;
      this.notFound = false;
      this.resetFilters();
      this.loadPolicy(true);
    });
  }

  get readOnly(): boolean {
    return this.policy?.mode !== 'monitor';
  }

  get rule(): PolicyRule | null {
    return policyRule(this.policy?.conditions);
  }

  get summary() {
    return ruleSummary(this.policy?.conditions);
  }

  get days(): number {
    return daysSince(this.policy?.modeChangedAt);
  }

  /** Approve is offered for Packages, License and Vulnerability rules, never for release age or type (MON-E3). */
  get canApprove(): boolean {
    return !!this.policy && !this.readOnly && approvalChoices(this.rule) !== null;
  }

  get allChecked(): boolean {
    return this.packages.length > 0 && this.packages.every((pkg) => this.checked.has(this.key(pkg)));
  }

  label(reasonKey: string): string {
    return reasonLabel(reasonKey, this.rule);
  }

  suggestion(reasonKey: string): string {
    return this.policy ? suggestionText(this.rule, reasonKey, this.policy.conditions) : '';
  }

  ecoLabel(eco: string): string {
    return ecosystemLabel(eco);
  }

  view(pkg: MonitorPackage): { label: string; tone: Tone } {
    return statusView(pkg);
  }

  key(pkg: Pick<MonitorPackage, 'ecosystem' | 'packageName'>): string {
    return `${pkg.ecosystem}\u0000${pkg.packageName}`;
  }

  private resetFilters(): void {
    this.reasonKey = '';
    this.ecosystem = '';
    this.status = 'will_block';
    this.lastSeenWithin = 'all';
    this.search = '';
    this.repository = '';
    this.offset = 0;
    this.reasons = [];
    this.packages = [];
    this.total = 0;
    this.expanded.clear();
    this.checked.clear();
  }

  loadPolicy(reloadReport = true): void {
    const id = this.policyId;
    this.monitor.policy(id).subscribe({
      next: (policy) => {
        if (id !== this.policyId) return;
        this.policy = policy;
        this.crumbs.detail.set(policy.name);
        if (reloadReport) this.loadReport();
        this.schedulePoll();
      },
      error: (err) => {
        if (err.status === 404) {
          this.notFound = true;
          this.crumbs.detail.set(null);
          return;
        }
        this.toast.error(err.error?.error ?? 'Failed to load the policy');
      },
    });
  }

  retryRecheck(): void {
    this.retryingRecheck = true;
    this.monitor.recheck(this.policyId).subscribe({
      next: () => {
        this.retryingRecheck = false;
        if (this.policy) this.policy = { ...this.policy, rechecking: true, recheckFailed: false, recheckProgress: null };
        this.schedulePoll();
      },
      error: (err) => {
        this.retryingRecheck = false;
        this.toast.error(err.error?.error ?? 'Could not start the recheck');
      },
    });
  }

  /** While a recheck runs, refresh until it finishes, then reload the report. */
  private schedulePoll(): void {
    this.stopPolling();
    if (!this.policy?.rechecking) return;
    this.pollTimer = setTimeout(() => {
      this.monitor.policy(this.policyId).subscribe((policy) => {
        const finished = !policy.rechecking;
        this.policy = policy;
        if (finished) this.loadReport();
        this.schedulePoll();
      });
    }, RECHECK_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  loadReport(): void {
    if (!this.policy) return;
    this.monitor.reasons(this.policyId, this.lastSeenWithin).subscribe({
      next: (res) => (this.reasons = res.items),
      error: () => (this.reasons = []),
    });
    this.loadPackages();
  }

  private query(): PackageQuery {
    return {
      policyId: this.policyId,
      reasonKey: this.reasonKey || undefined,
      ecosystem: this.ecosystem || undefined,
      status: this.status,
      lastSeenWithin: this.lastSeenWithin,
      search: this.search || undefined,
      repository: this.repository || undefined,
      sort: 'downloads',
      limit: this.limit,
      offset: this.offset,
    };
  }

  loadPackages(): void {
    if (!this.policyId) return;
    this.packagesLoading = true;
    this.monitor.packages(this.query()).subscribe({
      next: (page) => {
        this.packages = page.items;
        this.total = page.total;
        this.packagesLoading = false;
      },
      error: (err) => {
        this.packagesLoading = false;
        this.toast.error(err.error?.error ?? 'Failed to load packages');
      },
    });
  }

  reloadPackages(): void {
    this.offset = 0;
    this.checked.clear();
    this.loadPackages();
  }

  setReason(reasonKey: string): void {
    this.reasonKey = this.reasonKey === reasonKey ? '' : reasonKey;
    this.reloadPackages();
  }

  onLastSeen(): void {
    this.loadReport();
    this.reloadPackages();
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.loadPackages();
  }

  toggleExpand(pkg: MonitorPackage): void {
    const k = this.key(pkg);
    if (this.expanded.has(k)) this.expanded.delete(k);
    else this.expanded.add(k);
  }

  toggle(pkg: MonitorPackage): void {
    const k = this.key(pkg);
    if (this.checked.has(k)) this.checked.delete(k);
    else this.checked.add(k);
  }

  toggleAll(): void {
    if (this.allChecked) this.checked.clear();
    else for (const pkg of this.packages) this.checked.add(this.key(pkg));
  }

  approveChecked(): void {
    this.approve(this.packages.filter((pkg) => this.checked.has(this.key(pkg))));
  }

  approveVersion(pkg: MonitorPackage, version: string): void {
    const only = pkg.versions.filter((v) => v.version === version);
    this.approve([{ ...pkg, versions: only, versionCount: 1, versionRange: { min: version, max: version } }]);
  }

  approve(packages: MonitorPackage[]): void {
    const policy = this.policy;
    if (!policy || packages.length === 0) return;
    const data: ApproveDialogData = { policy, packages };
    const ref = this.modal.open(ApproveDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: data }], parent: this.injector }),
    });
    ref.closed.subscribe((done) => {
      if (!done) return;
      this.checked.clear();
      this.loadPolicy(true);
    });
  }

  async enforce(): Promise<void> {
    if (this.policy && (await this.actions.enforce(this.policy))) this.loadPolicy(true);
  }

  async restart(): Promise<void> {
    if (!this.policy || !(await this.actions.restart(this.policy))) return;
    this.resetFilters();
    this.loadPolicy(true);
  }

  editPolicy(): void {
    this.actions.editRule(this.policyId);
  }

  editRule(group: ReasonGroup): void {
    this.actions.editRule(this.policyId, { reasonKey: group.reasonKey });
  }

  exportShown(granularity: 'package' | 'version'): void {
    const p = this.policy;
    if (!p) return;
    // The service drops limit and offset: the file has every row the filters match.
    this.monitor.exportCsv(this.query(), granularity).subscribe({
      next: (blob) => {
        const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'policy';
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = timestampedName(`depgate-monitoring-${slug}`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      },
      error: () => this.toast.error('Export failed'),
    });
  }
}
