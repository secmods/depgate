import { Component, OnInit, inject, Injector, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { WaiverRequest, WaiverService, WaiverStatus } from '../../services/waiver.service';
import { RequestWaiverDialogComponent } from './request-waiver-dialog.component';
import { ReviewWaiverDialogComponent } from '../exceptions/review-waiver-dialog.component';
import { MODAL_DATA } from '../../tokens';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS } from '../../shared/status';

@Component({
  selector: 'app-waivers',
  standalone: true,
  imports: [DatePipe, FormsModule, EcoTagComponent, EmptyStateComponent, PaginationComponent, StatusPillComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Waiver requests</h1>
          <p class="dg-page-subtitle">Ask security to allow a blocked package for a limited time. You can edit or withdraw a request until it is approved.</p>
        </div>
        <div class="dg-page-actions">
          <button type="button" class="dg-btn dg-btn-primary" (click)="openRequestDialog()">
            <span class="material-symbols-outlined">add</span> Request waiver
          </button>
        </div>
      </header>

      <section class="dg-card">
        <div class="dg-toolbar">
          <label class="dg-filter">
            <span>Status</span>
            <select class="dg-select" [ngModel]="statusFilter" (ngModelChange)="onStatus($event)">
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </label>
        </div>

        @if (loading) {
          <div class="dg-loading"><span class="dg-spinner"></span></div>
        } @else if (items.length === 0) {
          <app-empty-state icon="approval" [title]="statusFilter ? 'No requests with this status' : 'No waiver requests yet'"
            description="Request a waiver when a package you need is blocked by policy.">
            @if (!statusFilter) {
              <button type="button" class="dg-btn dg-btn-primary" (click)="openRequestDialog()">
                <span class="material-symbols-outlined">add</span> Request waiver
              </button>
            }
          </app-empty-state>
        } @else {
          <div class="dg-table-wrap">
            <table class="dg-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Ecosystem</th>
                  <th>Requested expiry</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th class="col-actions"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (row of items; track row.id) {
                  <tr class="is-clickable" (click)="viewWaiver(row)">
                    <td>
                      <span class="dg-cell-primary">{{ row.packageName }}</span>
                      <span class="dg-tag ms-2">{{ row.version || '*' }}</span>
                    </td>
                    <td><app-eco-tag [ecosystem]="row.ecosystem" /></td>
                    <td class="col-nowrap">{{ row.requestedExpiresAt | date: 'MMM d, y' }}</td>
                    <td class="col-nowrap dg-text-variant">{{ row.createdAt | date: 'MMM d, y, HH:mm' }}</td>
                    <td><app-status-pill [value]="row.status" /></td>
                    <td class="col-actions">
                      <button type="button" class="dg-icon-btn" (click)="$event.stopPropagation(); viewWaiver(row)" title="View details" aria-label="View details">
                        <span class="material-symbols-outlined">visibility</span>
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="items.length" storageKey="waivers" (pageChange)="onPage($event)" />
      </section>
    </div>
  `,
})
export class WaiversComponent implements OnInit {
  items: WaiverRequest[] = [];
  statusFilter: '' | WaiverStatus = '';
  loading = false;
  limit = savedPageSize('waivers', 20);
  offset = 0;
  total = 0;

  private auth = inject(AuthService);
  private router = inject(Router);
  private waiverService = inject(WaiverService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);

  ngOnInit(): void {
    // The route guard already keeps everyone but Users out; a lost session must not redirect to
    // another page, or the sign-in page would carry that page as its returnUrl.
    if (!this.auth.isUser()) return;
    this.load();
  }

  onStatus(status: '' | WaiverStatus): void {
    this.statusFilter = status;
    this.offset = 0;
    this.load();
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  load(): void {
    this.loading = true;
    this.waiverService.list({ status: this.statusFilter || undefined, limit: this.limit, offset: this.offset }).subscribe({
      next: (page) => {
        if (page.total > 0 && this.offset >= page.total) {
          this.offset = Math.floor((page.total - 1) / this.limit) * this.limit;
          this.load();
          return;
        }
        this.items = page.items;
        this.total = page.total;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Failed to load waiver requests');
      },
    });
  }

  viewWaiver(row: WaiverRequest): void {
    const ref = this.modal.open(ReviewWaiverDialogComponent, {
      injector: Injector.create({
        providers: [{ provide: MODAL_DATA, useValue: { request: row, readOnly: true, ownerActions: true } }],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((action: 'edit' | 'deleted' | undefined) => {
      if (action === 'edit') this.openEditDialog(row);
      if (action === 'deleted') {
        this.toast.success(`Withdrew the request for ${row.packageName}`);
        this.load();
      }
    });
  }

  openRequestDialog(): void {
    this.openDialog(null);
  }

  openEditDialog(row: WaiverRequest): void {
    this.openDialog(row);
  }

  private openDialog(waiver: WaiverRequest | null): void {
    const ref = this.modal.open(RequestWaiverDialogComponent, {
      injector: Injector.create({
        providers: [{ provide: MODAL_DATA, useValue: { ecosystems: [...ECOSYSTEMS], waiver } }],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((saved) => {
      if (saved) {
        this.toast.success(waiver ? 'Request updated' : 'Request submitted for review');
        this.load();
      }
    });
  }
}
