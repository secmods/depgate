import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface LoginProvider {
  id: string;
  type: 'oidc' | 'saml';
  buttonLabel: string;
}

export interface ClaimRow { claim: string; value: string; }
export interface ParamRow { key: string; value: string; }
export interface AttributeRow { attribute: string; value: string; }

export type SsoProtocol = 'oidc' | 'saml';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  scopes: string;
  emailClaim: string;
  requireVerifiedEmail: boolean;
  requiredClaims: ClaimRow[];
  useDiscovery: boolean;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string;
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  clockSkewSeconds: number;
  extraAuthParams: ParamRow[];
}

/** What DepGate shows about an X.509 certificate (requirements_sso.md R3). */
export interface CertificateInfo {
  subject: string;
  issuer: string;
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  expired: boolean;
  /** Within 30 days of expiry. */
  expiresSoon: boolean;
}

export interface DescribedCertificate { pem: string; info: CertificateInfo | null; }

export interface SamlSettings {
  metadataUrl: string;
  idpEntityId: string;
  ssoUrl: string;
  idpCertificates: string[];
  nameIdFormat: string;
  emailAttribute: string;
  subjectAttribute: string;
  requiredAttributes: AttributeRow[];
  requireSignedAssertion: boolean;
  signRequests: boolean;
  acceptEncryptedAssertions: boolean;
  clockSkewSeconds: number;
}

export interface SamlView extends SamlSettings {
  spCertificate: string;
  idpCertificateInfo: Array<CertificateInfo | null>;
  spCertificateInfo: CertificateInfo | null;
  hasSpPrivateKey: boolean;
  spPrivateKeyUnreadable: boolean;
}

/** On save: replace the SAML SP certificate and key, or drop them. Missing keeps them. */
export type SpKeyChange =
  | { action: 'generate' }
  | { action: 'upload'; certificate: string; privateKey: string }
  | { action: 'remove' };

export interface SsoProvider {
  id: string;
  type: SsoProtocol;
  name: string;
  buttonLabel: string;
  enabled: boolean;
  /** Set for OIDC providers. */
  oidc: (OidcSettings & { hasClientSecret: boolean; clientSecretUnreadable: boolean }) | null;
  /** Set for SAML providers. */
  saml: SamlView | null;
  /** SAML: when the first IdP certificate expires. */
  certificateExpiresAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  urls: ProviderUrls;
  createdAt: string;
  updatedAt: string;
}

export interface SsoProviderInput {
  /** Create only: the id from setup(), so the URLs shown before saving stay valid. */
  id?: string;
  type: SsoProtocol;
  name: string;
  buttonLabel: string;
  enabled: boolean;
  /** OIDC. Empty or missing secret keeps the saved one. */
  oidc?: OidcSettings & { clientSecret?: string };
  saml?: SamlSettings & { spKey?: SpKeyChange };
}

export interface ProviderUrls {
  redirectUri: string;
  initiateLoginUri: string;
  postLogoutRedirectUri: string;
  /** SAML: the SP entity ID is also where the SP metadata is served. */
  spEntityId: string;
  acsUrl: string;
  spMetadataUrl: string;
}

export interface SamlMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: DescribedCertificate[];
  nameIdFormats: string[];
  wantAuthnRequestsSigned: boolean;
}

