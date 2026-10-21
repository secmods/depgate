import { DataSource } from 'typeorm';
import { SsoProvider, oidcConfig, samlConfig, type OidcProviderConfig, type SamlProviderConfig } from '../db/entities/SsoProvider.js';
import { decryptSecret } from './mail-settings.js';
import { describeCertificate, type CertificateInfo } from './saml-certs.js';
import type { ProviderHandle } from './sso-oidc.js';
import { samlUrls, type SamlProviderHandle } from './sso-saml.js';

/** The URLs the admin registers at the identity provider: OIDC (R2) and SAML (R3). */
export function providerUrls(
  id: string,
  publicUrl: string
): {
  redirectUri: string;
  initiateLoginUri: string;
  postLogoutRedirectUri: string;
  spEntityId: string;
  acsUrl: string;
  spMetadataUrl: string;
} {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    redirectUri: `${base}/api/auth/sso/${id}/callback`,
    initiateLoginUri: `${base}/api/auth/sso/${id}/start`,
    postLogoutRedirectUri: `${base}/login`,
    ...samlUrls(id, base),
  };
}

export interface SamlView extends SamlProviderConfig {
  idpCertificateInfo: Array<CertificateInfo | null>;
  spCertificateInfo: CertificateInfo | null;
  hasSpPrivateKey: boolean;
  /** JWT_SECRET changed since the key was saved: generate or upload it again. */
  spPrivateKeyUnreadable: boolean;
}

export interface ProviderView {
  id: string;
  type: string;
  name: string;
  buttonLabel: string;
  enabled: boolean;
  oidc: (OidcProviderConfig & { hasClientSecret: boolean; clientSecretUnreadable: boolean }) | null;
  saml: SamlView | null;
  /** The IdP certificate that expires first (SAML), for the provider list. */
  certificateExpiresAt: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  urls: ReturnType<typeof providerUrls>;
  createdAt: string;
  updatedAt: string;
}

function certInfo(pem: string): CertificateInfo | null {
  try {
    return describeCertificate(pem);
  } catch {
    return null;
  }
}

function samlView(provider: SsoProvider): SamlView {
  const cfg = samlConfig(provider);
  const hasSpPrivateKey = Boolean(provider.spPrivateKeyEnc);
  return {
    ...cfg,
    idpCertificateInfo: cfg.idpCertificates.map(certInfo),
    spCertificateInfo: cfg.spCertificate ? certInfo(cfg.spCertificate) : null,
    hasSpPrivateKey,
    spPrivateKeyUnreadable: hasSpPrivateKey && decryptSecret(provider.spPrivateKeyEnc) === '',
  };
}

/** The provider as the admin API returns it. The client secret and SP private key never leave the server. */
export function providerView(provider: SsoProvider, publicUrl: string): ProviderView {
  const saml = provider.type === 'saml' ? samlView(provider) : null;
  let oidc: ProviderView['oidc'] = null;
  if (provider.type === 'oidc') {
    const hasClientSecret = Boolean(provider.clientSecretEnc);
    oidc = {
      ...oidcConfig(provider),
      hasClientSecret,
      // JWT_SECRET changed since the secret was saved: the admin must enter it again.
      clientSecretUnreadable: hasClientSecret && decryptSecret(provider.clientSecretEnc) === '',
    };
  }
  const expiries = (saml?.idpCertificateInfo ?? []).filter((info): info is CertificateInfo => info !== null).map((info) => info.notAfter);
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    buttonLabel: provider.buttonLabel,
    enabled: provider.enabled,
    oidc,
    saml,
    certificateExpiresAt: expiries.length ? expiries.sort()[0] : null,
    lastError: provider.lastError,
    lastSuccessAt: provider.lastSuccessAt?.toISOString() ?? null,
    urls: providerUrls(provider.id, publicUrl),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

export function providerHandle(provider: SsoProvider): ProviderHandle {
  return {
    id: provider.id,
    updatedAt: provider.updatedAt,
    config: oidcConfig(provider),
    clientSecret: decryptSecret(provider.clientSecretEnc),
  };
}

export function samlHandle(provider: SsoProvider): SamlProviderHandle {
  return {
    id: provider.id,
    config: samlConfig(provider),
    spPrivateKey: provider.spPrivateKeyEnc ? decryptSecret(provider.spPrivateKeyEnc) : '',
  };
}

export async function findProvider(db: DataSource, id: string): Promise<SsoProvider | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return db.getRepository(SsoProvider).findOne({ where: { id } });
}

/**
 * Notes the outcome on the provider row, for the Settings list. Best effort. Raw SQL so `updated_at`
 * stays put: it versions the cached provider metadata, which a sign-in must not throw away.
 */
export async function noteProviderOutcome(db: DataSource, id: string, error: string | null): Promise<void> {
  const sql =
    error === null
      ? `UPDATE sso_providers SET last_error = NULL, last_success_at = now() WHERE id = $1`
      : `UPDATE sso_providers SET last_error = $2 WHERE id = $1`;
  await db.query(sql, error === null ? [id] : [id, error.slice(0, 2000)]).catch(() => undefined);
}
