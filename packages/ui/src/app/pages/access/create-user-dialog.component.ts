import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { AccountService, InviteResult } from '../../services/account.service';
import { ToastService } from '../../services/toast.service';
import { SigninSettings, SsoService } from '../../services/sso.service';

@Component({
  selector: 'app-create-user-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ result ? 'Invitation created' : 'Add user' }}</h5>
        @if (!result) {
          <p class="dg-dialog-description">
            {{ sendInvite ? 'We email them a link to set their own password.' : 'They sign in with single sign-on. No email is sent.' }}
          </p>
        }
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="close()"></button>
    </div>

    @if (result) {
      <div class="modal-body">
        @if (result.emailSent) {
          <div class="dg-callout is-success" role="status">
            <span class="material-symbols-outlined">mark_email_read</span>
            <span>Invitation sent to <strong>{{ result.email }}</strong>. The link works once and expires in 7 days.</span>
          </div>
        } @else {
          <div class="dg-callout is-warning" role="status">
            <span class="material-symbols-outlined">warning</span>
            <span>The email could not be sent{{ ' ' }}because mail is not set up or failed. Send this link to <strong>{{ result.email }}</strong> yourself. It works once and is shown only now.</span>
          </div>
          <div class="dg-field mt-3">
            <label class="form-label" for="invite-link">Invitation link</label>
            <input id="invite-link" class="form-control" readonly [value]="result.inviteUrl" (focus)="select($event)" />
          </div>
          <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="copy()">
            <span class="material-symbols-outlined">content_copy</span> Copy link
          </button>
        }
      </div>
      <div class="modal-footer">
        <button type="button" class="dg-btn dg-btn-primary" (click)="close()">Done</button>
      </div>
    } @else {
      <div class="modal-body">
        <div class="dg-field">
          <label class="form-label" for="user-email">Email</label>
          <input id="user-email" type="email" class="form-control" [(ngModel)]="email" autocomplete="off" />
        </div>
        <div class="dg-field">
          <label class="form-label" for="user-role">Role</label>
          <select id="user-role" class="form-select" [(ngModel)]="role">
            <option value="User">User</option>
            <option value="Security">Security</option>
          </select>
          <span class="dg-form-help">
            {{ role === 'User' ? 'Can set up their registry and request waivers.' : 'Full access: policies, exceptions, settings and the ledger.' }}
          </span>
        </div>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" [(ngModel)]="sendInvite" data-testid="user-send-invite" /> Send a password invitation
        </label>
        @if (!sendInvite) {
          <span class="dg-form-help d-block">Without one, they can only sign in with single sign-on. You can send an invitation later.</span>
        }
        @if (outsideSsoDomains) {
          <div class="dg-callout is-warning mt-3" role="status" data-testid="user-outside-domains">
            <span class="material-symbols-outlined">info</span>
            <span>{{ domainOf(email) }} is not a single sign-on domain, so they must use a password.</span>
          </div>
        }
      </div>
      <div class="modal-footer">
        <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
        <button type="button" class="dg-btn dg-btn-primary" (click)="create()" [disabled]="!email.trim() || saving">
          {{ saving ? 'Saving…' : sendInvite ? 'Send invitation' : 'Add user' }}
        </button>
      </div>
    }
  `,
})
export class CreateUserDialogComponent implements OnInit {
  email = '';
  role: 'User' | 'Security' = 'User';
  sendInvite = true;
  saving = false;
  result: InviteResult | null = null;
  signin: SigninSettings | null = null;

  activeModal = inject(NgbActiveModal);
  private accounts = inject(AccountService);
  private toast = inject(ToastService);
  private sso = inject(SsoService);

  ngOnInit(): void {
    // With single sign-on on, most people need no password; the invitation is then opt-in.
    this.sso.signinSettings().subscribe({
      next: (s) => {
        this.signin = s;
        if (s.ssoEnabled) this.sendInvite = false;
      },
      error: () => (this.signin = null),
    });
  }

  domainOf(email: string): string {
    const at = email.lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
  }

  /** R10: this person cannot use single sign-on, so they need a password. */
  get outsideSsoDomains(): boolean {
    const domain = this.domainOf(this.email);
    return Boolean(this.signin?.ssoEnabled && domain.includes('.') && !this.signin.allowedDomains.includes(domain));
  }

  create(): void {
    if (this.saving) return;
    this.saving = true;
    this.accounts.createUser({ email: this.email.trim(), role: this.role, sendInvite: this.sendInvite }).subscribe({
      next: (result) => {
        this.saving = false;
        if (!result.invited) {
          this.toast.success(`${result.email} added. They can sign in with single sign-on.`);
          this.activeModal.close(true);
          return;
        }
        this.result = result;
      },
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Create failed');
        this.saving = false;
      },
    });
  }

  select(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  copy(): void {
    if (!this.result?.inviteUrl) return;
    void navigator.clipboard.writeText(this.result.inviteUrl).then(() => this.toast.success('Link copied'));
  }

  close(): void {
    if (this.result) this.activeModal.close(true);
    else this.activeModal.dismiss();
  }
}
