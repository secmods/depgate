/**
 * Settings → Single sign-on and the sign-in settings under Users & access (requirements_sso.md §5.1, §5.2).
 * Security only. Every value is entered here; nothing comes from environment variables.
 */
import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ROLE_SECURITY } from '../auth/roles.js';
import { config } from '../config.js';
import { SsoProvider, oidcConfig, samlConfig, type SamlProviderConfig } from '../db/entities/SsoProvider.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { decryptSecret, encryptSecret } from '../services/mail-settings.js';
import { randomUUID } from 'node:crypto';
import { parseOrigin, publicUrlInfo, resolvePublicUrl } from '../services/public-url.js';
import { checkKeyPair, describeCertificate, generateSpCertificate, splitCertificates } from '../services/saml-certs.js';
import { loadSigninSettings, saveSigninSettings } from '../services/signin-settings.js';
import { checkOidcProvider, discoverOidc, forgetOidcProvider, OidcError } from '../services/sso-oidc.js';
import { findProvider, providerUrls, providerView } from '../services/sso-providers.js';
import { idpUrlProblem, normalizeDomainList, normalizeProviderInput, type ProviderInput, type SpKeyChange } from '../services/sso-rules.js';
import { fetchIdpMetadata, parseIdpMetadata, type IdpMetadata } from '../services/sso-saml.js';
import { readTestResult, saveTestTicket } from '../services/sso-store.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const errorBody = { type: 'object', properties: { error: { type: 'string' } } } as const;

const rowSchema = {
  type: 'array',
  items: { type: 'object', additionalProperties: { type: 'string' } },
} as const;

const oidcSchema = {
  type: 'object',
  properties: {
    issuer: { type: 'string' },
    clientId: { type: 'string' },
    clientSecret: { type: 'string', description: 'Write only. Leave out or empty to keep the saved secret.' },
    scopes: { type: 'string' },
    emailClaim: { type: 'string' },
    requireVerifiedEmail: { type: 'boolean' },
    requiredClaims: rowSchema,
    useDiscovery: { type: 'boolean' },
    authorizationEndpoint: { type: 'string' },
    tokenEndpoint: { type: 'string' },
    jwksUri: { type: 'string' },
    userinfoEndpoint: { type: 'string' },
    clientAuthMethod: { type: 'string', enum: ['client_secret_basic', 'client_secret_post'] },
    clockSkewSeconds: { type: 'integer' },
    extraAuthParams: rowSchema,
  },
} as const;

const samlSchema = {
  type: 'object',
  properties: {
    metadataUrl: { type: 'string', description: 'Read on save: the entity ID, SSO URL and certificates come from it.' },
    idpEntityId: { type: 'string' },
    ssoUrl: { type: 'string', description: 'HTTP-Redirect binding.' },
    idpCertificates: { type: 'array', items: { type: 'string' }, description: 'PEM, at most two.' },
    nameIdFormat: { type: 'string' },
    emailAttribute: { type: 'string' },
    subjectAttribute: { type: 'string' },
    requiredAttributes: rowSchema,
    requireSignedAssertion: { type: 'boolean' },
    signRequests: { type: 'boolean' },
    acceptEncryptedAssertions: { type: 'boolean' },
    clockSkewSeconds: { type: 'integer' },
    spKey: {
      type: 'object',
      description: 'Write only. Leave out to keep the SP certificate and key.',
      properties: {
        action: { type: 'string', enum: ['keep', 'generate', 'upload', 'remove'] },
        certificate: { type: 'string' },
        privateKey: { type: 'string' },
      },
    },
  },
} as const;

const providerBody = {
  type: 'object',
  required: ['name'],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Create only: the id from GET /api/admin/sso-providers/setup, so the URLs shown before saving stay valid.' },
    type: { type: 'string', enum: ['oidc', 'saml'] },
    name: { type: 'string' },
    buttonLabel: { type: 'string' },
    enabled: { type: 'boolean' },
    oidc: oidcSchema,
    saml: samlSchema,
  },
} as const;

const certificateInfoSchema = {
  type: 'object',
  nullable: true,
  properties: {
    subject: { type: 'string' },
    issuer: { type: 'string' },
    fingerprint: { type: 'string' },
    notBefore: { type: 'string' },
    notAfter: { type: 'string' },
    expired: { type: 'boolean' },
    expiresSoon: { type: 'boolean' },
  },
} as const;

