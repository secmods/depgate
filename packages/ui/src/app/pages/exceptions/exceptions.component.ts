import { Component, OnInit, inject, Injector, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { RouterLink } from '@angular/router';
import { ExceptionService, ExceptionEntry } from '../../services/exception.service';
import { ToastService } from '../../services/toast.service';
import { AuthService } from '../../services/auth.service';
import { WaiverRequest, WaiverService, WaiverStatus } from '../../services/waiver.service';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS, ecosystemLabel } from '../../shared/status';
import { AddExceptionDialogComponent } from './add-exception-dialog.component';
import { ExceptionDetailDialogComponent } from './exception-detail-dialog.component';
import { ReviewWaiverDialogComponent } from './review-waiver-dialog.component';
import { MODAL_DATA } from '../../tokens';

@Component({
  selector: 'app-exceptions',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, FormsModule, RouterLink, EcoTagComponent, EmptyStateComponent, PaginationComponent,
    SearchInputComponent, StatusPillComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Exceptions</h1>
          <p class="dg-page-subtitle">Temporary overrides that allow a blocked package, and the waiver requests behind them.</p>
        </div>
        @if (canManage && tab === 'exceptions') {
          <div class="dg-page-actions">
            <button type="button" class="dg-btn dg-btn-primary" (click)="openAddDialog()">
              <span class="material-symbols-outlined">add</span> Add exception
            </button>
          </div>
        }
      </header>

      @if (canManage) {
        <nav class="dg-tabs" role="tablist">
          <button type="button" class="dg-tab" role="tab" [class.is-active]="tab === 'exceptions'" [attr.aria-selected]="tab === 'exceptions'" (click)="tab = 'exceptions'">
            <span class="material-symbols-outlined">rule</span> Exceptions
          </button>
          <button type="button" class="dg-tab" role="tab" [class.is-active]="tab === 'waivers'" [attr.aria-selected]="tab === 'waivers'" (click)="openWaivers()">
            <span class="material-symbols-outlined">approval</span> Waiver requests
            @if (pendingWaivers > 0) {
              <span class="dg-tab-badge" [attr.aria-label]="pendingWaivers + ' pending'">{{ pendingWaivers }}</span>
            }
          </button>
        </nav>
      }

      @if (tab === 'exceptions') {
        <div class="dg-stats">
          <div class="dg-stat">
            <div>
              <div class="dg-stat-label">Total</div>
              <div class="dg-stat-value">{{ exceptionTotal | number }}</div>
              <div class="dg-stat-meta">Matching the filters</div>
            </div>
            <span class="dg-stat-icon tone-brand"><span class="material-symbols-outlined">rule</span></span>
          </div>
          <div class="dg-stat">
            <div>
              <div class="dg-stat-label">Active</div>
              <div class="dg-stat-value">{{ activeTotal | number }}</div>
              <div class="dg-stat-meta">Currently allowing packages</div>
            </div>
            <span class="dg-stat-icon tone-success"><span class="material-symbols-outlined">check_circle</span></span>
          </div>
          <div class="dg-stat">
            <div>
              <div class="dg-stat-label">Expired</div>
              <div class="dg-stat-value">{{ expiredTotal | number }}</div>
              <div class="dg-stat-meta">No longer applied</div>
            </div>
            <span class="dg-stat-icon tone-neutral"><span class="material-symbols-outlined">history</span></span>
          </div>
        </div>

        <section class="dg-card">
          <div class="dg-toolbar">
            <app-search-input placeholder="Search by package name" [(value)]="packageFilter" (search)="search()" />
            <label class="dg-filter">
              <span>Ecosystem</span>
              <select class="dg-select" [(ngModel)]="ecosystem" (ngModelChange)="search()">
                <option value="">All</option>
                @for (e of ecosystems; track e) { <option [value]="e">{{ label(e) }}</option> }
              </select>
            </label>
            <label class="dg-filter">
              <span>Status</span>
              <select class="dg-select" [(ngModel)]="expiredFilter" (ngModelChange)="search()">
                <option value="">All</option>
                <option value="false">Active</option>
                <option value="true">Expired</option>
              </select>
            </label>
            <label class="dg-filter">
              <span>Applies to</span>
              <select class="dg-select" [(ngModel)]="appliesTo" (ngModelChange)="search()" data-testid="filter-applies-to">
                <option value="all">Every policy</option>
                <option value="scoped">One policy (approvals)</option>
                <option value="any">Both</option>
              </select>
            </label>
          </div>

          @if (loading) {
            <div class="dg-loading"><span class="dg-spinner"></span></div>
          } @else if (items.length === 0) {
            <app-empty-state icon="rule" title="No exceptions match these filters"
              description="An exception allows one package, or a range of its versions, until it expires." />
          } @else {
            <div class="dg-table-wrap">
              <table class="dg-table">
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>Ecosystem</th>
                    <th>Status</th>
                    @if (appliesTo !== 'all') { <th>Applies to</th> }
                    <th>Repositories</th>
                    <th>Expires</th>
                    <th>Approved by</th>
                    <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of items; track row.id) {
                    <tr class="is-clickable" (click)="viewException(row)">
                      <td>
                        <span class="dg-cell-primary">{{ row.packageName }}</span>
                        <span class="dg-tag ms-2">{{ row.version || '*' }}</span>
                      </td>
                      <td><app-eco-tag [ecosystem]="row.ecosystem" /></td>
                      <td><app-status-pill [value]="isExpired(row) ? 'EXPIRED' : 'ACTIVE'" /></td>
                      @if (appliesTo !== 'all') {
                        <td>
                          @if (row.policyId) {
                            <a class="dg-chip text-decoration-none" [routerLink]="['/monitoring', row.policyId]"
                              (click)="$event.stopPropagation()">{{ row.policyName || 'Policy' }}</a>
                          } @else {
                            <span class="dg-text-variant">Every policy</span>
                          }
                        </td>
                      }
                      <td [attr.data-testid]="'exception-scope-' + row.id">
                        @for (ref of row.repositories ?? []; track ref.id) {
                          <span class="dg-chip dg-chip-accent">{{ ref.ecosystem }}/{{ ref.key }}</span>
                        } @empty {
                          <span class="dg-text-muted text-xs">All repositories</span>
                        }
                      </td>
                      <td class="col-nowrap" [class.dg-text-muted]="isExpired(row)">{{ row.expiresAt | date: 'MMM d, y, HH:mm' }}</td>
                      <td>{{ row.approvedBy || '—' }}</td>
                      <td class="col-actions">
                        <button type="button" class="dg-icon-btn" (click)="$event.stopPropagation(); viewException(row)" title="View details" aria-label="View details">
                          <span class="material-symbols-outlined">visibility</span>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          <app-pagination [offset]="exceptionOffset" [limit]="exceptionLimit" [total]="exceptionTotal" [count]="items.length" storageKey="exceptions" (pageChange)="onExceptionPage($event)" />
        </section>
      }

      @if (tab === 'waivers') {
        <section class="dg-card">
          <div class="dg-toolbar">
            <app-search-input placeholder="Search by package name" [(value)]="waiverPackage" (search)="reloadWaivers()" />
            <label class="dg-filter">
              <span>Status</span>
              <select class="dg-select" [ngModel]="waiverStatus" (ngModelChange)="onWaiverStatus($event)">
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="">All</option>
              </select>
            </label>
            <span class="dg-toolbar-spacer"></span>
            <span class="dg-card-hint">You set the expiry when approving.</span>
          </div>

          @if (waiverLoading) {
            <div class="dg-loading"><span class="dg-spinner"></span></div>
          } @else if (waivers.length === 0) {
            <app-empty-state icon="approval" [title]="waiverStatus === 'pending' ? 'No requests waiting for review' : 'No waiver requests match these filters'"
              description="Users submit requests from their Waiver requests page when a package they need is blocked." />
          } @else {
            <div class="dg-table-wrap">
              <table class="dg-table">
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>Ecosystem</th>
                    <th>Requested by</th>
                    <th>Requested expiry</th>
                    <th>Submitted</th>
                    <th>Status</th>
                    <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of waivers; track row.id) {
                    <tr class="is-clickable" (click)="viewWaiver(row)">
                      <td>
                        <span class="dg-cell-primary">{{ row.packageName }}</span>
                        <span class="dg-tag ms-2">{{ row.version || '*' }}</span>
                      </td>
                      <td><app-eco-tag [ecosystem]="row.ecosystem" /></td>
                      <td>{{ row.requestedBy }}</td>
                      <td class="col-nowrap">{{ row.requestedExpiresAt | date: 'MMM d, y' }}</td>
                      <td class="col-nowrap dg-text-variant">{{ row.createdAt | date: 'MMM d, y, HH:mm' }}</td>
                      <td><app-status-pill [value]="row.status" /></td>
                      <td class="col-actions">
                        @if (row.status === 'pending') {
                          <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="$event.stopPropagation(); viewWaiver(row)">Review</button>
                        } @else {
                          <button type="button" class="dg-icon-btn" (click)="$event.stopPropagation(); viewWaiver(row)" title="View details" aria-label="View details">
                            <span class="material-symbols-outlined">visibility</span>
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          <app-pagination [offset]="waiverOffset" [limit]="waiverLimit" [total]="waiverTotal" [count]="waivers.length" storageKey="exception-waivers" (pageChange)="onWaiverPage($event)" />
        </section>
      }
    </div>
  `,
})
export class ExceptionsComponent implements OnInit {
  items: ExceptionEntry[] = [];
  waivers: WaiverRequest[] = [];
  ecosystems = ECOSYSTEMS;
  ecosystem = '';
  expiredFilter: '' | 'true' | 'false' = '';
  /** Exceptions for every policy by default; approvals from the Monitoring page are scoped to one. */
  appliesTo: 'all' | 'scoped' | 'any' = 'all';
  packageFilter = '';
  waiverPackage = '';
  waiverStatus: '' | WaiverStatus = 'pending';
  tab: 'exceptions' | 'waivers' = 'exceptions';
  exceptionLimit = savedPageSize('exceptions', 20);
  waiverLimit = savedPageSize('exception-waivers', 20);
  exceptionOffset = 0;
  exceptionTotal = 0;
  activeTotal = 0;
  expiredTotal = 0;
  waiverOffset = 0;
  waiverTotal = 0;
  pendingWaivers = 0;
  loading = false;
  waiverLoading = false;

  private exceptionService = inject(ExceptionService);
  private waiverService = inject(WaiverService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);

  get canManage(): boolean {
    return this.auth.isSecurity();
  }

  ngOnInit(): void {
    this.load();
    this.refreshPendingWaivers();
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  search(): void {
    this.exceptionOffset = 0;
    this.load();
  }

  onExceptionPage(change: PageChange): void {
    this.exceptionOffset = change.offset;
    this.exceptionLimit = change.limit;
    this.load();
  }

  openWaivers(): void {
    this.tab = 'waivers';
    this.loadWaivers();
  }

  load(): void {
    this.loading = true;
    this.exceptionService.list({
      ecosystem: this.ecosystem || undefined,
      package: this.packageFilter || undefined,
      expired: this.expiredFilter || undefined,
      appliesTo: this.appliesTo,
      limit: this.exceptionLimit,
      offset: this.exceptionOffset,
    }).subscribe({
      next: (page) => {
        if (page.total > 0 && this.exceptionOffset >= page.total) {
          this.exceptionOffset = Math.floor((page.total - 1) / this.exceptionLimit) * this.exceptionLimit;
          this.load();
          return;
        }
        this.items = page.items;
        this.exceptionTotal = page.total;
        this.activeTotal = page.active;
        this.expiredTotal = page.expired;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load exceptions');
      },
    });
  }

  onWaiverStatus(status: '' | WaiverStatus): void {
    this.waiverStatus = status;
    this.reloadWaivers();
  }

  reloadWaivers(): void {
    this.waiverOffset = 0;
    this.loadWaivers();
  }

  onWaiverPage(change: PageChange): void {
    this.waiverOffset = change.offset;
    this.waiverLimit = change.limit;
    this.loadWaivers();
  }

  loadWaivers(): void {
    if (!this.canManage) return;
    this.waiverLoading = true;
    this.waiverService.list({
      status: this.waiverStatus || undefined,
      package: this.waiverPackage || undefined,
      limit: this.waiverLimit,
      offset: this.waiverOffset,
    }).subscribe({
      next: (page) => {
        if (page.total > 0 && this.waiverOffset >= page.total) {
          this.waiverOffset = Math.floor((page.total - 1) / this.waiverLimit) * this.waiverLimit;
          this.loadWaivers();
          return;
        }
        this.waivers = page.items;
        this.waiverTotal = page.total;
        this.waiverLoading = false;
      },
      error: (err) => {
        this.waiverLoading = false;
        this.toast.error(err.error?.error ?? 'Failed to load waiver requests');
      },
    });
  }

  refreshPendingWaivers(): void {
    if (!this.canManage) return;
    this.waiverService.list({ status: 'pending', limit: 1, offset: 0 }).subscribe({
      next: (page) => { this.pendingWaivers = page.total; },
    });
  }

  isExpired(row: ExceptionEntry): boolean {
    return new Date(row.expiresAt) <= new Date();
  }

  viewException(row: ExceptionEntry): void {
    const ref = this.modal.open(ExceptionDetailDialogComponent, {
      injector: Injector.create({
        providers: [{ provide: MODAL_DATA, useValue: { entry: row, canRevoke: this.canManage } }],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((action: 'revoked' | undefined) => {
      if (action !== 'revoked') return;
      this.toast.success(`Revoked the exception for ${row.packageName}`);
      this.load();
    });
  }

  viewWaiver(row: WaiverRequest): void {
    const ref = this.modal.open(ReviewWaiverDialogComponent, {
      injector: Injector.create({
        providers: [{ provide: MODAL_DATA, useValue: { request: row } }],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((action: 'approve' | 'reject' | undefined) => {
      if (action !== 'approve' && action !== 'reject') return;
      this.toast.success(action === 'approve' ? `Approved the waiver for ${row.packageName}` : `Rejected the waiver for ${row.packageName}`);
      this.loadWaivers();
      this.refreshPendingWaivers();
      if (action === 'approve') this.load();
    });
  }

  openAddDialog(): void {
    const ref = this.modal.open(AddExceptionDialogComponent, {
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: { ecosystems: [...ECOSYSTEMS] } }], parent: this.injector }),
    });
    ref.closed.subscribe((created) => {
      if (created) {
        this.toast.success('Exception added');
        this.load();
      }
    });
  }
}
