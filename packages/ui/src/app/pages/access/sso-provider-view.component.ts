import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MODAL_DATA } from '../../tokens';
import { ProviderSetup, SsoProvider, SsoService, discoveryUrl } from '../../services/sso.service';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { SsoCertificateComponent } from './sso-certificate.component';
import { SsoSetupUrlsComponent } from './sso-setup-urls.component';
import { SsoTestRunner } from './sso-test-runner.service';

export interface SsoProviderViewData {
  provider: SsoProvider;
}

/** What closing the view asks the list to do next. */
export type SsoProviderViewResult = 'edit' | 'changed' | undefined;

/** A provider at a glance: what to register at the provider, its settings, and how it last went. Read only. */
@Component({
  selector: 'app-sso-provider-view',
  standalone: true,
  imports: [DatePipe, StatusPillComponent, SsoCertificateComponent, SsoSetupUrlsComponent],
  styles: [`
    .cert-stack { display: flex; flex-direction: column; gap: 6px; }
    .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; margin: 0; font-size: 0.875rem; }
    .facts dt { color: var(--color-on-surface-variant); font-weight: 500; }
    .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.8125rem; }
    .doc-link { color: var(--brand-text, #4f46e5); }
    .error { color: var(--color-danger, #dc2626); }
    .modal-footer .spacer { flex: 1; }
    @media (max-width: 575px) { .facts { grid-template-columns: 1fr; gap: 2px; } .facts dd { margin-bottom: 8px; } }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title d-flex align-items-center gap-2">
          {{ p.name }}
          <app-status-pill [value]="p.enabled ? 'enabled' : 'disabled'" [tone]="p.enabled ? 'success' : 'neutral'" [label]="p.enabled ? 'On' : 'Off'" />
        </h5>
        <p class="dg-dialog-description">{{ p.type === 'saml' ? 'SAML 2.0' : 'OpenID Connect' }} · button “{{ p.buttonLabel }}”</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.close(changed ? 'changed' : undefined)"></button>
    </div>

    <div class="modal-body">
      <app-sso-setup-urls class="d-block mb-3" [setup]="setup" [type]="p.type" [saved]="true" />

      @if (p.saml; as s) {
        <dl class="facts" data-testid="sso-view-facts">
          @if (s.metadataUrl) {
            <dt>Metadata URL</dt>
            <dd class="mono">{{ s.metadataUrl }}</dd>
          }
          <dt>IdP entity ID</dt>
          <dd class="mono">{{ s.idpEntityId }}</dd>
          <dt>SSO URL</dt>
          <dd class="mono">{{ s.ssoUrl }}</dd>
          <dt>Signing certificates</dt>
          <dd class="cert-stack">
            @for (info of s.idpCertificateInfo; track $index) { <app-sso-certificate [info]="info" /> }
          </dd>
          <dt>NameID format</dt>
          <dd class="mono">{{ s.nameIdFormat }}</dd>
          <dt>Email</dt>
          <dd class="mono">{{ s.emailAttribute || (s.nameIdFormat.endsWith(':emailAddress') ? 'NameID' : 'email') }}</dd>
          <dt>Subject</dt>
          <dd class="mono">{{ s.subjectAttribute || 'NameID' }}</dd>
          @if (s.requiredAttributes.length) {
            <dt>Required attributes</dt>
            <dd class="mono">
              @for (row of s.requiredAttributes; track $index) { <div>{{ row.attribute }} = {{ row.value }}</div> }
            </dd>
          }
          <dt>Security</dt>
          <dd>
            {{ s.requireSignedAssertion ? 'Signed assertions required' : 'Signed responses required' }}{{ s.signRequests ? ' · requests signed' : '' }}{{ s.acceptEncryptedAssertions ? ' · encrypted assertions accepted' : '' }}
          </dd>
          @if (s.spCertificateInfo) {
            <dt>SP certificate</dt>
            <dd>
              @if (s.spPrivateKeyUnreadable) { <span class="error d-block">The private key must be generated or uploaded again</span> }
              <app-sso-certificate [info]="s.spCertificateInfo" />
            </dd>
          }
          <dt>Last successful sign-in</dt>
          <dd>{{ p.lastSuccessAt ? (p.lastSuccessAt | date: 'medium') : 'Never' }}</dd>
          @if (p.lastError) {
            <dt>Last error</dt>
            <dd class="error" data-testid="sso-view-error">{{ p.lastError }}</dd>
          }
        </dl>
      }

      @if (p.oidc; as o) {
      <dl class="facts" data-testid="sso-view-facts">
        <dt>Issuer</dt>
        <dd>
          <span class="mono">{{ o.issuer }}</span>
          @if (o.useDiscovery && documentUrl) {
            <a class="doc-link d-block text-xs" [href]="documentUrl" target="_blank" rel="noopener noreferrer">Discovery document</a>
          }
        </dd>
        <dt>Client ID</dt>
        <dd class="mono">{{ o.clientId }}</dd>
        <dt>Client secret</dt>
        <dd>
          @if (o.clientSecretUnreadable) { <span class="error">Must be entered again</span> }
          @else { {{ o.hasClientSecret ? 'Saved' : 'Not set' }} }
        </dd>
        <dt>Scopes</dt>
        <dd class="mono">{{ o.scopes }}</dd>
        <dt>Email</dt>
        <dd>
          <span class="mono">{{ o.emailClaim }}</span> claim{{ o.requireVerifiedEmail ? ', must be verified' : ', verification not required' }}
        </dd>
        @if (o.requiredClaims.length) {
          <dt>Required claims</dt>
          <dd class="mono">
            @for (row of o.requiredClaims; track $index) { <div>{{ row.claim }} = {{ row.value }}</div> }
          </dd>
        }
        @if (!o.useDiscovery) {
          <dt>Endpoints</dt>
          <dd class="mono">
            <div>{{ o.authorizationEndpoint }}</div>
            <div>{{ o.tokenEndpoint }}</div>
            <div>{{ o.jwksUri }}</div>
          </dd>
        }
        <dt>Client authentication</dt>
        <dd class="mono">{{ o.clientAuthMethod }}</dd>
        @if (o.extraAuthParams.length) {
          <dt>Extra parameters</dt>
          <dd class="mono">
            @for (row of o.extraAuthParams; track $index) { <div>{{ row.key }} = {{ row.value }}</div> }
          </dd>
        }
        <dt>Last successful sign-in</dt>
        <dd>{{ p.lastSuccessAt ? (p.lastSuccessAt | date: 'medium') : 'Never' }}</dd>
        @if (p.lastError) {
          <dt>Last error</dt>
          <dd class="error" data-testid="sso-view-error">{{ p.lastError }}</dd>
        }
      </dl>
      }
    </div>

    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="test()" [disabled]="testing" data-testid="sso-view-test"
        title="Signs in at the provider with these settings, without signing anyone in to DepGate">
        <span class="material-symbols-outlined">science</span> Test sign-in
      </button>
      <span class="spacer"></span>
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.close(changed ? 'changed' : undefined)">Close</button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="activeModal.close('edit')" data-testid="sso-view-edit">
        <span class="material-symbols-outlined">edit</span> Edit
      </button>
    </div>
  `,
})
export class SsoProviderViewComponent implements OnInit {
  activeModal = inject(NgbActiveModal);
  private data = inject<SsoProviderViewData>(MODAL_DATA);
  private sso = inject(SsoService);
  private tester = inject(SsoTestRunner);

  p: SsoProvider = this.data.provider;
  setup: ProviderSetup | null = null;
  testing = false;
  /** A test updates the provider's last success or error; the list reloads when this is set. */
  changed = false;

  get documentUrl(): string {
    return this.p.oidc ? discoveryUrl(this.p.oidc.issuer) : '';
  }

  ngOnInit(): void {
    this.sso.setup(this.p.id).subscribe({ next: (setup) => (this.setup = setup), error: () => (this.setup = null) });
  }

  async test(): Promise<void> {
    this.testing = true;
    await this.tester.run(this.p);
    this.testing = false;
    this.changed = true;
    this.sso.list().subscribe({
      next: (list) => {
        const fresh = list.find((row) => row.id === this.p.id);
        if (fresh) this.p = fresh;
      },
    });
  }
}
