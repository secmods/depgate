import { Component, ElementRef, HostListener, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import { ActivatedRoute, Router } from '@angular/router';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { ToastService } from '../../services/toast.service';
import {
  AttributeRow,
  ClaimRow,
  DescribedCertificate,
  Discovered,
  NAMEID_FORMATS,
  OidcSettings,
  ParamRow,
  ProviderSetup,
  SamlSettings,
  SigninSettings,
  SpKeyChange,
  SsoProtocol,
  SsoProvider,
  SsoProviderInput,
  SsoService,
  discoveryUrl,
} from '../../services/sso.service';
import { SsoCertificateComponent } from './sso-certificate.component';
import { SsoSetupUrlsComponent } from './sso-setup-urls.component';
import { SsoTestRunner } from './sso-test-runner.service';

const EMPTY_OIDC: OidcSettings = {
  issuer: '',
  clientId: '',
  scopes: 'openid email profile',
  emailClaim: 'email',
  requireVerifiedEmail: true,
  requiredClaims: [],
  useDiscovery: true,
  authorizationEndpoint: '',
  tokenEndpoint: '',
  jwksUri: '',
  userinfoEndpoint: '',
  clientAuthMethod: 'client_secret_basic',
  clockSkewSeconds: 60,
  extraAuthParams: [],
};

const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

const EMPTY_SAML: SamlSettings = {
  metadataUrl: '',
  idpEntityId: '',
  ssoUrl: '',
  idpCertificates: [],
  nameIdFormat: NAMEID_EMAIL,
  emailAttribute: '',
  subjectAttribute: '',
  requiredAttributes: [],
  requireSignedAssertion: true,
  signRequests: false,
  acceptEncryptedAssertions: false,
  clockSkewSeconds: 60,
};

const MAX_IDP_CERTIFICATES = 2;
const RETURN_URL = '/access?tab=sso';

interface Step {
  label: string;
  done: boolean;
  detail: string;
}

type MetadataSource = 'url' | 'xml' | 'file';

/**
 * Add or edit an identity provider (requirements_sso.md R1–R3), laid out like the policy form: the form on
 * the left; on the right a summary of what will be saved, the URLs to register at the provider, and Save.
 */
@Component({
  selector: 'app-sso-provider-page',
  standalone: true,
  imports: [DatePipe, FormsModule, NgbTooltipModule, EmptyStateComponent, SsoCertificateComponent, SsoSetupUrlsComponent],
  styles: [`
    .sp-back {
      display: inline-flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 0.8125rem; font-weight: 600;
      color: var(--color-on-surface-variant); text-decoration: none; align-self: flex-start;
    }
    .sp-back .material-symbols-outlined { font-size: 18px; }
    .sp-back:hover { color: var(--brand-text); }
    .sp-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 20px; align-items: start; }
    .sp-main { padding: 20px 24px; min-width: 0; }
    .sp-test { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
    .sp-test .sp-actions { margin-top: 6px; }
    .sp-test-status { font-size: 0.8125rem; color: var(--color-on-surface-variant); margin: 0; }
    .sp-test-status.ok { color: var(--color-success, #16a34a); }
    .sp-test-error { font-size: 0.8125rem; color: var(--color-danger, #dc2626); margin: 0; overflow-wrap: anywhere; }
    /* Summary and Test stay in view; when together they are taller than the window, the column scrolls on its own. */
    .sp-aside { position: sticky; top: 80px; min-width: 0; display: flex; flex-direction: column; gap: 16px; max-height: calc(100vh - 96px); overflow-y: auto; }
    .sp-summary { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .section-title { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-on-surface-variant); margin: 22px 0 10px; }
    .section-title:first-child { margin-top: 0; }
    .row-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-bottom: 8px; }
    .type-options { display: flex; gap: 16px; flex-wrap: wrap; }
    .advanced-toggle { background: none; border: none; padding: 0; color: var(--brand-text, #4f46e5); font-weight: 600; font-size: 0.875rem; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
    .doc-link { font-size: 0.75rem; word-break: break-all; color: var(--brand-text, #4f46e5); }
    .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 0.8125rem; }
    .facts dt { color: var(--color-on-surface-variant); font-weight: 500; }
    .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--color-on-surface); }
    .facts .muted { color: var(--color-hint); }
    .facts .warn { color: var(--color-danger, #dc2626); }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.78rem; }
    .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 0.8125rem; }
    .steps li { display: flex; gap: 8px; align-items: flex-start; }
    .steps .material-symbols-outlined { font-size: 18px; margin-top: 0; }
    .steps .ok { color: var(--color-success, #16a34a); }
    .steps .todo { color: var(--color-hint); }
    .steps .detail { display: block; color: var(--color-on-surface-variant); font-size: 0.75rem; }
    .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 0.875rem; font-weight: 500; }
    .sp-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .sp-next {
      display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--info-border); border-radius: var(--radius);
      background: var(--info-bg); font-size: 0.8125rem; line-height: 1.4; color: var(--color-on-surface);
    }
    .sp-next > .material-symbols-outlined { font-size: 16px; margin-top: 1px; color: var(--info-fg); }
    .sp-next-label { font-weight: 600; }
    .sp-next-link {
      padding: 0; border: 0; background: none; font: inherit; text-align: left; color: var(--brand-text);
      text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
    }
    .sp-next-link:hover { text-decoration-thickness: 2px; }
    .sp-save-wrap { display: inline-flex; }
    .sp-save-wrap .dg-btn:disabled { pointer-events: none; }
    .source-tabs { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
    .cert-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
    .cert-block { display: flex; flex-direction: column; gap: 8px; }
    .cert-input { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.75rem; min-height: 96px; }
    .cert-pem { resize: vertical; }
    .file-label { cursor: pointer; }
    .file-label input { display: none; }
    .sp-key { border: 1px dashed var(--color-border); border-radius: var(--radius, 8px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
    .inline-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    @media (max-width: 1100px) {
      .sp-layout { grid-template-columns: minmax(0, 1fr); }
      .sp-aside { position: static; max-height: none; overflow: visible; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <a class="sp-back" href="#" (click)="cancel(); $event.preventDefault()" data-testid="sso-back">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>Single sign-on
      </a>
      <header class="dg-page-header">
        <div class="min-w-0">
          <h1 class="dg-page-title">{{ provider ? 'Edit identity provider' : 'Add identity provider' }}</h1>
          <p class="dg-page-subtitle">Roles come from the Users tab, not from the provider.</p>
        </div>
      </header>

      @if (loadError) {
        <section class="dg-card">
          <app-empty-state icon="search_off" title="Identity provider not found" [description]="loadError">
            <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()">Back to Single sign-on</button>
          </app-empty-state>
        </section>
      } @else if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="sp-layout">
          <section class="dg-card sp-main" aria-label="Identity provider">
            @if (validationError) {
              <div class="dg-callout is-warning mb-3" role="alert" data-testid="sso-validation-error">
                <span class="material-symbols-outlined">warning</span>
                <span>Saved, but not turned on: {{ validationError }}</span>
              </div>
            }

            <p class="section-title">Provider</p>
            <div class="dg-field">
              <span class="form-label" id="sso-type-label">Protocol</span>
              <div class="type-options" role="radiogroup" aria-labelledby="sso-type-label">
                <label class="flex items-center gap-2 text-sm">
                  <input type="radio" name="sso-type" value="oidc" [checked]="type === 'oidc'" (change)="setType('oidc')" [disabled]="!!provider" data-testid="sso-type-oidc" />
                  OpenID Connect (OIDC)
                </label>
                <label class="flex items-center gap-2 text-sm">
                  <input type="radio" name="sso-type" value="saml" [checked]="type === 'saml'" (change)="setType('saml')" [disabled]="!!provider" data-testid="sso-type-saml" />
                  SAML 2.0
                </label>
              </div>
              @if (provider) { <span class="dg-form-help">The protocol of a saved provider cannot change. Add another provider instead.</span> }
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="dg-field">
                <label class="form-label" for="sso-name">Name</label>
                <input id="sso-name" class="form-control" [(ngModel)]="name" placeholder="Corporate SSO" autocomplete="off" />
                <span class="dg-form-help">Shown to admins and in the ledger.</span>
              </div>
              <div class="dg-field">
                <label class="form-label" for="sso-label">Button label</label>
                <input id="sso-label" class="form-control" [(ngModel)]="buttonLabel" placeholder="Sign in with single sign-on" autocomplete="off" />
                <span class="dg-form-help">Shown on the login page.</span>
              </div>
            </div>

            @if (type === 'oidc') {
              <p class="section-title">Connection</p>
              <div class="dg-field">
                <label class="form-label" for="sso-issuer">Issuer URL</label>
                <div class="d-flex gap-2">
                  <input id="sso-issuer" class="form-control" [(ngModel)]="oidc.issuer" placeholder="https://accounts.google.com" autocomplete="off" />
                  <button type="button" class="dg-btn dg-btn-secondary" (click)="discover()" [disabled]="discovering || !oidc.issuer.trim()" data-testid="sso-discover">
                    {{ discovering ? 'Checking…' : 'Discover' }}
                  </button>
                </div>
                @if (documentUrl) {
                  <span class="dg-form-help d-block mt-1">Discovery document:
                    <a class="doc-link" [href]="documentUrl" target="_blank" rel="noopener noreferrer" data-testid="sso-discovery-link">{{ documentUrl }}</a>
                  </span>
                } @else {
                  <span class="dg-form-help d-block mt-1" data-testid="sso-discovery-hint">Discovery document: &lt;issuer&gt;/.well-known/openid-configuration</span>
                }
                @if (discovered) {
                  <span class="dg-form-help text-success d-block" data-testid="sso-discovered">
                    Found it. Signs ID tokens with {{ discovered.signingAlgs.join(', ') || 'unspecified algorithms' }}.
                  </span>
                }
                @if (issuerNote) {
                  <span class="dg-form-help d-block" data-testid="sso-issuer-note">{{ issuerNote }}</span>
                }
                @if (discoverError) {
                  <span class="dg-form-help text-danger d-block" role="alert">{{ discoverError }}</span>
                }
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="dg-field">
                  <label class="form-label" for="sso-client-id">Client ID</label>
                  <input id="sso-client-id" class="form-control" [(ngModel)]="oidc.clientId" autocomplete="off" />
                </div>
                <div class="dg-field">
                  <label class="form-label" for="sso-client-secret">Client secret</label>
                  <input id="sso-client-secret" type="password" class="form-control" [(ngModel)]="clientSecret" autocomplete="new-password"
                    [placeholder]="hasSavedSecret ? '•••••••• (saved)' : ''" />
                  @if (provider?.oidc?.clientSecretUnreadable) {
                    <span class="dg-form-help text-danger d-block">The saved secret can no longer be read (the server key changed). Enter it again.</span>
                  } @else if (hasSavedSecret) {
                    <span class="dg-form-help">Leave blank to keep the saved secret.</span>
                  }
                </div>
              </div>
              <div class="dg-field">
                <label class="form-label" for="sso-scopes">Scopes</label>
                <input id="sso-scopes" class="form-control" [(ngModel)]="oidc.scopes" autocomplete="off" />
                <span class="dg-form-help">Space-separated. openid is always included.</span>
              </div>

              <p class="section-title">Claims</p>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="dg-field">
                  <label class="form-label" for="sso-email-claim">Email claim</label>
                  <input id="sso-email-claim" class="form-control" [(ngModel)]="oidc.emailClaim" autocomplete="off" />
                  <span class="dg-form-help">Usually email. Some providers use preferred_username or upn.</span>
                </div>
                <div class="dg-field">
                  <span class="form-label">Verified email</span>
                  <label class="flex items-center gap-2 text-sm mt-1">
                    <input type="checkbox" [(ngModel)]="oidc.requireVerifiedEmail" data-testid="sso-require-verified" /> Require email_verified = true
                  </label>
                  <span class="dg-form-help">Turn off only for providers that never send it.</span>
                </div>
              </div>
              <div class="dg-field">
                <span class="form-label">Required claims</span>
                <span class="dg-form-help d-block mb-2">Optional, e.g. hd = yourcompany.com or tid = your tenant ID.</span>
                @for (row of oidc.requiredClaims; track $index) {
                  <div class="row-grid">
                    <input class="form-control" [(ngModel)]="row.claim" placeholder="Claim" [attr.aria-label]="'Claim ' + ($index + 1)" />
                    <input class="form-control" [(ngModel)]="row.value" placeholder="Value" [attr.aria-label]="'Claim value ' + ($index + 1)" />
                    <button type="button" class="dg-icon-btn is-danger" (click)="removeClaim($index)" aria-label="Remove claim"><span class="material-symbols-outlined">close</span></button>
                  </div>
                }
                <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addClaim()"><span class="material-symbols-outlined">add</span> Add required claim</button>
              </div>

              <p class="section-title">
                <button type="button" class="advanced-toggle" (click)="showAdvanced = !showAdvanced" [attr.aria-expanded]="showAdvanced">
                  <span class="material-symbols-outlined">{{ showAdvanced ? 'expand_less' : 'expand_more' }}</span> Advanced
                </button>
              </p>
              @if (showAdvanced) {
                <label class="flex items-center gap-2 text-sm mb-3">
                  <input type="checkbox" [(ngModel)]="oidc.useDiscovery" /> Use discovery (read the endpoints from the issuer)
                </label>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="dg-field">
                    <label class="form-label" for="sso-auth-ep">Authorization endpoint</label>
                    <input id="sso-auth-ep" class="form-control" [(ngModel)]="endpoints.authorizationEndpoint" [readonly]="oidc.useDiscovery" />
                  </div>
                  <div class="dg-field">
                    <label class="form-label" for="sso-token-ep">Token endpoint</label>
                    <input id="sso-token-ep" class="form-control" [(ngModel)]="endpoints.tokenEndpoint" [readonly]="oidc.useDiscovery" />
                  </div>
                  <div class="dg-field">
                    <label class="form-label" for="sso-jwks">JWKS URI</label>
                    <input id="sso-jwks" class="form-control" [(ngModel)]="endpoints.jwksUri" [readonly]="oidc.useDiscovery" />
                  </div>
                  <div class="dg-field">
                    <label class="form-label" for="sso-userinfo">Userinfo endpoint (optional)</label>
                    <input id="sso-userinfo" class="form-control" [(ngModel)]="endpoints.userinfoEndpoint" [readonly]="oidc.useDiscovery" />
                  </div>
                </div>
                @if (oidc.useDiscovery) {
                  <span class="dg-form-help d-block mb-3">Read from discovery. Press Discover to fill them in; turn discovery off to type them.</span>
                }
                <div class="grid gap-3 sm:grid-cols-3">
                  <div class="dg-field">
                    <label class="form-label" for="sso-client-auth">Client authentication</label>
                    <select id="sso-client-auth" class="form-select" [(ngModel)]="oidc.clientAuthMethod">
                      <option value="client_secret_basic">client_secret_basic</option>
                      <option value="client_secret_post">client_secret_post</option>
                    </select>
                  </div>
                  <div class="dg-field">
                    <span class="form-label">PKCE</span>
                    <input class="form-control" value="Always on (S256)" readonly aria-label="PKCE" />
                  </div>
                  <div class="dg-field">
                    <label class="form-label" for="sso-skew">Allowed clock skew (s)</label>
                    <input id="sso-skew" type="number" min="0" max="300" class="form-control" [(ngModel)]="oidc.clockSkewSeconds" />
                  </div>
                </div>
                <div class="dg-field">
                  <span class="form-label">Extra authorization parameters</span>
                  <span class="dg-form-help d-block mb-2">Added to the sign-in request, e.g. prompt = login.</span>
                  @for (row of oidc.extraAuthParams; track $index) {
                    <div class="row-grid">
                      <input class="form-control" [(ngModel)]="row.key" placeholder="Parameter" [attr.aria-label]="'Parameter ' + ($index + 1)" />
                      <input class="form-control" [(ngModel)]="row.value" placeholder="Value" [attr.aria-label]="'Parameter value ' + ($index + 1)" />
                      <button type="button" class="dg-icon-btn is-danger" (click)="removeParam($index)" aria-label="Remove parameter"><span class="material-symbols-outlined">close</span></button>
                    </div>
                  }
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addParam()"><span class="material-symbols-outlined">add</span> Add parameter</button>
                </div>
              }
            } @else {
              <p class="section-title">Identity provider</p>
              <div class="dg-field">
                <span class="form-label" id="saml-source-label">IdP metadata</span>
                <div class="source-tabs" role="radiogroup" aria-labelledby="saml-source-label">
                  <label class="flex items-center gap-2 text-sm"><input type="radio" name="saml-source" [checked]="metadataSource === 'url'" (change)="metadataSource = 'url'" data-testid="saml-source-url" /> Metadata URL</label>
                  <label class="flex items-center gap-2 text-sm"><input type="radio" name="saml-source" [checked]="metadataSource === 'xml'" (change)="metadataSource = 'xml'" data-testid="saml-source-xml" /> Paste XML</label>
                  <label class="flex items-center gap-2 text-sm"><input type="radio" name="saml-source" [checked]="metadataSource === 'file'" (change)="metadataSource = 'file'" data-testid="saml-source-file" /> Upload file</label>
                </div>
                @if (metadataSource === 'url') {
                  <div class="d-flex gap-2">
                    <input id="saml-metadata-url" class="form-control" [(ngModel)]="saml.metadataUrl" placeholder="https://idp.example.com/saml/metadata" autocomplete="off" aria-label="IdP metadata URL" />
                    <button type="button" class="dg-btn dg-btn-secondary" (click)="readMetadata()" [disabled]="readingMetadata || !saml.metadataUrl.trim()" data-testid="saml-read-metadata">
                      {{ readingMetadata ? 'Reading…' : provider?.saml?.metadataUrl ? 'Refresh' : 'Read metadata' }}
                    </button>
                  </div>
                  <span class="dg-form-help d-block mt-1">Read again on every save, so a new IdP certificate is picked up.</span>
                } @else if (metadataSource === 'xml') {
                  <textarea id="saml-metadata-xml" class="form-control cert-input" [(ngModel)]="metadataXml" placeholder="<md:EntityDescriptor …>" aria-label="IdP metadata XML"></textarea>
                  <div class="inline-actions mt-2">
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="readMetadata()" [disabled]="readingMetadata || !metadataXml.trim()" data-testid="saml-read-metadata">
                      {{ readingMetadata ? 'Reading…' : 'Read metadata' }}
                    </button>
                  </div>
                } @else {
                  <label class="dg-btn dg-btn-secondary dg-btn-sm file-label" data-testid="saml-metadata-file-label">
                    <span class="material-symbols-outlined">upload_file</span> Choose metadata file
                    <input type="file" accept=".xml,application/xml,text/xml,application/samlmetadata+xml" (change)="onMetadataFile($event)" data-testid="saml-metadata-file" />
                  </label>
                }
                @if (metadataNote) { <span class="dg-form-help text-success d-block" data-testid="saml-metadata-note">{{ metadataNote }}</span> }
                @if (metadataError) { <span class="dg-form-help text-danger d-block" role="alert" data-testid="saml-metadata-error">{{ metadataError }}</span> }
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="dg-field">
                  <label class="form-label" for="saml-entity-id">IdP entity ID</label>
                  <input id="saml-entity-id" class="form-control" [(ngModel)]="saml.idpEntityId" autocomplete="off" />
                  <span class="dg-form-help">Assertions must be issued by exactly this.</span>
                </div>
                <div class="dg-field">
                  <label class="form-label" for="saml-sso-url">IdP SSO URL</label>
                  <input id="saml-sso-url" class="form-control" [(ngModel)]="saml.ssoUrl" placeholder="https://idp.example.com/saml/sso" autocomplete="off" />
                  <span class="dg-form-help">HTTP-Redirect binding.</span>
                </div>
              </div>
              <div class="dg-field">
                <span class="form-label">IdP signing certificates</span>
                <span class="dg-form-help d-block mb-2">Up to two. Add the next certificate before the IdP rotates.</span>
                <div class="cert-list" data-testid="saml-idp-certs">
                  @for (cert of idpCerts; track cert.pem) {
                    <div class="cert-block">
                      <app-sso-certificate [info]="cert.info">
                        <button type="button" class="dg-icon-btn is-danger" (click)="removeCertificate($index)" aria-label="Remove certificate"><span class="material-symbols-outlined">close</span></button>
                      </app-sso-certificate>
                      <textarea class="form-control cert-input cert-pem" readonly rows="6" [ngModel]="cert.pem" [attr.aria-label]="'Signing certificate ' + ($index + 1)" data-testid="saml-cert-pem"></textarea>
                    </div>
                  }
                </div>
                @if (idpCerts.length < maxCertificates && showCertPaste) {
                  <textarea id="saml-cert-input" class="form-control cert-input" [(ngModel)]="certInput" placeholder="-----BEGIN CERTIFICATE-----" [attr.aria-label]="idpCerts.length ? 'Paste another PEM certificate' : 'Paste a PEM certificate'"></textarea>
                  <div class="inline-actions mt-2">
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addCertificate(certInput)" [disabled]="addingCert || !certInput.trim()" data-testid="saml-add-cert">
                      <span class="material-symbols-outlined">add</span> {{ idpCerts.length ? 'Add this certificate' : 'Add certificate' }}
                    </button>
                    <label class="dg-btn dg-btn-secondary dg-btn-sm file-label">
                      <span class="material-symbols-outlined">upload_file</span> Upload .pem, .crt or .cer
                      <input type="file" accept=".pem,.crt,.cer" (change)="onCertificateFile($event)" data-testid="saml-cert-file" />
                    </label>
                  </div>
                } @else if (idpCerts.length < maxCertificates) {
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addingAnother = true" data-testid="saml-add-another">
                    <span class="material-symbols-outlined">add</span> Add another certificate
                  </button>
                }
                @if (certError) { <span class="dg-form-help text-danger d-block" role="alert" data-testid="saml-cert-error">{{ certError }}</span> }
              </div>

              <p class="section-title">Attributes</p>
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="dg-field">
                  <label class="form-label" for="saml-nameid-format">NameID format</label>
                  <select id="saml-nameid-format" class="form-select" [(ngModel)]="saml.nameIdFormat">
                    @for (format of nameIdFormats; track format.value) { <option [value]="format.value">{{ format.label }}</option> }
                  </select>
                </div>
                <div class="dg-field">
                  <label class="form-label" for="saml-email-attr">Email attribute</label>
                  <input id="saml-email-attr" class="form-control" [(ngModel)]="saml.emailAttribute" placeholder="NameID, or email" autocomplete="off" />
                  <span class="dg-form-help">Empty: the NameID when it is an email address, otherwise the attribute email.</span>
                </div>
                <div class="dg-field">
                  <label class="form-label" for="saml-subject-attr">Subject attribute</label>
                  <input id="saml-subject-attr" class="form-control" [(ngModel)]="saml.subjectAttribute" placeholder="NameID" autocomplete="off" />
                  <span class="dg-form-help">Empty: the NameID. A stable employee or object ID is better when the IdP has one.</span>
                </div>
              </div>
              @if (saml.nameIdFormat === transientFormat && !saml.subjectAttribute.trim()) {
                <div class="dg-callout is-warning mb-3" role="status" data-testid="saml-transient-warning">
                  <span class="material-symbols-outlined">warning</span>
                  <span>A transient NameID changes at every sign-in. Set a subject attribute, or sign-ins are refused.</span>
                </div>
              }
              <div class="dg-field">
                <span class="form-label">Required attributes</span>
                <span class="dg-form-help d-block mb-2">Optional attribute = value rows every sign-in must carry. A multi-valued attribute matches when it holds the value.</span>
                @for (row of saml.requiredAttributes; track $index) {
                  <div class="row-grid">
                    <input class="form-control" [(ngModel)]="row.attribute" placeholder="Attribute" [attr.aria-label]="'Attribute ' + ($index + 1)" />
                    <input class="form-control" [(ngModel)]="row.value" placeholder="Value" [attr.aria-label]="'Attribute value ' + ($index + 1)" />
                    <button type="button" class="dg-icon-btn is-danger" (click)="removeAttribute($index)" aria-label="Remove attribute"><span class="material-symbols-outlined">close</span></button>
                  </div>
                }
                <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addAttribute()"><span class="material-symbols-outlined">add</span> Add required attribute</button>
              </div>

              <p class="section-title">Security</p>
              <div class="dg-field">
                <label class="flex items-center gap-2 text-sm">
                  <input type="checkbox" [(ngModel)]="saml.requireSignedAssertion" data-testid="saml-require-signed" /> Require signed assertion
                </label>
                <span class="dg-form-help d-block">A signed response around an unsigned assertion is refused. Off: the whole response must be signed instead.</span>
                <label class="flex items-center gap-2 text-sm mt-2">
                  <input type="checkbox" [(ngModel)]="saml.signRequests" data-testid="saml-sign-requests" /> Sign authentication requests
                </label>
                <label class="flex items-center gap-2 text-sm mt-2">
                  <input type="checkbox" [(ngModel)]="saml.acceptEncryptedAssertions" data-testid="saml-encrypted" /> Accept encrypted assertions
                </label>
              </div>
              @if (needsSpKey || spKeyState !== 'none') {
                <div class="dg-field">
                  <span class="form-label">SP certificate and private key</span>
                  <div class="sp-key" data-testid="saml-sp-key">
                    @switch (spKeyState) {
                      @case ('generate') { <span class="text-sm" data-testid="saml-sp-pending">A new self-signed certificate (RSA 2048, 5 years) is generated when you save.</span> }
                      @case ('upload') { <span class="text-sm" data-testid="saml-sp-pending">The uploaded certificate and key are stored when you save.</span> }
                      @case ('remove') { <span class="text-sm" data-testid="saml-sp-pending">The SP certificate and key are removed when you save.</span> }
                      @case ('unreadable') {
                        <span class="dg-form-help text-danger">The saved private key can no longer be read (the server key changed). Generate or upload it again.</span>
                        <app-sso-certificate [info]="provider?.saml?.spCertificateInfo ?? null" />
                      }
                      @case ('saved') { <app-sso-certificate [info]="provider?.saml?.spCertificateInfo ?? null" /> }
                      @default { <span class="dg-form-help">Needed to sign requests or decrypt assertions. The private key is stored encrypted and never shown again.</span> }
                    }
                    <div class="inline-actions">
                      <button id="saml-sp-generate" type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="generateSpKey()" data-testid="saml-sp-generate">
                        <span class="material-symbols-outlined">key</span> {{ spKeyState === 'saved' ? 'Generate a new one' : 'Generate' }}
                      </button>
                      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="spUploadOpen = !spUploadOpen" [attr.aria-expanded]="spUploadOpen" data-testid="saml-sp-upload-toggle">
                        <span class="material-symbols-outlined">upload</span> Upload
                      </button>
                      @if (spKeyState === 'saved' && !needsSpKey) {
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="removeSpKey()" data-testid="saml-sp-remove">Remove</button>
                      }
                      @if (spKey) {
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="spKey = null" data-testid="saml-sp-undo">Undo</button>
                      }
                    </div>
                    @if (spUploadOpen) {
                      <textarea class="form-control cert-input" [(ngModel)]="spUpload.certificate" placeholder="-----BEGIN CERTIFICATE-----" aria-label="SP certificate"></textarea>
                      <textarea class="form-control cert-input" [(ngModel)]="spUpload.privateKey" placeholder="-----BEGIN PRIVATE KEY-----" aria-label="SP private key" autocomplete="off"></textarea>
                      <div class="inline-actions">
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="useUploadedSpKey()" [disabled]="!spUpload.certificate.trim() || !spUpload.privateKey.trim()" data-testid="saml-sp-upload">Use these</button>
                      </div>
                    }
                  </div>
                </div>
              }
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="dg-field">
                  <label class="form-label" for="saml-skew">Allowed clock skew (s)</label>
                  <input id="saml-skew" type="number" min="0" max="300" class="form-control" [(ngModel)]="saml.clockSkewSeconds" />
                </div>
              </div>
            }
          </section>

          <aside class="sp-aside" aria-label="Summary">
            <div class="dg-card sp-summary" data-testid="sso-summary">
              <p class="dg-section-label mb-0">Summary</p>

              <dl class="facts" data-testid="sso-summary-facts">
                <dt>Name</dt>
                <dd>@if (name.trim()) { {{ name.trim() }} } @else { <span class="muted">Not set</span> }</dd>
                <dt>Button</dt>
                <dd>{{ buttonLabel.trim() || 'Sign in with single sign-on' }}</dd>
                @if (type === 'oidc') {
                  <dt>Issuer</dt>
                  <dd>@if (oidc.issuer.trim()) { <span class="mono">{{ oidc.issuer.trim() }}</span> } @else { <span class="muted">Not set</span> }</dd>
                  <dt>Client ID</dt>
                  <dd>@if (oidc.clientId.trim()) { <span class="mono">{{ oidc.clientId.trim() }}</span> } @else { <span class="muted">Not set</span> }</dd>
                  <dt>Client secret</dt>
                  <dd [class.warn]="secretState === 'Must be entered again'" [class.muted]="secretState === 'Not set'" data-testid="sso-summary-secret">{{ secretState }}</dd>
                  <dt>Scopes</dt>
                  <dd class="mono">{{ oidc.scopes.trim() || 'openid' }}</dd>
                  <dt>Email</dt>
                  <dd><span class="mono">{{ oidc.emailClaim.trim() || 'email' }}</span>{{ oidc.requireVerifiedEmail ? ', must be verified' : ', not checked' }}</dd>
                  <dt>Required claims</dt>
                  <dd>
                    @if (filledClaims.length) {
                      @for (row of filledClaims; track $index) { <div class="mono">{{ row.claim }} = {{ row.value }}</div> }
                    } @else { <span class="muted">None</span> }
                  </dd>
                  <dt>Endpoints</dt>
                  <dd>{{ oidc.useDiscovery ? 'From discovery' : 'Entered by hand' }} · {{ oidc.clientAuthMethod }}</dd>
                } @else {
                  <dt>IdP entity ID</dt>
                  <dd>@if (saml.idpEntityId.trim()) { <span class="mono">{{ saml.idpEntityId.trim() }}</span> } @else { <span class="muted">{{ metadataPending ? 'From the metadata' : 'Not set' }}</span> }</dd>
                  <dt>SSO URL</dt>
                  <dd>@if (saml.ssoUrl.trim()) { <span class="mono">{{ saml.ssoUrl.trim() }}</span> } @else { <span class="muted">{{ metadataPending ? 'From the metadata' : 'Not set' }}</span> }</dd>
                  <dt>Certificates</dt>
                  <dd [class.warn]="certificatesExpired" data-testid="sso-summary-certs">{{ certificateSummary }}</dd>
                  <dt>NameID</dt>
                  <dd>{{ nameIdLabel }}</dd>
                  <dt>Email</dt>
                  <dd class="mono">{{ emailSource }}</dd>
                  <dt>Subject</dt>
                  <dd class="mono">{{ saml.subjectAttribute.trim() || 'NameID' }}</dd>
                  <dt>Required attributes</dt>
                  <dd>
                    @if (filledAttributes.length) {
                      @for (row of filledAttributes; track $index) { <div class="mono">{{ row.attribute }} = {{ row.value }}</div> }
                    } @else { <span class="muted">None</span> }
                  </dd>
                  <dt>Security</dt>
                  <dd data-testid="sso-summary-security">{{ securitySummary }}</dd>
                }
              </dl>

              <div>
                <p class="dg-section-label mb-2">Register at your provider</p>
                <app-sso-setup-urls [setup]="setup" [type]="type" [saved]="!!provider" />
              </div>

              <div>
                <p class="dg-section-label mb-2">Before people can use it</p>
                <ul class="steps" data-testid="sso-steps">
                  @for (step of steps; track step.label) {
                    <li>
                      <span class="material-symbols-outlined" [class.ok]="step.done" [class.todo]="!step.done">{{ step.done ? 'check_circle' : 'radio_button_unchecked' }}</span>
                      <span>{{ step.label }}<span class="detail">{{ step.detail }}</span></span>
                    </li>
                  }
                </ul>
              </div>

              <label class="switch-row" for="sso-enabled-switch">
                Show on the login page
                <button id="sso-enabled-switch" type="button" class="dg-switch" role="switch" [class.is-on]="enabled" [attr.aria-checked]="enabled"
                  (click)="enabled = !enabled" data-testid="sso-enabled"></button>
              </label>

              @if (saveBlocker; as blocker) {
                <div class="sp-next" role="status">
                  <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  <span><span class="sp-next-label">Next: </span><button type="button" class="sp-next-link" (click)="goToBlocker()"
                    data-testid="sso-save-blocker">{{ blocker }}</button></span>
                </div>
              }
              <div class="sp-actions">
                <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()" data-testid="sso-cancel">{{ provider && !dirty ? 'Done' : 'Cancel' }}</button>
                <!-- A disabled button gets no hover, so the tooltip sits on a wrapper. -->
                <span class="sp-save-wrap" [ngbTooltip]="saving ? '' : saveBlocker" placement="top">
                  <button type="button" class="dg-btn dg-btn-primary" (click)="save()" [disabled]="saving || !!saveBlocker" data-testid="sso-save">
                    {{ saving ? 'Saving…' : provider ? 'Update provider' : 'Create provider' }}
                  </button>
                </span>
              </div>
            </div>

            @if (provider) {
              <section class="dg-card sp-test" aria-label="Test sign-in" data-testid="sso-test-panel">
                <p class="dg-section-label mb-0">Test sign-in</p>
                @if (provider.lastSuccessAt) {
                  <p class="sp-test-status ok">Last worked {{ provider.lastSuccessAt | date: 'medium' }}</p>
                } @else {
                  <p class="sp-test-status">Not tested yet. A test signs in at the provider only, not to DepGate.</p>
                }
                @if (provider.lastError) {
                  <p class="sp-test-error" data-testid="sso-test-last-error">Last error: {{ provider.lastError }}</p>
                }
                @if (dirty) {
                  <p class="sp-test-status">Save your changes first: the test uses the saved settings.</p>
                }
                <div class="sp-actions">
                  <button type="button" class="dg-btn dg-btn-secondary" (click)="test()" [disabled]="testing || dirty" data-testid="sso-page-test">
                    <span class="material-symbols-outlined">science</span> {{ testing ? 'Testing…' : 'Test sign-in' }}
                  </button>
                </div>
              </section>
            }
          </aside>
        </div>
      }
    </div>
  `,
})
export class SsoProviderPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private sso = inject(SsoService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private tester = inject(SsoTestRunner);
  private host = inject(ElementRef);

  readonly nameIdFormats = NAMEID_FORMATS;
  readonly transientFormat = NAMEID_TRANSIENT;
  readonly maxCertificates = MAX_IDP_CERTIFICATES;

  provider: SsoProvider | null = null;
  loading = true;
  loadError = '';
  type: SsoProtocol = 'oidc';
  name = '';
  buttonLabel = '';
  enabled = false;
  clientSecret = '';
  oidc: OidcSettings = this.copyOidc(EMPTY_OIDC);
  endpoints = { authorizationEndpoint: '', tokenEndpoint: '', jwksUri: '', userinfoEndpoint: '' };
  showAdvanced = false;
  discovering = false;
  discovered: Discovered | null = null;
  discoverError = '';
  issuerNote = '';

  saml: SamlSettings = this.copySaml(EMPTY_SAML);
  metadataSource: MetadataSource = 'url';
  metadataXml = '';
  readingMetadata = false;
  metadataNote = '';
  metadataError = '';
  /** The IdP certificates with what the server read from them; `saml.idpCertificates` is built from these. */
  idpCerts: DescribedCertificate[] = [];
  certInput = '';
  certError = '';
  addingCert = false;
  /** The paste box stays hidden once a certificate is shown, so an empty field does not look like a failed read. */
  addingAnother = false;
  /** What Save does to the SP certificate; null keeps it. */
  spKey: SpKeyChange | null = null;
  spUploadOpen = false;
  spUpload = { certificate: '', privateKey: '' };

  saving = false;
  testing = false;
  validationError: string | null = null;
  /** The redirect URI and friends, known before the first save. */
  setup: ProviderSetup | null = null;
  signin: SigninSettings | null = null;

  private cleanState = '';

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    this.sso.signinSettings().subscribe({ next: (s) => (this.signin = s), error: () => (this.signin = null) });
    this.sso.setup(id ?? undefined).subscribe({ next: (setup) => (this.setup = setup), error: () => (this.setup = null) });
    if (!id) {
      if (this.route.snapshot.queryParamMap?.get('type') === 'saml') this.type = 'saml';
      this.loading = false;
      this.markClean();
      return;
    }
    this.sso.get(id).subscribe({
      next: (provider) => {
        this.apply(provider);
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.loadError = err.status === 404 ? 'It may have been deleted.' : (err.error?.error ?? 'Could not load the provider.');
      },
    });
  }

  private apply(provider: SsoProvider): void {
    this.provider = provider;
    this.type = provider.type;
    this.name = provider.name;
    this.buttonLabel = provider.buttonLabel;
    this.enabled = provider.enabled;
    this.clientSecret = '';
    if (provider.oidc) {
      this.oidc = this.copyOidc(provider.oidc);
      this.endpoints = {
        authorizationEndpoint: provider.oidc.authorizationEndpoint,
        tokenEndpoint: provider.oidc.tokenEndpoint,
        jwksUri: provider.oidc.jwksUri,
        userinfoEndpoint: provider.oidc.userinfoEndpoint,
      };
      this.showAdvanced = !provider.oidc.useDiscovery || provider.oidc.extraAuthParams.length > 0;
    }
    if (provider.saml) {
      const view = provider.saml;
      this.saml = this.copySaml(view);
      this.idpCerts = view.idpCertificates.map((pem, i) => ({ pem, info: view.idpCertificateInfo[i] ?? null }));
      this.addingAnother = false;
      this.certInput = '';
      this.metadataSource = view.metadataUrl ? 'url' : this.metadataSource === 'url' ? 'xml' : this.metadataSource;
      this.spKey = null;
      this.spUploadOpen = false;
      this.spUpload = { certificate: '', privateKey: '' };
    }
    this.markClean();
  }

  private copyOidc(source: OidcSettings): OidcSettings {
    return {
      ...source,
      requiredClaims: source.requiredClaims.map((row: ClaimRow) => ({ ...row })),
      extraAuthParams: source.extraAuthParams.map((row: ParamRow) => ({ ...row })),
    };
  }

  private copySaml(source: SamlSettings): SamlSettings {
    return {
      metadataUrl: source.metadataUrl,
      idpEntityId: source.idpEntityId,
      ssoUrl: source.ssoUrl,
      idpCertificates: [...source.idpCertificates],
      nameIdFormat: source.nameIdFormat,
      emailAttribute: source.emailAttribute,
      subjectAttribute: source.subjectAttribute,
      requiredAttributes: source.requiredAttributes.map((row: AttributeRow) => ({ ...row })),
      requireSignedAssertion: source.requireSignedAssertion,
      signRequests: source.signRequests,
      acceptEncryptedAssertions: source.acceptEncryptedAssertions,
      clockSkewSeconds: source.clockSkewSeconds,
    };
  }

  setType(type: SsoProtocol): void {
    if (this.provider) return;
    this.type = type;
  }

  get documentUrl(): string {
    return discoveryUrl(this.oidc.issuer);
  }

  get hasSavedSecret(): boolean {
    return Boolean(this.provider?.oidc?.hasClientSecret && !this.provider.oidc.clientSecretUnreadable);
  }

  get secretState(): string {
    if (this.clientSecret) return this.provider ? 'Replaced when saved' : 'Saved when you create';
    if (this.provider?.oidc?.clientSecretUnreadable) return 'Must be entered again';
    return this.hasSavedSecret ? 'Saved' : 'Not set';
  }

  get filledClaims(): ClaimRow[] {
    return this.oidc.requiredClaims.filter((row) => row.claim.trim() || row.value.trim());
  }

  get filledAttributes(): AttributeRow[] {
    return this.saml.requiredAttributes.filter((row) => row.attribute.trim() || row.value.trim());
  }

  /** A metadata URL is set: Save reads the entity ID, SSO URL and certificates from it. */
  get metadataPending(): boolean {
    return this.metadataSource === 'url' && Boolean(this.saml.metadataUrl.trim());
  }

  get certificatesExpired(): boolean {
    return this.idpCerts.length > 0 && this.idpCerts.every((cert) => cert.info?.expired);
  }

  /** The empty paste box is the way to add the first certificate. After one is shown, it opens only on request. */
  get showCertPaste(): boolean {
    return this.idpCerts.length === 0 || this.addingAnother;
  }

  get certificateSummary(): string {
    if (this.idpCerts.length === 0) return this.metadataPending ? 'From the metadata' : 'None';
    const expiries = this.idpCerts.map((cert) => cert.info?.notAfter).filter((v): v is string => Boolean(v)).sort();
    const first = expiries[0] ? new Date(expiries[0]).toLocaleDateString() : 'unknown';
    if (this.certificatesExpired) return `${this.idpCerts.length}, expired`;
    return `${this.idpCerts.length}, first expires ${first}`;
  }

  get nameIdLabel(): string {
    return NAMEID_FORMATS.find((f) => f.value === this.saml.nameIdFormat)?.label ?? this.saml.nameIdFormat;
  }

  get emailSource(): string {
    if (this.saml.emailAttribute.trim()) return this.saml.emailAttribute.trim();
    return this.saml.nameIdFormat === NAMEID_EMAIL ? 'NameID' : 'email';
  }

  get securitySummary(): string {
    const parts = [this.saml.requireSignedAssertion ? 'Signed assertions required' : 'Signed responses required'];
    if (this.saml.signRequests) parts.push('requests signed');
    if (this.saml.acceptEncryptedAssertions) parts.push('encrypted assertions accepted');
    return parts.join(' · ');
  }

  get needsSpKey(): boolean {
    return this.saml.signRequests || this.saml.acceptEncryptedAssertions;
  }

  /** The SP certificate as it will be after Save. */
  get spKeyState(): 'generate' | 'upload' | 'remove' | 'saved' | 'unreadable' | 'none' {
    if (this.spKey) return this.spKey.action;
    const saved = this.provider?.saml;
    if (!saved?.spCertificate) return 'none';
    return saved.spPrivateKeyUnreadable || !saved.hasSpPrivateKey ? 'unreadable' : 'saved';
  }

  private get hasUsableSpKey(): boolean {
    const state = this.spKeyState;
    return state === 'generate' || state === 'upload' || state === 'saved';
  }

  /** What still stops Save, as the next thing to do; empty when the form can be saved. */
  get saveBlocker(): string {
    return this.blocker()?.text ?? '';
  }

  /** The thing Save still needs, and the field it is about. */
  private blocker(): { text: string; target: string } | null {
    if (!this.name.trim()) return { text: 'Enter a name.', target: '#sso-name' };
    if (this.type === 'saml') {
      if (!this.metadataPending) {
        if (!this.saml.idpEntityId.trim()) return { text: 'Enter the IdP entity ID, or read the metadata.', target: '#saml-entity-id' };
        if (!this.saml.ssoUrl.trim()) return { text: 'Enter the IdP SSO URL.', target: '#saml-sso-url' };
        if (this.idpCerts.length === 0) return { text: 'Add the IdP signing certificate.', target: '#saml-cert-input' };
      }
      if (this.needsSpKey && !this.hasUsableSpKey) return { text: 'Generate or upload an SP certificate.', target: '#saml-sp-generate' };
      return null;
    }
    if (!this.oidc.issuer.trim()) return { text: 'Enter the issuer URL.', target: '#sso-issuer' };
    if (!this.oidc.clientId.trim()) return { text: 'Enter the client ID.', target: '#sso-client-id' };
    if (!this.clientSecret && !this.hasSavedSecret) return { text: 'Enter the client secret.', target: '#sso-client-secret' };
    return null;
  }

  /** Brings the field Save still needs into view and focuses it, with the same pulse as the policy form. */
  goToBlocker(): void {
    const blocker = this.blocker();
    if (!blocker) return;
    const field = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(blocker.target);
    if (!field) return;
    field.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    field.focus({ preventScroll: true });
    field.classList.remove('dg-attention');
    void field.offsetWidth; // restart the pulse when clicked twice
    field.classList.add('dg-attention');
    setTimeout(() => field.classList.remove('dg-attention'), 1400);
  }

  get steps(): Step[] {
    const domains = this.signin?.allowedDomains ?? [];
    return [
      {
        label: 'Allowed sign-in domain',
        done: domains.length > 0,
        detail: domains.length ? domains.join(', ') : 'Add one under Who may sign in',
      },
      this.type === 'saml' ? this.idpStep() : this.issuerStep(),
      {
        label: 'Saved',
        done: Boolean(this.provider) && !this.dirty,
        detail: this.provider ? (this.dirty ? 'Unsaved changes' : 'Up to date') : 'Create the provider',
      },
    ];
  }

  private issuerStep(): Step {
    const label = 'Issuer checked';
    if (this.discovered) return { label, done: true, detail: 'Discovery document read' };
    const savedAndHealthy = Boolean(this.provider && !this.provider.lastError && this.provider.oidc?.issuer === this.oidc.issuer.trim());
    return savedAndHealthy
      ? { label, done: true, detail: 'The provider answered when it was saved' }
      : { label, done: false, detail: 'Press Discover' };
  }

  private idpStep(): Step {
    const label = 'IdP details';
    const complete = Boolean(this.saml.idpEntityId.trim() && this.saml.ssoUrl.trim() && this.idpCerts.length);
    if (complete && this.certificatesExpired) return { label, done: false, detail: 'Every signing certificate has expired' };
    if (complete) return { label, done: true, detail: `Entity ID, SSO URL and ${this.idpCerts.length} signing certificate${this.idpCerts.length === 1 ? '' : 's'}` };
    return { label, done: false, detail: this.metadataPending ? 'Read from the metadata on save' : 'Read the metadata, or enter them' };
  }

  get dirty(): boolean {
    return !this.loading && !this.loadError && this.state() !== this.cleanState;
  }

  private state(): string {
    return JSON.stringify({ input: this.input(), secret: Boolean(this.clientSecret) });
  }

  private markClean(): void {
    this.cleanState = this.state();
  }

  /** For the route guard: true to leave, after asking when there are unsaved changes. */
  canLeave(): boolean | Promise<boolean> {
    if (!this.dirty) return true;
    return this.confirm.confirm({
      title: 'Discard changes?',
      message: this.provider ? 'Your changes to this provider have not been saved.' : 'This provider has not been created yet.',
      confirmText: 'Discard changes',
      tone: 'danger',
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty) event.preventDefault();
  }

  addClaim(): void { this.oidc.requiredClaims.push({ claim: '', value: '' }); }
  removeClaim(index: number): void { this.oidc.requiredClaims.splice(index, 1); }
  addParam(): void { this.oidc.extraAuthParams.push({ key: '', value: '' }); }
  removeParam(index: number): void { this.oidc.extraAuthParams.splice(index, 1); }
  addAttribute(): void { this.saml.requiredAttributes.push({ attribute: '', value: '' }); }
  removeAttribute(index: number): void { this.saml.requiredAttributes.splice(index, 1); }

  discover(): void {
    this.discovering = true;
    this.discoverError = '';
    this.discovered = null;
    this.issuerNote = '';
    const typed = this.oidc.issuer.trim();
    this.sso.discover(typed).subscribe({
      next: (found) => {
        this.discovering = false;
        this.discovered = found;
        // ID tokens carry the issuer exactly as published, trailing slash and all.
        if (found.issuer !== typed) {
          this.oidc.issuer = found.issuer;
          this.issuerNote = `Changed to ${found.issuer}, exactly as the provider publishes it.`;
        }
        if (this.oidc.useDiscovery) {
          this.endpoints = {
            authorizationEndpoint: found.authorizationEndpoint,
            tokenEndpoint: found.tokenEndpoint,
            jwksUri: found.jwksUri,
            userinfoEndpoint: found.userinfoEndpoint,
          };
        }
        if (found.tokenEndpointAuthMethods.length && !found.tokenEndpointAuthMethods.includes(this.oidc.clientAuthMethod)) {
          const supported = found.tokenEndpointAuthMethods.find((m) => m === 'client_secret_basic' || m === 'client_secret_post');
          if (supported) this.oidc.clientAuthMethod = supported as OidcSettings['clientAuthMethod'];
        }
      },
      error: (err) => {
        this.discovering = false;
        this.discoverError = err.error?.error ?? 'Could not read the discovery document';
      },
    });
  }

  /** R3: fills the entity ID, SSO URL and certificates from the metadata URL, pasted XML or uploaded file. */
  readMetadata(xml?: string): void {
    const source = this.metadataSource === 'url' ? { url: this.saml.metadataUrl.trim() } : { xml: (xml ?? this.metadataXml).trim() };
    this.readingMetadata = true;
    this.metadataNote = '';
    this.metadataError = '';
    this.sso.samlMetadata(source).subscribe({
      next: (found) => {
        this.readingMetadata = false;
        this.saml.idpEntityId = found.entityId;
        this.saml.ssoUrl = found.ssoUrl;
        this.idpCerts = found.certificates.slice(0, MAX_IDP_CERTIFICATES);
        this.certInput = '';
        this.addingAnother = false;
        const notes = [`Read ${found.entityId}: ${found.certificates.length} signing certificate${found.certificates.length === 1 ? '' : 's'}.`];
        if (found.nameIdFormats.length && !found.nameIdFormats.includes(this.saml.nameIdFormat)) {
          const known = found.nameIdFormats.find((f) => NAMEID_FORMATS.some((n) => n.value === f));
          if (known) {
            this.saml.nameIdFormat = known;
            notes.push(`NameID format set to ${this.nameIdLabel}, which the IdP offers.`);
          }
        }
        if (found.wantAuthnRequestsSigned && !this.saml.signRequests) {
          this.saml.signRequests = true;
          notes.push('The IdP wants signed requests, so Sign authentication requests is on.');
        }
        this.metadataNote = notes.join(' ');
      },
      error: (err) => {
        this.readingMetadata = false;
        this.metadataError = err.error?.error ?? 'Could not read the metadata';
      },
    });
  }

  onMetadataFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      this.metadataXml = text;
      this.readMetadata(text);
    });
  }

  addCertificate(text: string): void {
    const pem = text.trim();
    if (!pem) return;
    this.addingCert = true;
    this.certError = '';
    this.sso.certificateInfo([pem]).subscribe({
      next: ({ certificates }) => {
        this.addingCert = false;
        const fresh = certificates.filter((cert) => !this.idpCerts.some((have) => have.pem === cert.pem));
        if (this.idpCerts.length + fresh.length > MAX_IDP_CERTIFICATES) {
          this.certError = `At most ${MAX_IDP_CERTIFICATES} signing certificates: the current one and the next. Remove one first.`;
          return;
        }
        this.idpCerts = [...this.idpCerts, ...fresh];
        this.certInput = '';
        this.addingAnother = false;
      },
      error: (err) => {
        this.addingCert = false;
        this.certError = err.error?.error ?? 'This is not a PEM certificate';
      },
    });
  }

  onCertificateFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      this.addCertificate(text);
      input.value = '';
    });
  }

  removeCertificate(index: number): void {
    this.idpCerts = this.idpCerts.filter((_, i) => i !== index);
  }

  generateSpKey(): void {
    this.spKey = { action: 'generate' };
    this.spUploadOpen = false;
  }

  useUploadedSpKey(): void {
    this.spKey = { action: 'upload', certificate: this.spUpload.certificate.trim(), privateKey: this.spUpload.privateKey.trim() };
    this.spUploadOpen = false;
  }

  removeSpKey(): void {
    this.spKey = { action: 'remove' };
  }

  private input(): SsoProviderInput {
    const common = {
      ...(!this.provider && this.setup ? { id: this.setup.id } : {}),
      type: this.type,
      name: this.name.trim(),
      buttonLabel: this.buttonLabel.trim(),
      enabled: this.enabled,
    };
    if (this.type === 'saml') {
      return {
        ...common,
        saml: {
          ...this.saml,
          metadataUrl: this.metadataSource === 'url' ? this.saml.metadataUrl.trim() : '',
          idpEntityId: this.saml.idpEntityId.trim(),
          ssoUrl: this.saml.ssoUrl.trim(),
          idpCertificates: this.idpCerts.map((cert) => cert.pem),
          emailAttribute: this.saml.emailAttribute.trim(),
          subjectAttribute: this.saml.subjectAttribute.trim(),
          clockSkewSeconds: Number(this.saml.clockSkewSeconds),
          ...(this.spKey ? { spKey: this.spKey } : {}),
        },
      };
    }
    const manual = !this.oidc.useDiscovery;
    return {
      ...common,
      oidc: {
        ...this.oidc,
        clockSkewSeconds: Number(this.oidc.clockSkewSeconds),
        authorizationEndpoint: manual ? this.endpoints.authorizationEndpoint.trim() : '',
        tokenEndpoint: manual ? this.endpoints.tokenEndpoint.trim() : '',
        jwksUri: manual ? this.endpoints.jwksUri.trim() : '',
        userinfoEndpoint: manual ? this.endpoints.userinfoEndpoint.trim() : '',
        ...(this.clientSecret ? { clientSecret: this.clientSecret } : {}),
      },
    };
  }

  save(): void {
    if (this.saving || this.saveBlocker) return;
    this.saving = true;
    const creating = !this.provider;
    const typedIssuer = this.oidc.issuer.trim();
    const request = this.provider ? this.sso.update(this.provider.id, this.input()) : this.sso.create(this.input());
    request.subscribe({
      next: (result) => {
        this.saving = false;
        this.validationError = result.validationError;
        if (result.provider.oidc && result.provider.oidc.issuer !== typedIssuer) {
          this.issuerNote = `Saved as ${result.provider.oidc.issuer}, exactly as the provider publishes it.`;
        }
        if (result.validationError) {
          // Stay: the reason is shown at the top of the form.
          this.toast.warning('Saved, but not turned on');
          this.apply(result.provider);
          if (creating) this.reopen(result.provider.id);
          return;
        }
        if (creating) {
          this.toast.success(result.provider.enabled ? 'Provider created and turned on' : 'Provider created. Test sign-in, then turn it on.');
          this.apply(result.provider);
          this.reopen(result.provider.id);
          return;
        }
        // Stay, so the next step, Test sign-in, is right here.
        this.toast.success('Provider updated');
        this.apply(result.provider);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Save failed');
      },
    });
  }

  /** After creating, the address becomes the provider's edit page, so a reload or Back keeps it. */
  private reopen(id: string): void {
    void this.router.navigate(['/access/sso', id, 'edit'], { replaceUrl: true });
  }

  async test(): Promise<void> {
    if (!this.provider || this.dirty) return;
    this.testing = true;
    await this.tester.run(this.provider);
    this.testing = false;
    this.sso.get(this.provider.id).subscribe({ next: (fresh) => this.apply(fresh) });
  }

  cancel(): void {
    void this.router.navigateByUrl(RETURN_URL);
  }
}
