import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SsoProviderType = 'oidc' | 'saml';

/** Non-secret OIDC settings, exactly as entered in Settings → Single sign-on (requirements_sso.md R2). */
export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  scopes: string;
  emailClaim: string;
  requireVerifiedEmail: boolean;
  requiredClaims: Array<{ claim: string; value: string }>;
  useDiscovery: boolean;
  /** Only when discovery is off. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string;
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  clockSkewSeconds: number;
  extraAuthParams: Array<{ key: string; value: string }>;
}

/** Non-secret SAML settings (requirements_sso.md R3). IdP and SP certificates are public, so they live here. */
export interface SamlProviderConfig {
  /** Where the IdP metadata was read from; empty when it was pasted, uploaded or typed. */
  metadataUrl: string;
  idpEntityId: string;
  /** HTTP-Redirect binding endpoint for the AuthnRequest. */
  ssoUrl: string;
  /** PEM. One or two, so the IdP can rotate without downtime. */
  idpCertificates: string[];
  nameIdFormat: string;
  /** Empty: the NameID when its format is emailAddress, otherwise the attribute `email`. */
  emailAttribute: string;
  /** Empty: the NameID. */
  subjectAttribute: string;
  requiredAttributes: Array<{ attribute: string; value: string }>;
  requireSignedAssertion: boolean;
  signRequests: boolean;
  acceptEncryptedAssertions: boolean;
  /** PEM, empty when none. Its private key is `sp_private_key_enc`. */
  spCertificate: string;
  clockSkewSeconds: number;
}

export type SsoProviderConfig = OidcProviderConfig | SamlProviderConfig;

/** An identity provider people sign in through, OIDC or SAML. `type` says which shape `config` has. */
@Entity('sso_providers')
export class SsoProvider {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_sso_providers' })
  id!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: SsoProviderType;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ name: 'button_label', type: 'varchar', length: 128 })
  buttonLabel!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ type: 'jsonb' })
  config!: SsoProviderConfig;

  /** OIDC. AES-256-GCM, never returned by the API. Empty when none was entered. */
  @Column({ name: 'client_secret_enc', type: 'text', default: '' })
  clientSecretEnc!: string;

  /** SAML SP private key (PKCS#8 PEM), AES-256-GCM, never returned by the API. Empty when there is no SP certificate. */
  @Column({ name: 'sp_private_key_enc', type: 'text', default: '' })
  spPrivateKeyEnc!: string;

  /** Why the last save or sign-in attempt could not talk to the provider. Cleared by a good one. */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}

export function oidcConfig(provider: Pick<SsoProvider, 'type' | 'config'>): OidcProviderConfig {
  if (provider.type !== 'oidc') throw new Error('Not an OIDC provider');
  return provider.config as OidcProviderConfig;
}

export function samlConfig(provider: Pick<SsoProvider, 'type' | 'config'>): SamlProviderConfig {
  if (provider.type !== 'saml') throw new Error('Not a SAML provider');
  return provider.config as SamlProviderConfig;
}