export const NAMEID_FORMATS: Array<{ value: string; label: string }> = [
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'Email address' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', label: 'Persistent' },
  { value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'Unspecified' },
  { value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', label: 'Transient (set a subject attribute)' },
];

/** Days until the certificate expires, negative once it has. */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

/** The URLs to register at the provider, known before the first save. */
export interface ProviderSetup {
  id: string;
  urls: ProviderUrls;
  publicUrl: string;
  /** `default`: DepGate has not learned its public address yet, so the URLs may change. */
  publicUrlSource: 'setting' | 'learned' | 'default';
}

/** The provider's discovery document, for a link the admin can open. Empty when the issuer is not a URL yet. */
export function discoveryUrl(issuer: string): string {
  const value = issuer.trim();
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return '';
  return `${value.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export interface SaveResult {
  provider: SsoProvider;
  /** Why it could not be turned on; it was saved turned off. */
  validationError: string | null;
}

export interface Discovered {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string;
  signingAlgs: string[];
  tokenEndpointAuthMethods: string[];
  scopesSupported: string[];
  claimsSupported: string[];
}

export interface TestCheck { label: string; ok: boolean; detail: string; }

export type TestResult =
  | { status: 'pending' }
  | {
      status: 'done';
      ok: boolean;
      outcome: string;
      reason: string | null;
      error: string | null;
      subject: string | null;
      email: string | null;
      claims: Record<string, unknown> | null;
      checks: TestCheck[];
    };

export interface SigninSettings {
  allowedDomains: string[];
  allowUnlistedSso: boolean;
  ssoEnabled: boolean;
}

export interface SsoSession {
  token: string;
  registryToken: string;
  user: { email: string; role: string };
  returnTo: string | null;
}

@Injectable({ providedIn: 'root' })
export class SsoService {
  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  /** Enabled providers, for the login page. No sign-in needed. */
  loginProviders(): Observable<LoginProvider[]> {
    return this.http.get<LoginProvider[]>('/api/auth/providers');
  }

  /** Where the browser goes to start single sign-on. */
  startUrl(id: string, returnTo: string | null): string {
    const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    return `/api/auth/sso/${encodeURIComponent(id)}/start${query}`;
  }

  exchange(code: string): Observable<SsoSession> {
    return this.http.post<SsoSession>('/api/auth/sso/exchange', { code });
  }

  list(): Observable<SsoProvider[]> {
    return this.http.get<SsoProvider[]>('/api/admin/sso-providers', { headers: this.headers() });
  }

  get(id: string): Observable<SsoProvider> {
    return this.http.get<SsoProvider>(`/api/admin/sso-providers/${id}`, { headers: this.headers() });
  }

  create(body: SsoProviderInput): Observable<SaveResult> {
    return this.http.post<SaveResult>('/api/admin/sso-providers', body, { headers: this.headers() });
  }

  update(id: string, body: SsoProviderInput): Observable<SaveResult> {
    return this.http.put<SaveResult>(`/api/admin/sso-providers/${id}`, body, { headers: this.headers() });
  }

  setEnabled(id: string, enabled: boolean): Observable<SsoProvider> {
    return this.http.patch<SsoProvider>(`/api/admin/sso-providers/${id}`, { enabled }, { headers: this.headers() });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`/api/admin/sso-providers/${id}`, { headers: this.headers() });
  }

  /** URLs for a saved provider, or a fresh id and URLs for one being added. */
  setup(id?: string): Observable<ProviderSetup> {
    return this.http.get<ProviderSetup>('/api/admin/sso-providers/setup', { headers: this.headers(), params: id ? { id } : {} });
  }

  discover(issuer: string): Observable<Discovered> {
    return this.http.post<Discovered>('/api/admin/sso-providers/discover', { issuer }, { headers: this.headers() });
  }

  /** Reads SAML IdP metadata from a URL (fetched by the server) or pasted XML. */
  samlMetadata(source: { url: string } | { xml: string }): Observable<SamlMetadata> {
    return this.http.post<SamlMetadata>('/api/admin/sso-providers/saml-metadata', source, { headers: this.headers() });
  }

  /** Subject, issuer, fingerprint and expiry of pasted PEM certificates. */
  certificateInfo(certificates: string[]): Observable<{ certificates: DescribedCertificate[] }> {
    return this.http.post<{ certificates: DescribedCertificate[] }>('/api/admin/sso-providers/certificate-info', { certificates }, { headers: this.headers() });
  }

  startTest(id: string): Observable<{ ticket: string; startUrl: string }> {
    return this.http.post<{ ticket: string; startUrl: string }>(`/api/admin/sso-providers/${id}/test`, {}, { headers: this.headers() });
  }

  testResult(ticket: string): Observable<TestResult> {
    return this.http.get<TestResult>(`/api/admin/sso-providers/test/${ticket}`, { headers: this.headers() });
  }

  signinSettings(): Observable<SigninSettings> {
    return this.http.get<SigninSettings>('/api/admin/signin-settings', { headers: this.headers() });
  }

  saveSigninSettings(body: { allowedDomains: string[]; allowUnlistedSso: boolean }): Observable<SigninSettings> {
    return this.http.put<SigninSettings>('/api/admin/signin-settings', body, { headers: this.headers() });
  }
}

/** What the login page says for each `sso_error` code. Plain words, no details (requirements_sso.md R19). */
export const SSO_ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: "Your account's domain is not allowed to sign in. Ask your DepGate administrator.",
  email_unverified: 'Your identity provider has not verified your email address. Verify it there, then try again.',
  email_missing: 'Your identity provider did not send an email address. Ask your DepGate administrator.',
  claim_mismatch: 'Your account is not allowed to sign in to DepGate. Ask your DepGate administrator.',
  not_invited: "You don't have a DepGate account yet. Ask your DepGate administrator to add you.",
  subject_mismatch: 'This email is already linked to a different account at your identity provider. Ask your DepGate administrator.',
  user_disabled: 'Your DepGate account is disabled. Ask your DepGate administrator.',
  invalid_response: "Sign-in failed: the identity provider's answer could not be verified. Try again, or ask your administrator.",
  state_invalid: 'The sign-in took too long or was already used. Try again.',
  provider_error: 'Sign-in was cancelled or refused by your identity provider.',
  provider_unavailable: 'Single sign-on is unavailable right now. Try again later, or sign in with your password.',
  rate_limited: 'Too many sign-in attempts. Wait a few minutes and try again.',
};

export function ssoErrorMessage(code: string | null): string {
  if (!code) return '';
  return SSO_ERROR_MESSAGES[code] ?? 'Single sign-on failed. Try again.';
}
