import { Component, EventEmitter, OnInit, Output, inject, ChangeDetectionStrategy } from '@angular/core';
import { ChipInputComponent } from '../../shared/chip-input.component';
import { ToastService } from '../../services/toast.service';
import { SigninSettings, SsoService } from '../../services/sso.service';

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Who may sign in with single sign-on (requirements_sso.md §5.2): the allowed email domains, and
 * whether people not listed under Users are added as User on their first sign-in.
 */
@Component({
  selector: 'app-signin-settings',
  standalone: true,
  imports: [ChipInputComponent],
  styles: [`
    .setting-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 24px; padding: 16px 20px; border-bottom: 1px solid var(--color-border); }
    .setting-row > div:first-child { flex: 1 1 320px; min-width: 0; }
    .setting-row:last-child { border-bottom: none; }
    .setting-title { font-size: 0.875rem; font-weight: 600; color: var(--color-on-surface); margin: 0 0 2px; }
    .setting-desc { font-size: 0.8125rem; line-height: 1.5; color: var(--color-on-surface-variant); margin: 0; max-width: 64ch; }
    .domains { flex: 1 1 280px; min-width: 240px; max-width: 520px; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="dg-card" data-testid="signin-settings">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Who may sign in</h2>
          <span class="dg-card-hint">
            Single sign-on is {{ settings?.ssoEnabled ? 'on' : 'off' }}. Roles come from the Users tab.
          </span>
        </div>
      </div>
      @if (!settings) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="setting-row">
          <div>
            <p class="setting-title">Allowed sign-in domains</p>
            <p class="setting-desc">Only these email domains can use single sign-on.</p>
          </div>
          <div class="domains">
            <app-chip-input [values]="domains" (valuesChange)="domains = $event" inputId="signin-domains" testId="signin-domains"
              placeholder="yourcompany.com" [errorOf]="domainError" />
          </div>
        </div>
        <div class="setting-row">
          <div>
            <p class="setting-title">Add new people automatically</p>
            <p class="setting-desc">New people join as User on their first sign-in. When off, only people you add can sign in.</p>
          </div>
          <button type="button" class="dg-switch" role="switch" [class.is-on]="allowUnlisted" [attr.aria-checked]="allowUnlisted"
            aria-label="Add new people automatically" (click)="allowUnlisted = !allowUnlisted" data-testid="signin-unlisted"></button>
        </div>
        <div class="setting-row">
          <span class="text-xs dg-text-variant">{{ dirty ? 'Unsaved changes.' : '' }}</span>
          <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="save()" [disabled]="saving || !dirty || hasErrors" data-testid="signin-save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      }
    </section>
  `,
})
export class SigninSettingsComponent implements OnInit {
  /** Fired after a save, so the page can refresh what depends on the domains. */
  @Output() saved = new EventEmitter<SigninSettings>();

  settings: SigninSettings | null = null;
  domains: string[] = [];
  allowUnlisted = true;
  saving = false;

  private sso = inject(SsoService);
  private toast = inject(ToastService);

  readonly domainError = (value: string): string =>
    DOMAIN.test(value.trim().toLowerCase().replace(/^@/, '')) ? '' : 'Not a domain name, e.g. yourcompany.com';

  get dirty(): boolean {
    if (!this.settings) return false;
    return this.allowUnlisted !== this.settings.allowUnlistedSso || this.domains.join(',') !== this.settings.allowedDomains.join(',');
  }

  get hasErrors(): boolean {
    return this.domains.some((value) => this.domainError(value) !== '');
  }

  ngOnInit(): void {
    this.sso.signinSettings().subscribe({
      next: (s) => this.apply(s),
      error: (err) => this.toast.error(err.error?.error ?? 'Failed to load sign-in settings'),
    });
  }

  private apply(s: SigninSettings): void {
    this.settings = s;
    this.domains = [...s.allowedDomains];
    this.allowUnlisted = s.allowUnlistedSso;
  }

  save(): void {
    this.saving = true;
    this.sso.saveSigninSettings({ allowedDomains: this.domains, allowUnlistedSso: this.allowUnlisted }).subscribe({
      next: (s) => {
        this.saving = false;
        this.apply(s);
        this.saved.emit(s);
        this.toast.success('Sign-in settings saved');
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Save failed');
      },
    });
  }
}
