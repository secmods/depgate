import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountService, MailSettings } from '../../services/account.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-mail-settings',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Email (SMTP)</h2>
          <span class="dg-card-hint">Sends invitations and password reset links.</span>
        </div>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="p-4">
          @if (settings.source === 'environment') {
            <div class="dg-callout mb-3">
              <span class="material-symbols-outlined">info</span>
              <span>Using the SMTP_* environment variables. Saving here overrides them.</span>
            </div>
          } @else if (settings.source === 'none') {
            <div class="dg-callout is-warning mb-3">
              <span class="material-symbols-outlined">warning</span>
              <span>Email is not set up. You must send invitation links yourself, and password reset is unavailable.</span>
            </div>
          }

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="dg-field">
              <label class="form-label" for="smtp-host">SMTP host</label>
              <input id="smtp-host" class="form-control" [(ngModel)]="host" placeholder="smtp.example.com" autocomplete="off" />
            </div>
            <div class="dg-field">
              <label class="form-label" for="smtp-port">Port</label>
              <input id="smtp-port" type="number" class="form-control" [(ngModel)]="port" min="1" max="65535" />
            </div>
            <div class="dg-field">
              <label class="form-label" for="smtp-user">Username</label>
              <input id="smtp-user" class="form-control" [(ngModel)]="user" autocomplete="off" />
            </div>
            <div class="dg-field">
              <label class="form-label" for="smtp-pass">Password</label>
              <input id="smtp-pass" type="password" class="form-control" [(ngModel)]="password" autocomplete="new-password"
                [placeholder]="settings.hasPassword ? '•••••••• (saved)' : ''" />
              @if (settings.hasPassword) {
                <span class="dg-form-help">Leave blank to keep the saved password.</span>
              }
            </div>
            <div class="dg-field sm:col-span-2">
              <label class="form-label" for="smtp-from">From address</label>
              <input id="smtp-from" class="form-control" [(ngModel)]="from" placeholder="DepGate &lt;no-reply@example.com&gt;" autocomplete="off" />
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm mt-1">
            <input type="checkbox" [(ngModel)]="secure" /> Use TLS from the start (usually port 465). Leave off for STARTTLS on 587.
          </label>

          <div class="flex gap-2 mt-4">
            <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="save()" [disabled]="saving || !host.trim() || !from.trim()">
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="test()" [disabled]="testing || settings.source === 'none'">
              {{ testing ? 'Sending…' : 'Send test email to me' }}
            </button>
          </div>
        </div>
      }
    </section>
  `,
})
export class MailSettingsComponent implements OnInit {
  loading = true;
  saving = false;
  testing = false;
  settings: MailSettings = { host: '', port: 587, secure: false, user: '', hasPassword: false, from: '', source: 'none' };
  host = '';
  port = 587;
  secure = false;
  user = '';
  password = '';
  from = '';

  private accounts = inject(AccountService);
  private toast = inject(ToastService);

  ngOnInit(): void {
    this.accounts.getMailSettings().subscribe({
      next: (s) => { this.apply(s); this.loading = false; },
      error: (err) => { this.loading = false; this.toast.error(err.error?.error ?? 'Failed to load email settings'); },
    });
  }

  private apply(s: MailSettings): void {
    this.settings = s;
    this.host = s.host;
    this.port = s.port;
    this.secure = s.secure;
    this.user = s.user;
    this.from = s.from;
    this.password = '';
  }

  save(): void {
    this.saving = true;
    this.accounts
      .saveMailSettings({
        host: this.host.trim(),
        port: Number(this.port),
        secure: this.secure,
        user: this.user.trim(),
        from: this.from.trim(),
        ...(this.password ? { password: this.password } : {}),
      })
      .subscribe({
        next: (s) => { this.apply(s); this.saving = false; this.toast.success('Email settings saved'); },
        error: (err) => { this.saving = false; this.toast.error(err.error?.error ?? 'Save failed'); },
      });
  }

  test(): void {
    this.testing = true;
    this.accounts.sendTestMail().subscribe({
      next: (r) => { this.testing = false; this.toast.success(`Test email sent to ${r.sentTo}`); },
      error: (err) => { this.testing = false; this.toast.error(err.error?.error ?? 'Test failed'); },
    });
  }
}