const urlsSchema = {
  type: 'object',
  properties: {
    redirectUri: { type: 'string' },
    initiateLoginUri: { type: 'string' },
    postLogoutRedirectUri: { type: 'string' },
    spEntityId: { type: 'string' },
    acsUrl: { type: 'string' },
    spMetadataUrl: { type: 'string' },
  },
} as const;

const providerViewSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string' },
    name: { type: 'string' },
    buttonLabel: { type: 'string' },
    enabled: { type: 'boolean' },
    oidc: {
      type: 'object',
      nullable: true,
      properties: {
        ...Object.fromEntries(Object.entries(oidcSchema.properties).filter(([key]) => key !== 'clientSecret')),
        hasClientSecret: { type: 'boolean' },
        clientSecretUnreadable: { type: 'boolean' },
      },
    },
    saml: {
      type: 'object',
      nullable: true,
      properties: {
        ...Object.fromEntries(Object.entries(samlSchema.properties).filter(([key]) => key !== 'spKey')),
        spCertificate: { type: 'string' },
        idpCertificateInfo: { type: 'array', items: certificateInfoSchema },
        spCertificateInfo: certificateInfoSchema,
        hasSpPrivateKey: { type: 'boolean' },
        spPrivateKeyUnreadable: { type: 'boolean' },
      },
    },
    certificateExpiresAt: { type: 'string', nullable: true },
    lastError: { type: 'string', nullable: true },
    lastSuccessAt: { type: 'string', nullable: true },
    urls: urlsSchema,
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const saveResponse = {
  type: 'object',
  properties: {
    provider: providerViewSchema,
    /** Set when the provider could not be enabled; it was saved turned off. */
    validationError: { type: 'string', nullable: true },
  },
} as const;

const signinSettingsSchema = {
  type: 'object',
  properties: {
    allowedDomains: { type: 'array', items: { type: 'string' } },
    allowUnlistedSso: { type: 'boolean' },
    ssoEnabled: { type: 'boolean', description: 'True while at least one identity provider is turned on.' },
  },
} as const;

const describedCertificates = {
  type: 'array',
  items: { type: 'object', properties: { pem: { type: 'string' }, info: certificateInfoSchema } },
} as const;

function describeAll(pems: string[]): Array<{ pem: string; info: ReturnType<typeof describeCertificate> }> {
  return pems.map((pem) => ({ pem, info: describeCertificate(pem) }));
}

/** R4 for SAML: what stops the provider from being used, without contacting the IdP. */
export function samlConfigProblem(cfg: SamlProviderConfig, spKeyReadable: boolean): string | null {
  if (!cfg.idpEntityId) return 'Enter the IdP entity ID, or read it from the metadata.';
  if (!cfg.ssoUrl) return 'Enter the IdP SSO URL, or read it from the metadata.';
  const urlProblem = idpUrlProblem(cfg.ssoUrl, config.auth.ssoAllowInsecureHttp);
  if (urlProblem) return `IdP SSO URL ${urlProblem}`;
  if (cfg.idpCertificates.length === 0) return 'Add the IdP signing certificate.';
  const now = new Date();
  const infos = cfg.idpCertificates.map((pem) => describeCertificate(pem, now));
  if (infos.every((info) => info.expired)) {
    return `The IdP signing certificate expired on ${infos.map((info) => info.notAfter.slice(0, 10)).join(' and ')}. Add the new one.`;
  }
  if ((cfg.signRequests || cfg.acceptEncryptedAssertions) && !(cfg.spCertificate && spKeyReadable)) {
    return 'The SP private key cannot be read (the server key changed). Generate or upload the SP certificate again.';
  }
  return null;
}

const ssoAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });
  const providers = () => fastify.db.getRepository(SsoProvider);

  function audit(request: FastifyRequest, decision: string, packageName: string, reasons: string[], metadata?: Record<string, string>) {
    const { reqIp, userAgent, requester } = getRequestContext(request);
    void logAudit(fastify.db, {
      requesterIp: reqIp,
      userAgent,
      requester,
      ecosystem: 'sso',
      packageName,
      repository: null,
      decision,
      conditionReasons: reasons,
      metadata: metadata ?? null,
    });
  }

  const spKeyReadable = (provider: SsoProvider) => Boolean(provider.spPrivateKeyEnc && decryptSecret(provider.spPrivateKeyEnc));

  /** Why the provider cannot be turned on now, or null (R4, R5a, R9). Contacts an OIDC provider unless told the check already ran. */
  async function enableProblem(provider: SsoProvider, opts: { reachable?: boolean } = {}): Promise<string | null> {
    const settings = await loadSigninSettings(fastify.db);
    if (settings.allowedDomains.length === 0) {
      return 'Add at least one allowed sign-in domain under Settings → Users & access before turning on single sign-on.';
    }
    if (provider.type === 'oidc' && (!provider.clientSecretEnc || !decryptSecret(provider.clientSecretEnc))) {
      return 'Enter the client secret.';
    }
    if (provider.type === 'saml') {
      const problem = samlConfigProblem(samlConfig(provider), spKeyReadable(provider));
      if (problem) return problem;
    }
    if (!parseOrigin(await resolvePublicUrl(fastify.db))) {
      return 'DepGate does not know its public address yet. Set UI_URL, or sign in once as a Security user from the address people use.';
    }
    return opts.reachable ? null : (await reach(provider)).problem;
  }

  /** OIDC: contacts the provider and returns the issuer exactly as published. SAML: checks the saved settings. */
  async function reach(provider: SsoProvider): Promise<{ problem: string | null; issuer?: string }> {
    if (provider.type === 'saml') return { problem: samlConfigProblem(samlConfig(provider), spKeyReadable(provider)) };
    try {
      const found = await checkOidcProvider(oidcConfig(provider));
      return { problem: null, issuer: found.issuer };
    } catch (err) {
      return { problem: err instanceof Error ? err.message : String(err) };
    }
  }

  function applySpKey(row: SsoProvider, change: SpKeyChange): boolean {
    const cfg = samlConfig(row);
    switch (change.action) {
      case 'keep':
        return false;
      case 'remove':
        row.config = { ...cfg, spCertificate: '' };
        row.spPrivateKeyEnc = '';
        return true;
      case 'generate': {
        const pair = generateSpCertificate(`DepGate ${row.name}`);
        row.config = { ...cfg, spCertificate: pair.certificate };
        row.spPrivateKeyEnc = encryptSecret(pair.privateKey);
        return true;
      }
      case 'upload':
        row.config = { ...cfg, spCertificate: change.certificate };
        row.spPrivateKeyEnc = encryptSecret(change.privateKey);
        return true;
    }
  }

  /**
   * Saves the form. A provider that cannot be enabled is kept turned off with the reason, so the
   * admin does not lose what they typed (R4).
   */
  async function saveProvider(
    request: FastifyRequest,
    existing: SsoProvider | null,
    body: ProviderInput & { id?: string }
  ): Promise<{ status: number; body: unknown }> {
    const requestedType = body.type ?? existing?.type ?? 'oidc';
    if (existing && requestedType !== existing.type) {
      return { status: 400, body: { error: 'The protocol of a saved provider cannot change. Add a new provider instead.' } };
    }
    const savedSaml = existing?.type === 'saml' ? samlConfig(existing) : null;
    const normalized = normalizeProviderInput(
      { ...body, type: requestedType },
      {
        hasSavedSecret: Boolean(existing?.clientSecretEnc && decryptSecret(existing.clientSecretEnc)),
        allowInsecureHttp: config.auth.ssoAllowInsecureHttp,
        savedSpCertificate: savedSaml?.spCertificate ?? '',
        hasSpKey: existing ? spKeyReadable(existing) : false,
      }
    );
    if (!normalized.ok) return { status: 400, body: { error: normalized.error } };
    const input = normalized.value;

    const repo = providers();
    if (!existing && body.id && (await repo.exists({ where: { id: body.id } }))) {
      return { status: 409, body: { error: 'An identity provider with this id already exists. Close the dialog and add the provider again.' } };
    }
    const row =
      existing ??
      repo.create({ ...(body.id ? { id: body.id } : {}), type: input.type, clientSecretEnc: '', spPrivateKeyEnc: '', lastError: null, lastSuccessAt: null });
    const before = existing ? { ...existing, config: { ...existing.config } } : null;
    row.type = input.type;
    row.name = input.name;
    row.buttonLabel = input.buttonLabel;
    row.config = input.config;
    let secretChanged: boolean;
    let reachability: string | null;

    if (input.type === 'oidc') {
      if (input.clientSecret !== undefined) row.clientSecretEnc = encryptSecret(input.clientSecret);
      secretChanged = input.clientSecret !== undefined;
      const reached = await reach(row);
      reachability = reached.problem;
      const cfg = oidcConfig(row);
      // `https://idp.example.com` saved as the provider publishes it, `https://idp.example.com/` (or the reverse).
      if (reached.issuer && cfg.useDiscovery && reached.issuer !== cfg.issuer) row.config = { ...cfg, issuer: reached.issuer };
    } else {
      secretChanged = applySpKey(row, input.spKey);
      const cfg = samlConfig(row);
      let metadataProblem: string | null = null;
      if (cfg.metadataUrl) {
        try {
          const found = await fetchIdpMetadata(cfg.metadataUrl);
          row.config = { ...cfg, idpEntityId: found.entityId, ssoUrl: found.ssoUrl, idpCertificates: found.certificates.slice(0, 2) };
        } catch (err) {
          metadataProblem = `Metadata could not be read, so the values below were kept: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      reachability = metadataProblem ?? (await reach(row)).problem;
    }

    let validationError: string | null = reachability;
    if (input.enabled && !validationError) validationError = await enableProblem(row, { reachable: true });
    row.enabled = input.enabled && !validationError;
    row.lastError = reachability;

    const saved = await repo.save(row);
    forgetOidcProvider(saved.id);

    const changed = before ? changedFields(before, saved, secretChanged) : ['created'];
    const created =
      saved.type === 'saml' ? `SAML provider, IdP ${samlConfig(saved).idpEntityId || '(not set)'}` : `OIDC provider, issuer ${oidcConfig(saved).issuer}`;
    audit(
      request,
      existing ? 'SSO_PROVIDER_UPDATED' : 'SSO_PROVIDER_CREATED',
      saved.name,
      [
        existing ? `Changed: ${changed.join(', ') || 'nothing'}` : created,
        saved.enabled ? 'Enabled' : 'Turned off',
        ...(validationError ? [`Not enabled: ${validationError}`] : []),
      ],
      { providerId: saved.id, type: saved.type }
    );
    const publicUrl = await resolvePublicUrl(fastify.db);
    return {
      status: existing ? 200 : 201,
      body: { provider: providerView(saved, publicUrl), validationError: input.enabled ? validationError : null },
    };
  }

  function changedFields(before: SsoProvider, after: SsoProvider, secretChanged: boolean): string[] {
    const fields: string[] = [];
    if (before.name !== after.name) fields.push('name');
    if (before.buttonLabel !== after.buttonLabel) fields.push('button label');
    if (before.enabled !== after.enabled) fields.push('enabled');
    const beforeConfig = before.config as unknown as Record<string, unknown>;
    const afterConfig = after.config as unknown as Record<string, unknown>;
    for (const key of Object.keys(afterConfig)) {
      if (key === 'spCertificate') continue;
      if (JSON.stringify(beforeConfig[key]) !== JSON.stringify(afterConfig[key])) fields.push(key);
    }
    if (secretChanged) fields.push(after.type === 'saml' ? 'SP certificate' : 'client secret');
    return fields;
  }

  fastify.get(
    '/api/admin/sso-providers',
    {
      onRequest: [requireSecurity],
      schema: { tags: ['Single sign-on'], response: { 200: { type: 'array', items: providerViewSchema } } },
    },
    async (_request, reply) => {
      const rows = await providers().find({ order: { name: 'ASC' } });
      const publicUrl = await resolvePublicUrl(fastify.db);
      return reply.send(rows.map((row) => providerView(row, publicUrl)));
    }
  );

  fastify.get<{ Querystring: { id?: string } }>(
    '/api/admin/sso-providers/setup',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description:
          'The URLs to register at the identity provider. Without id, a fresh id for a provider not yet saved: pass it to POST so the URLs stay valid.',
        querystring: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              urls: urlsSchema,
              publicUrl: { type: 'string' },
              publicUrlSource: { type: 'string', enum: ['setting', 'learned', 'default'] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = request.query.id ?? randomUUID();
      const info = await publicUrlInfo(fastify.db);
      return reply.send({ id, urls: providerUrls(id, info.url), publicUrl: info.url, publicUrlSource: info.source });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/admin/sso-providers/:id',
    {
      onRequest: [requireSecurity],
      schema: { tags: ['Single sign-on'], params: idParams, response: { 200: providerViewSchema, 404: errorBody } },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row) return reply.status(404).send({ error: 'Identity provider not found' });
      return reply.send(providerView(row, await resolvePublicUrl(fastify.db)));
    }
  );

  fastify.post<{ Body: ProviderInput }>(
    '/api/admin/sso-providers',
    {
      onRequest: [requireSecurity],
      schema: { tags: ['Single sign-on'], body: providerBody, response: { 201: saveResponse, 400: errorBody, 409: errorBody } },
    },
    async (request, reply) => {
      const result = await saveProvider(request, null, request.body);
      return reply.status(result.status).send(result.body);
    }
  );

  fastify.put<{ Params: { id: string }; Body: ProviderInput }>(
    '/api/admin/sso-providers/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        params: idParams,
        body: providerBody,
        response: { 200: saveResponse, 400: errorBody, 404: errorBody },
      },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row) return reply.status(404).send({ error: 'Identity provider not found' });
      const result = await saveProvider(request, row, request.body);
      return reply.status(result.status).send(result.body);
    }
  );

  fastify.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/admin/sso-providers/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description: 'Turns a provider on or off. Turning on checks the provider and the sign-in settings first.',
        params: idParams,
        body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
        response: { 200: providerViewSchema, 400: errorBody, 404: errorBody },
      },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row) return reply.status(404).send({ error: 'Identity provider not found' });
      const enabled = request.body.enabled === true;
      if (enabled && !row.enabled) {
        const problem = await enableProblem(row);
        if (problem) {
          await fastify.db.query(`UPDATE sso_providers SET last_error = $2 WHERE id = $1`, [row.id, problem.slice(0, 2000)]);
          return reply.status(400).send({ error: problem });
        }
        row.lastError = null;
      }
      if (row.enabled !== enabled) {
        row.enabled = enabled;
        await providers().save(row);
        forgetOidcProvider(row.id);
        audit(request, 'SSO_PROVIDER_UPDATED', row.name, [enabled ? 'Enabled' : 'Turned off'], { providerId: row.id, type: row.type });
      }
      return reply.send(providerView(row, await resolvePublicUrl(fastify.db)));
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/sso-providers/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description: 'Deletes the provider and its account links. The users stay; they can still be invited to set a password.',
        params: idParams,
        response: { 204: { type: 'null' }, 404: errorBody },
      },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row) return reply.status(404).send({ error: 'Identity provider not found' });
      const links = await fastify.db.getRepository(UserIdentity).delete({ providerId: row.id });
      await providers().remove(row);
      forgetOidcProvider(request.params.id);
      audit(request, 'SSO_PROVIDER_DELETED', row.name, [`${links.affected ?? 0} account links removed`], {
        providerId: request.params.id,
        type: row.type,
      });
      return reply.status(204).send();
    }
  );

  fastify.post<{ Body: { issuer?: string } }>(
    '/api/admin/sso-providers/discover',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description:
          "Reads the issuer's OIDC discovery document for the form. Server-side fetch: HTTPS only (localhost excepted), 5 s timeout, 1 MB limit, redirects not followed.",
        body: { type: 'object', required: ['issuer'], properties: { issuer: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              issuer: { type: 'string' },
              authorizationEndpoint: { type: 'string' },
              tokenEndpoint: { type: 'string' },
              jwksUri: { type: 'string' },
              userinfoEndpoint: { type: 'string' },
              signingAlgs: { type: 'array', items: { type: 'string' } },
              tokenEndpointAuthMethods: { type: 'array', items: { type: 'string' } },
              scopesSupported: { type: 'array', items: { type: 'string' } },
              claimsSupported: { type: 'array', items: { type: 'string' } },
            },
          },
          400: errorBody,
        },
      },
    },
    async (request, reply) => {
      const issuer = (request.body.issuer ?? '').trim();
      if (!issuer) return reply.status(400).send({ error: 'Enter the issuer URL' });
      try {
        const found = await discoverOidc(issuer);
        await checkOidcProvider({
          issuer,
          clientId: 'discover',
          scopes: 'openid',
          emailClaim: 'email',
          requireVerifiedEmail: true,
          requiredClaims: [],
          useDiscovery: false,
          authorizationEndpoint: found.authorizationEndpoint,
          tokenEndpoint: found.tokenEndpoint,
          jwksUri: found.jwksUri,
          userinfoEndpoint: found.userinfoEndpoint,
          clientAuthMethod: 'client_secret_basic',
          clockSkewSeconds: 60,
          extraAuthParams: [],
        });
        return reply.send(found);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof OidcError || err instanceof Error ? err.message : String(err) });
      }
    }
  );

  fastify.post<{ Body: { url?: string; xml?: string } }>(
    '/api/admin/sso-providers/saml-metadata',
    {
      onRequest: [requireSecurity],
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        tags: ['Single sign-on'],
        description:
          'Reads SAML IdP metadata for the form (R3): from a URL (server-side fetch: HTTPS only, localhost excepted, 5 s, 1 MB, redirects not followed) or pasted XML.',
        body: { type: 'object', properties: { url: { type: 'string' }, xml: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              entityId: { type: 'string' },
              ssoUrl: { type: 'string' },
              certificates: describedCertificates,
              nameIdFormats: { type: 'array', items: { type: 'string' } },
              wantAuthnRequestsSigned: { type: 'boolean' },
            },
          },
          400: errorBody,
        },
      },
    },
    async (request, reply) => {
      const url = (request.body.url ?? '').trim();
      const xml = (request.body.xml ?? '').trim();
      if (!url && !xml) return reply.status(400).send({ error: 'Enter the metadata URL or paste the metadata XML' });
      let found: IdpMetadata;
      try {
        found = url ? await fetchIdpMetadata(url) : parseIdpMetadata(xml);
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
      const ssoProblem = idpUrlProblem(found.ssoUrl, config.auth.ssoAllowInsecureHttp);
      if (ssoProblem) return reply.status(400).send({ error: `The metadata's SSO URL ${ssoProblem}` });
      return reply.send({ ...found, certificates: describeAll(found.certificates) });
    }
  );

  fastify.post<{ Body: { certificates?: string[] } }>(
    '/api/admin/sso-providers/certificate-info',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description: 'Describes pasted PEM certificates (subject, issuer, SHA-256 fingerprint, validity), for the SAML form.',
        body: { type: 'object', required: ['certificates'], properties: { certificates: { type: 'array', items: { type: 'string' } } } },
        response: { 200: { type: 'object', properties: { certificates: describedCertificates } }, 400: errorBody },
      },
    },
    async (request, reply) => {
      const pems: string[] = [];
      try {
        for (const text of request.body.certificates ?? []) for (const pem of splitCertificates(text)) if (!pems.includes(pem)) pems.push(pem);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      return reply.send({ certificates: describeAll(pems) });
    }
  );

  fastify.post<{ Params: { id: string }; Body: { action: 'generate' | 'upload'; certificate?: string; privateKey?: string } }>(
    '/api/admin/sso-providers/:id/sp-certificate',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description:
          'Generates (self-signed RSA 2048 / SHA-256, 5 years) or uploads the SAML SP certificate and private key (R3). The key is stored encrypted and never returned.',
        params: idParams,
        body: {
          type: 'object',
          required: ['action'],
          properties: { action: { type: 'string', enum: ['generate', 'upload'] }, certificate: { type: 'string' }, privateKey: { type: 'string' } },
        },
        response: { 200: providerViewSchema, 400: errorBody, 404: errorBody },
      },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row || row.type !== 'saml') return reply.status(404).send({ error: 'SAML provider not found' });
      let change: SpKeyChange;
      if (request.body.action === 'generate') {
        change = { action: 'generate' };
      } else {
        try {
          const [certificate, ...rest] = splitCertificates(request.body.certificate ?? '');
          if (!certificate || rest.length) return reply.status(400).send({ error: 'Upload exactly one SP certificate' });
          change = { action: 'upload', certificate, privateKey: checkKeyPair(certificate, request.body.privateKey ?? '') };
        } catch (err) {
          return reply.status(400).send({ error: `SP certificate: ${(err as Error).message}` });
        }
      }
      applySpKey(row, change);
      await providers().save(row);
      audit(request, 'SSO_PROVIDER_UPDATED', row.name, [`SP certificate ${change.action === 'generate' ? 'generated' : 'uploaded'}`], {
        providerId: row.id,
        type: row.type,
      });
      return reply.send(providerView(row, await resolvePublicUrl(fastify.db)));
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/sso-providers/:id/test',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        description:
          'Starts a test sign-in (R5). Open startUrl in a new window; poll GET /api/admin/sso-providers/test/{ticket} for the result. Creates no session, account or link.',
        params: idParams,
        response: {
          200: { type: 'object', properties: { ticket: { type: 'string' }, startUrl: { type: 'string' } } },
          400: errorBody,
          404: errorBody,
        },
      },
    },
    async (request, reply) => {
      const row = await findProvider(fastify.db, request.params.id);
      if (!row) return reply.status(404).send({ error: 'Identity provider not found' });
      if (row.type === 'oidc' && (!row.clientSecretEnc || !decryptSecret(row.clientSecretEnc))) {
        return reply.status(400).send({ error: 'Enter and save the client secret first' });
      }
      if (row.type === 'saml') {
        const problem = samlConfigProblem(samlConfig(row), spKeyReadable(row));
        if (problem) return reply.status(400).send({ error: problem });
      }
      const { requester } = getRequestContext(request);
      const ticket = await saveTestTicket(fastify.redis, { providerId: row.id, requestedBy: requester ?? '' });
      return reply.send({ ticket, startUrl: `/api/auth/sso/${row.id}/start?test=${ticket}` });
    }
  );

  fastify.get<{ Params: { ticket: string } }>(
    '/api/admin/sso-providers/test/:ticket',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        params: { type: 'object', required: ['ticket'], properties: { ticket: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const result = await readTestResult(fastify.redis, request.params.ticket);
      return reply.send(result ?? { status: 'pending' });
    }
  );

  fastify.get(
    '/api/admin/signin-settings',
    {
      onRequest: [requireSecurity],
      schema: { tags: ['Single sign-on'], response: { 200: signinSettingsSchema } },
    },
    async (_request, reply) => {
      const settings = await loadSigninSettings(fastify.db);
      const ssoEnabled = (await providers().count({ where: { enabled: true } })) > 0;
      return reply.send({ ...settings, ssoEnabled });
    }
  );

  fastify.put<{ Body: { allowedDomains?: unknown; allowUnlistedSso?: boolean } }>(
    '/api/admin/signin-settings',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Single sign-on'],
        body: {
          type: 'object',
          required: ['allowedDomains', 'allowUnlistedSso'],
          properties: {
            allowedDomains: { type: 'array', items: { type: 'string' } },
            allowUnlistedSso: { type: 'boolean' },
          },
        },
        response: { 200: signinSettingsSchema, 400: errorBody },
      },
    },
    async (request, reply) => {
      const domains = normalizeDomainList(request.body.allowedDomains);
      if (!domains.ok) return reply.status(400).send({ error: domains.error });
      const ssoEnabled = (await providers().count({ where: { enabled: true } })) > 0;
      if (domains.domains.length === 0 && ssoEnabled) {
        return reply.status(400).send({
          error: 'Turn off every single sign-on provider before removing the last allowed domain. An empty list would let any account the provider vouches for sign in.',
        });
      }
      const before = await loadSigninSettings(fastify.db);
      const after = await saveSigninSettings(fastify.db, {
        allowedDomains: domains.domains,
        allowUnlistedSso: request.body.allowUnlistedSso === true,
      });
      const reasons: string[] = [];
      if (before.allowedDomains.join(',') !== after.allowedDomains.join(',')) {
        reasons.push(`Allowed domains: ${before.allowedDomains.join(', ') || 'none'} → ${after.allowedDomains.join(', ') || 'none'}`);
      }
      if (before.allowUnlistedSso !== after.allowUnlistedSso) {
        reasons.push(`Unlisted people may sign in: ${before.allowUnlistedSso ? 'on' : 'off'} → ${after.allowUnlistedSso ? 'on' : 'off'}`);
      }
      if (reasons.length) audit(request, 'SIGNIN_SETTINGS_UPDATED', 'Sign-in settings', reasons);
      return reply.send({ ...after, ssoEnabled });
    }
  );
};

export default fp(ssoAdminRoutes);
