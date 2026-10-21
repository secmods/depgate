import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { AccountService, ServiceAccount } from '../../services/account.service';
import { ApiKey, ApiKeyService } from '../../services/api-key.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { CreateServiceAccountDialogComponent } from './create-service-account-dialog.component';

/** Access → Service accounts: credentials CI uses to mint download tokens that last at most 1 day. */
@Component({
  selector: 'app-service-accounts-tab',
  standalone: true,
  imports: [DatePipe, EmptyStateComponent, StatusPillComponent, PaginationComponent, SearchInputComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Service accounts</h2>
          <span class="dg-card-hint">Keys for CI. Their tokens last up to 1 day and cannot sign in or change policy.</span>
        </div>
        <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="openCreate()">
          <span class="material-symbols-outlined">add</span> Add service account
        </button>
      </div>
      @if (total > 0 || search) {
        <div class="dg-toolbar">
          <app-search-input placeholder="Search by name" [(value)]="search" (search)="applySearch()" />
        </div>
      }
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else if (serviceAccounts.length === 0 && search) {
        <app-empty-state icon="search_off" title="No service accounts match" [description]="noMatch" [compact]="true" />
      } @else if (serviceAccounts.length === 0) {
        <app-empty-state icon="smart_toy" title="No service accounts" description="Create one for each CI system that installs packages through DepGate." [compact]="true" />
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table">
            <thead><tr><th>Name</th><th>Last used</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (row of serviceAccounts; track row.id) {
                <tr>
                  <td><span class="dg-cell-primary">{{ row.name }}</span></td>
                  <td class="dg-text-variant">{{ row.lastUsedAt ? (row.lastUsedAt | date: 'medium') : 'Never' }}</td>
                  <td class="col-actions">
                    <button type="button" class="dg-icon-btn is-danger" (click)="remove(row)" title="Delete service account" aria-label="Delete service account">
                      <span class="material-symbols-outlined">delete</span>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="serviceAccounts.length" storageKey="access-service-accounts" (pageChange)="onPage($event)" />
      }
    </section>

    @if (legacyKeys.length > 0) {
      <section class="dg-card">
        <div class="dg-card-header">
          <div>
            <h2 class="dg-card-title">Legacy API keys</h2>
            <span class="dg-card-hint">Created before service accounts. Revoke them; no new ones can be created.</span>
          </div>
        </div>
        <div class="dg-table-wrap">
          <table class="dg-table">
            <thead><tr><th>Name</th><th>Role</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (row of legacyKeys; track row.id) {
                <tr>
                  <td><span class="dg-cell-primary">{{ row.name }}</span></td>
                  <td><app-status-pill [value]="row.role" tone="neutral" [label]="row.role" /></td>
                  <td class="col-actions">
                    <button type="button" class="dg-btn dg-btn-danger-outline dg-btn-sm" (click)="revokeLegacyKey(row)">Revoke</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    }
  `,
})
export class ServiceAccountsTabComponent implements OnInit {
  serviceAccounts: ServiceAccount[] = [];
  total = 0;
  offset = 0;
  limit = savedPageSize('access-service-accounts', 20);
  search = '';
  legacyKeys: ApiKey[] = [];
  loading = true;

  private accounts = inject(AccountService);
  private apiKeys = inject(ApiKeyService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private confirm = inject(ConfirmService);

  get noMatch(): string {
    return `No name contains “${this.search.trim()}”.`;
  }

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.accounts.listServiceAccounts({ limit: this.limit, offset: this.offset, search: this.search.trim() }).subscribe({
      next: (page) => {
        if (page.total > 0 && this.offset >= page.total) {
          this.offset = Math.floor((page.total - 1) / this.limit) * this.limit;
          this.load();
          return;
        }
        this.serviceAccounts = page.items;
        this.total = page.total;
        this.loading = false;
      },
      error: (err) => { this.loading = false; this.toast.error(err.error?.error ?? 'Failed to load service accounts'); },
    });
    this.apiKeys.list().subscribe({
      next: (list) => (this.legacyKeys = list.filter((key) => key.role !== 'ServiceAccount')),
      error: () => (this.legacyKeys = []),
    });
  }

  applySearch(): void {
    this.offset = 0;
    this.load();
  }

  onPage(change: PageChange): void {
    this.offset = change.offset;
    this.limit = change.limit;
    this.load();
  }

  openCreate(): void {
    const ref = this.modal.open(CreateServiceAccountDialogComponent);
    ref.closed.subscribe(() => this.load());
  }

  async remove(row: ServiceAccount): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete service account?',
      message: `CI jobs using ${row.name} will fail to get new tokens.`,
      confirmText: 'Delete service account',
    });
    if (!ok) return;
    this.accounts.deleteServiceAccount(row.id).subscribe({
      next: () => { this.toast.success('Service account deleted'); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }

  async revokeLegacyKey(row: ApiKey): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Revoke API key?',
      message: `Clients using "${row.name}" will be rejected immediately.`,
      confirmText: 'Revoke key',
    });
    if (!ok) return;
    this.apiKeys.delete(row.id).subscribe({
      next: () => { this.toast.success(`Revoked "${row.name}"`); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Revoke failed'),
    });
  }
}
