import { Component, EventEmitter, OnInit, Output, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbDropdownModule, NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { FormsModule } from '@angular/forms';
import { AccountService, AccountUser, UserListQuery } from '../../services/account.service';
import { AuthService } from '../../services/auth.service';
import { SigninSettings, SsoService } from '../../services/sso.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { PageChange, PaginationComponent, savedPageSize } from '../../shared/pagination.component';
import { SearchInputComponent } from '../../shared/search-input.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { CreateUserDialogComponent } from './create-user-dialog.component';

/** Access → Users: the people who can sign in, their role and status (requirements_sso.md R15–R17). */
@Component({
  selector: 'app-users-tab',
  standalone: true,
  imports: [DatePipe, FormsModule, NgbDropdownModule, StatusPillComponent, PaginationComponent, SearchInputComponent, EmptyStateComponent],
  styles: [`
    .you { margin-left: 8px; }
    .user-more.dropdown-toggle::after { display: none; }
    .link-btn { background: none; border: none; padding: 0; color: var(--brand-text, #4f46e5); font-weight: 600; cursor: pointer; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (signin) {
      <div class="dg-callout mb-3" role="status" data-testid="users-sso-status">
        <span class="material-symbols-outlined">key</span>
        <span>
          @if (signin.ssoEnabled) {
            Single sign-on is on for {{ signin.allowedDomains.join(', ') }}.
            {{ signin.allowUnlistedSso ? 'People not listed here join as User on their first sign-in.' : 'Only people listed here can sign in with it.' }}
          } @else {
            Single sign-on is off. People sign in with a password.
          }
          <button type="button" class="link-btn" (click)="openSso.emit()">Single sign-on settings</button>
        </span>
      </div>
    }

    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">People</h2>
          <span class="dg-card-hint">Users configure their registry and request waivers. Security manages the gateway.</span>
        </div>
        <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="openCreateUser()">
          <span class="material-symbols-outlined">person_add</span> Add user
        </button>
      </div>
      <div class="dg-toolbar">
        <app-search-input placeholder="Search by email" [(value)]="search" (search)="applySearch()" />
        <label class="dg-filter">
          <span>Type</span>
          <select class="dg-select" [(ngModel)]="source" (ngModelChange)="applySearch()" data-testid="users-filter-type">
            <option value="">All</option>
            <option value="local">Local</option>
            <option value="sso">SSO</option>
          </select>
        </label>
        <label class="dg-filter">
          <span>Role</span>
          <select class="dg-select" [(ngModel)]="role" (ngModelChange)="applySearch()" data-testid="users-filter-role">
            <option value="">All</option>
            <option value="User">User</option>
            <option value="Security">Security</option>
          </select>
        </label>
        <label class="dg-filter">
          <span>Status</span>
          <select class="dg-select" [(ngModel)]="status" (ngModelChange)="applySearch()" data-testid="users-filter-status">
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="disabled">Disabled</option>
          </select>
        </label>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else if (users.length === 0) {
        <app-empty-state icon="person_search" title="No people match" [description]="noMatch" [compact]="true" />
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table">
            <thead><tr><th>Email</th><th>Role</th><th>Sign-in</th><th>Status</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (row of users; track row.id) {
                <tr [attr.data-testid]="'user-row-' + row.email">
                  <td>
                    <span class="dg-cell-primary">{{ row.email }}</span>
                    @if (row.email === currentUsername) { <span class="dg-tag you">you</span> }
                    @if (row.source === 'sso') { <span class="dg-tag" title="Added on first single sign-on">SSO</span> }
                  </td>
                  <td><app-status-pill [value]="row.role" [tone]="row.role === 'Security' ? 'info' : 'neutral'" [label]="row.role" /></td>
                  <td class="dg-text-variant text-sm">
                    @if (row.lastLoginAt) {
                      {{ row.lastLoginAt | date: 'medium' }}
                      <span class="d-block text-xs">{{ loginMethodLabel(row) }}</span>
                    } @else {
                      Never
                    }
                    @if (row.signInMethods.length) {
                      <span class="d-block text-xs" [title]="'Can sign in with: ' + row.signInMethods.join(', ')">{{ row.signInMethods.join(' · ') }}</span>
                    }
                  </td>
                  <td>
                    @switch (row.status) {
                      @case ('disabled') { <app-status-pill value="disabled" tone="danger" label="Disabled" /> }
                      @case ('invited') { <app-status-pill value="invited" tone="warning" [label]="row.invitePending ? 'Invited' : 'Not signed in yet'" /> }
                      @default { <app-status-pill value="active" tone="success" label="Active" /> }
                    }
                  </td>
                  <td class="col-actions">
                    @if (row.email !== currentUsername) {
                      <div ngbDropdown class="d-inline-block" placement="bottom-end" container="body">
                        <button type="button" class="dg-icon-btn user-more" ngbDropdownToggle aria-label="User actions" title="User actions" [attr.data-testid]="'user-actions-' + row.email">
                          <span class="material-symbols-outlined">more_vert</span>
                        </button>
                        <div ngbDropdownMenu>
                          <button type="button" ngbDropdownItem (click)="changeRole(row)">{{ row.role === 'Security' ? 'Make User' : 'Make Security' }}</button>
                          <button type="button" ngbDropdownItem (click)="toggleDisabled(row)">{{ row.status === 'disabled' ? 'Enable' : 'Disable' }}</button>
                          <button type="button" ngbDropdownItem (click)="revokeSessions(row)">Sign out everywhere</button>
                          @if (!row.hasPassword && row.source !== 'sso' && row.status !== 'disabled') {
                            <button type="button" ngbDropdownItem (click)="resendInvite(row)">{{ row.invitePending ? 'Resend invitation' : 'Send password invitation' }}</button>
                          }
                          @if (row.hasPassword && row.source !== 'sso' && row.status !== 'disabled') {
                            <button type="button" ngbDropdownItem (click)="sendPasswordReset(row)">Send password reset</button>
                          }
                          <button type="button" ngbDropdownItem class="text-danger" (click)="deleteUser(row)">Delete</button>
                        </div>
                      </div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="users.length" storageKey="access-users" (pageChange)="onPage($event)" />
      }
    </section>
  `,
})
export class UsersTabComponent implements OnInit {
  /** Asks the page to switch to the Single sign-on tab. */
  @Output() openSso = new EventEmitter<void>();

  users: AccountUser[] = [];
  total = 0;
  offset = 0;
  limit = savedPageSize('access-users', 20);
  search = '';
  source: UserListQuery['source'] = '';
  role: UserListQuery['role'] = '';
  status: UserListQuery['status'] = '';
  loading = true;
  signin: SigninSettings | null = null;

  private auth = inject(AuthService);
  private accounts = inject(AccountService);
  private sso = inject(SsoService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private confirm = inject(ConfirmService);

  get noMatch(): string {
    const filtered = this.source || this.role || this.status;
    const search = this.search.trim();
    if (!search) return filtered ? 'Nobody matches these filters.' : 'No people yet.';
    return filtered ? `No email contains “${search}” with these filters.` : `No email contains “${search}”.`;
  }

  get currentUsername(): string | null {
    return this.auth.getUsername();
  }

  ngOnInit(): void {
    this.load();
    this.sso.signinSettings().subscribe({ next: (s) => (this.signin = s), error: () => (this.signin = null) });
  }

  load(): void {
    const query = { limit: this.limit, offset: this.offset, search: this.search.trim(), source: this.source, role: this.role, status: this.status };
    this.accounts.listUsers(query).subscribe({
      next: (page) => {
        // The last row of the last page was deleted: show the page before it.
        if (page.total > 0 && this.offset >= page.total) {
          this.offset = Math.floor((page.total - 1) / this.limit) * this.limit;
          this.load();
          return;
        }
        this.users = page.items;
        this.total = page.total;
        this.loading = false;
      },
      error: (err) => { this.loading = false; this.toast.error(err.error?.error ?? 'Failed to load users'); },
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

  openCreateUser(): void {
    const ref = this.modal.open(CreateUserDialogComponent);
    ref.closed.subscribe(() => this.load());
  }

  resendInvite(row: AccountUser): void {
    this.accounts.resendInvite(row.id).subscribe({
      next: (result) => {
        if (result.emailSent) {
          this.toast.success(`Invitation sent to ${row.email}`);
          this.load();
          return;
        }
        const ref = this.modal.open(CreateUserDialogComponent);
        (ref.componentInstance as CreateUserDialogComponent).result = result;
        ref.closed.subscribe(() => this.load());
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not resend the invitation'),
    });
  }

  async sendPasswordReset(row: AccountUser): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Send password reset?',
      message: `${row.email} gets an email with a link to choose a new password. Their current password keeps working until they use it; then they are signed out everywhere.`,
      confirmText: 'Send reset email',
      tone: 'primary',
    });
    if (!ok) return;
    this.accounts.sendPasswordReset(row.id).subscribe({
      next: (result) => this.toast.success(`Password reset email sent to ${result.sentTo}`),
      error: (err) => this.toast.error(err.error?.error ?? 'Could not send the password reset'),
    });
  }

  loginMethodLabel(row: AccountUser): string {
    if (row.lastLoginMethod === 'password') return 'with a password';
    if (row.lastLoginMethod) return `with ${row.lastLoginProvider ?? row.lastLoginMethod.toUpperCase()}`;
    return '';
  }

  async changeRole(row: AccountUser): Promise<void> {
    const role = row.role === 'Security' ? 'User' : 'Security';
    const ok = await this.confirm.confirm({
      title: `Make ${row.email} ${role}?`,
      message: role === 'Security'
        ? 'They get full access to policies, exceptions, settings and the ledger. They are signed out and get the new role at their next sign-in.'
        : 'They lose access to policies and settings. They are signed out and get the new role at their next sign-in.',
      confirmText: `Make ${role}`,
      tone: 'primary',
    });
    if (!ok) return;
    this.accounts.updateUser(row.id, { role }).subscribe({
      next: () => { this.toast.success(`${row.email} is now ${role}`); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not change the role'),
    });
  }

  async toggleDisabled(row: AccountUser): Promise<void> {
    const disable = row.status !== 'disabled';
    if (disable) {
      const ok = await this.confirm.confirm({
        title: 'Disable user?',
        message: `${row.email} cannot sign in by any method, and their sessions and registry tokens stop working now. Unlike deleting, single sign-on will not add them back.`,
        confirmText: 'Disable user',
      });
      if (!ok) return;
    }
    this.accounts.updateUser(row.id, { disabled: disable }).subscribe({
      next: () => { this.toast.success(disable ? `${row.email} disabled` : `${row.email} enabled`); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not change the user'),
    });
  }

  async revokeSessions(row: AccountUser): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Sign out everywhere?',
      message: `Every browser session and registry token of ${row.email} stops working. They can sign in again.`,
      confirmText: 'Sign out everywhere',
    });
    if (!ok) return;
    this.accounts.revokeSessions(row.id).subscribe({
      next: () => this.toast.success(`${row.email} signed out everywhere`),
      error: (err) => this.toast.error(err.error?.error ?? 'Could not sign the user out'),
    });
  }

  async deleteUser(row: AccountUser): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete user?',
      message: row.source === 'sso'
        ? `${row.email} will be signed out and lose access. Single sign-on adds them back as User at their next sign-in while unlisted people may sign in; disable them instead to keep them out.`
        : `${row.email} will be signed out and lose access. Their registry tokens stop working.`,
      confirmText: 'Delete user',
    });
    if (!ok) return;
    this.accounts.deleteUser(row.id).subscribe({
      next: () => { this.toast.success('User deleted'); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
}
