import { Component, Input, inject, ChangeDetectionStrategy } from '@angular/core';
import { ToastService } from '../../services/toast.service';
import { ProviderSetup, SsoProtocol } from '../../services/sso.service';

/**
 * What to register at the identity provider, with copy buttons. OIDC: the redirect URI; "Show all URLs"
 * adds the initiate-login and post-logout URIs. SAML: the SP entity ID and ACS URL, and a download of
 * the SP metadata, which carries both.
 */
@Component({
  selector: 'app-sso-setup-urls',
  standalone: true,
  styles: [`
    .strip { border: 1px solid var(--color-border); border-radius: var(--radius, 8px); background: var(--brand-soft, rgba(99, 102, 241, 0.06)); padding: 10px 12px; }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .row + .row { margin-top: 6px; }
    .label { flex: 0 0 auto; font-size: 0.75rem; font-weight: 600; color: var(--color-on-surface-variant); min-width: 132px; }
    .value { flex: 1 1 0; min-width: 0; font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 6px; font-size: 0.75rem; color: var(--color-on-surface-variant); }
    .toggle { background: none; border: none; padding: 0; color: var(--brand-text, #4f46e5); font-weight: 600; font-size: 0.75rem; cursor: pointer; display: inline-flex; align-items: center; gap: 2px; }
    .toggle .material-symbols-outlined { font-size: 16px; }
    .warn { margin-top: 6px; font-size: 0.75rem; color: var(--color-warning-text, #b45309); }
    @media (max-width: 575px) { .row { flex-wrap: wrap; } .label { min-width: 100%; } }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (setup) {
      <div class="strip" data-testid="sso-setup-urls">
        @for (item of shown; track item.label) {
          <div class="row">
            <span class="label">{{ item.label }}</span>
            <span class="value" [title]="item.value" [attr.data-testid]="item.testId">{{ item.value }}</span>
            <button type="button" class="dg-icon-btn" (click)="copy(item.value, item.label)" [attr.aria-label]="'Copy ' + item.label" [title]="'Copy ' + item.label">
              <span class="material-symbols-outlined">content_copy</span>
            </button>
          </div>
        }
        @if (type === 'saml') {
          <div class="foot">
            <span>Register these at your identity provider, or import the SP metadata.</span>
            @if (saved) {
              <a class="toggle" [href]="setup.urls.spMetadataUrl" download="depgate-sp-metadata.xml" target="_blank" rel="noopener" data-testid="sso-sp-metadata">
                <span class="material-symbols-outlined">download</span> SP metadata
              </a>
            } @else {
              <span data-testid="sso-sp-metadata-later">SP metadata: after the first save</span>
            }
          </div>
        } @else {
          <div class="foot">
            <span>Register {{ expanded ? 'these' : 'this' }} at your identity provider.</span>
            <button type="button" class="toggle" (click)="expanded = !expanded" [attr.aria-expanded]="expanded" data-testid="sso-setup-toggle">
              {{ expanded ? 'Fewer URLs' : 'Show all URLs' }}
              <span class="material-symbols-outlined">{{ expanded ? 'expand_less' : 'expand_more' }}</span>
            </button>
          </div>
        }
        @if (setup.publicUrlSource === 'default') {
          <p class="warn mb-0" data-testid="sso-setup-default-url">
            Based on {{ setup.publicUrl }}, which is not confirmed yet. Set UI_URL, or sign in once from the address people use, so these URLs stay fixed.
          </p>
        }
      </div>
    }
  `,
})
export class SsoSetupUrlsComponent {
  @Input() setup: ProviderSetup | null = null;
  @Input() type: SsoProtocol = 'oidc';
  /** The SP metadata is served only for a saved provider. */
  @Input() saved = false;
  expanded = false;

  private toast = inject(ToastService);

  get shown(): Array<{ label: string; value: string; testId: string }> {
    if (!this.setup) return [];
    if (this.type === 'saml') {
      return [
        { label: 'SP entity ID', value: this.setup.urls.spEntityId, testId: 'sso-sp-entity-id' },
        { label: 'ACS URL', value: this.setup.urls.acsUrl, testId: 'sso-acs-url' },
      ];
    }
    const all = [
      { label: 'Redirect URI', value: this.setup.urls.redirectUri, testId: 'sso-redirect-uri' },
      { label: 'Initiate login URI', value: this.setup.urls.initiateLoginUri, testId: 'sso-initiate-uri' },
      { label: 'Post-logout URI', value: this.setup.urls.postLogoutRedirectUri, testId: 'sso-logout-uri' },
    ];
    return this.expanded ? all : all.slice(0, 1);
  }

  copy(value: string, label: string): void {
    void navigator.clipboard.writeText(value).then(
      () => this.toast.success(`${label} copied`),
      () => this.toast.error('Could not copy; select the text instead')
    );
  }
}
