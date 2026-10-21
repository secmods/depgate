/**
 * Single sign-on endpoints the browser and the identity provider call (requirements_sso.md §10).
 * OIDC and SAML 2.0 (SP-initiated). Every failure goes back to the login page as a short code;
 * details go to the Decision Ledger and the server log only (R19).
 */
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalRole, isHumanRole } from '../auth/roles.js';
import { config } from '../config.js';
import { SsoProvider, oidcConfig, samlConfig } from '../db/entities/SsoProvider.js';
import type { LoginMethod, User } from '../db/entities/User.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { auditLoginFailure, auditLoginSuccess } from '../services/login-audit.js';
import { resolvePublicUrl } from '../services/public-url.js';
import { allowHit } from '../services/rate-limit.js';
import { issueSessionTokens, recordLogin } from '../services/session-tokens.js';
import { loadSigninSettings } from '../services/signin-settings.js';
import { beginOidcLogin, completeOidcLogin, OidcError, type OidcIdentity } from '../services/sso-oidc.js';
import { findProvider, noteProviderOutcome, providerHandle, providerUrls, samlHandle } from '../services/sso-providers.js';
import {
  claimIsTrue,
  domainAllowed,
  evaluateClaims,
  requiredClaimMismatch,
  safeReturnTo,
  samlClaims,
  SAML_NAMEID_KEY,
  claimEmail,
  type ClaimRules,
  type LoginFailureReason,
} from '../services/sso-rules.js';
import { beginSamlLogin, completeSamlLogin, MAX_XML_BYTES, SamlError, spMetadataXml, type SamlIdentity } from '../services/sso-saml.js';
import { applySsoSignIn, planSsoSignIn, type SsoPlan } from '../services/sso-signin.js';
import {
  rememberSamlAssertion,
  saveHandoff,
  saveLoginState,
  saveSamlLoginState,
  saveTestResult,
  takeHandoff,
  takeLoginState,
  takeSamlLoginState,
  takeTestTicket,
} from '../services/sso-store.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } as const;

export interface TestCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface TestResult {
  status: 'done';
  ok: boolean;
  /** What a real sign-in with this account would do. */
  outcome: string;
  reason: LoginFailureReason | null;
  error: string | null;
  subject: string | null;
  email: string | null;
  /** OIDC claims, or SAML attributes with the NameID. */
  claims: Record<string, unknown> | null;
  checks: TestCheck[];
}

/** What a validated response says about the person, the same shape for both protocols. */
interface ReceivedIdentity {
  subject: string;
  claims: Record<string, unknown>;
  rules: ClaimRules;
  noun: 'claim' | 'attribute';
}

function fromOidc(provider: SsoProvider, identity: OidcIdentity): ReceivedIdentity {
  const cfg = oidcConfig(provider);
  return {
    subject: identity.subject,
    claims: identity.claims,
    rules: { emailClaim: cfg.emailClaim, requireVerifiedEmail: cfg.requireVerifiedEmail, requiredClaims: cfg.requiredClaims },
    noun: 'claim',
  };
}

function fromSaml(provider: SsoProvider, identity: SamlIdentity): ReceivedIdentity {
  const { claims, rules } = samlClaims(identity, samlConfig(provider));
  return { subject: identity.subject, claims, rules, noun: 'attribute' };
}

function outcomeOf(plan: SsoPlan | null, failure: { reason: LoginFailureReason; detail: string } | null): string {
  if (failure) return `Would be refused (${failure.reason}): ${failure.detail}`;
  if (!plan) return 'Would be refused';
  switch (plan.kind) {
    case 'linked':
      return `Would sign in as ${plan.user.email} with role ${canonicalRole(plan.user.role)}`;
    case 'link':
      return `Would link this account to ${plan.user.email} and sign in with role ${canonicalRole(plan.user.role)}`;
    case 'create':
      return 'Would add this person to Users & Access with role User and sign them in';
    case 'deny':
      return `Would be refused (${plan.reason}): ${plan.detail}`;
  }
}

const RESPONSE_CHECKS: Record<LoginMethod, string> = {
  password: '',
  oidc: 'ID token signature, issuer, audience, expiry and nonce are valid',
  saml: 'Signature, issuer, audience, recipient, InResponseTo and validity period are valid',
};

const ssoRoutes: FastifyPluginAsync = async (fastify) => {
  // The SAML ACS is an HTML form post from the identity provider. Scoped to this plugin.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 2 * MAX_XML_BYTES },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  /** Per IP, per endpoint, per 10 minutes (§8.5). SSO_RATE_LIMIT=0 turns it off. */
  async function limited(request: FastifyRequest, endpoint: string): Promise<boolean> {
    const limit = config.auth.ssoRateLimit;
    if (limit <= 0) return false;
    return !(await allowHit(fastify.redis, `sso:${endpoint}:${request.ip}`, limit, 600));
  }

  /** 303 after the SAML form post, so the browser follows with a GET. */
  function toLogin(reply: FastifyReply, base: string, reason: LoginFailureReason, code = 302) {
    return reply.redirect(`${base}/login?sso_error=${reason}`, code);
  }

  function toTestDone(reply: FastifyReply, base: string, code = 302) {
    return reply.redirect(`${base}/sso-test-done`, code);
  }

  function providerRef(provider: SsoProvider) {
    return { id: provider.id, name: provider.name };
  }

  function methodOf(provider: SsoProvider | null): LoginMethod {
    return provider?.type === 'saml' ? 'saml' : 'oidc';
  }

  fastify.get(
    '/api/auth/providers',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description: 'Enabled identity providers, for the login page buttons.',
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, type: { type: 'string' }, buttonLabel: { type: 'string' } },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const rows = await fastify.db.getRepository(SsoProvider).find({ where: { enabled: true }, order: { name: 'ASC' } });
      return reply.send(rows.map((row) => ({ id: row.id, type: row.type, buttonLabel: row.buttonLabel })));
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { returnTo?: string; test?: string } }>(
    '/api/auth/sso/:id/start',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description:
          'Starts single sign-on (OIDC or SAML): redirects to the identity provider. For OIDC, also the Initiate login URI for a provider dashboard tile.',
        params: idParams,
        querystring: { type: 'object', properties: { returnTo: { type: 'string' }, test: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const base = await resolvePublicUrl(fastify.db);
      const testCode = request.query.test;
      if (await limited(request, 'start')) {
        if (!testCode) {
          const method = methodOf(await findProvider(fastify.db, request.params.id));
          await auditLoginFailure(fastify, request, { method, reason: 'rate_limited' });
        }
        return testCode ? toTestDone(reply, base) : toLogin(reply, base, 'rate_limited');
      }

      const provider = await findProvider(fastify.db, request.params.id);
      const ticket = testCode ? await takeTestTicket(fastify.redis, testCode) : null;
      if (testCode && (!ticket || ticket.providerId !== provider?.id)) return toTestDone(reply, base);
      if (!provider || (!ticket && !provider.enabled)) {
        return toLogin(reply, base, 'provider_unavailable');
      }

      const returnTo = safeReturnTo(request.query.returnTo);
      const testTicket = ticket ? testCode! : null;
      const urls = providerUrls(provider.id, base);
      try {
        if (provider.type === 'saml') {
          const { url, pending } = await beginSamlLogin(samlHandle(provider), urls);
          await saveSamlLoginState(fastify.redis, { ...pending, providerId: provider.id, returnTo, testTicket });
          return reply.redirect(url);
        }
        const handle = providerHandle(provider);
        if (!handle.clientSecret) throw new OidcError('The client secret cannot be read; enter it again in Settings', 'provider_unavailable');
        const { url, pending } = await beginOidcLogin(handle, urls.redirectUri);
        await saveLoginState(fastify.redis, { ...pending, providerId: provider.id, returnTo, testTicket });
        return reply.redirect(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        request.log.warn({ provider: provider.name, err: message }, 'Single sign-on could not start');
        await noteProviderOutcome(fastify.db, provider.id, message);
        if (ticket) {
          await saveTestResult(fastify.redis, testCode!, failedTest('provider_unavailable', message));
          return toTestDone(reply, base);
        }
        await auditLoginFailure(fastify, request, {
          method: methodOf(provider),
          provider: providerRef(provider),
          reason: 'provider_unavailable',
          detail: message,
        });
        return toLogin(reply, base, 'provider_unavailable');
      }
    }
  );

  function failedTest(reason: LoginFailureReason, error: string): TestResult {
    return {
      status: 'done',
      ok: false,
      outcome: `Would be refused (${reason})`,
      reason,
      error,
      subject: null,
      email: null,
      claims: null,
      checks: [{ label: 'Identity provider response', ok: false, detail: error }],
    };
  }

  async function testOutcome(provider: SsoProvider, received: ReceivedIdentity): Promise<TestResult> {
    const settings = await loadSigninSettings(fastify.db);
    const { rules, claims, noun } = received;
    const email = claimEmail(claims, rules.emailClaim)?.toLowerCase() ?? null;
    const mismatch = requiredClaimMismatch(claims, rules.requiredClaims);
    const emailSource = rules.emailClaim === SAML_NAMEID_KEY ? 'NameID' : `${rules.emailClaim} ${noun}`;
    const checks: TestCheck[] = [
      { label: 'Identity provider response', ok: true, detail: RESPONSE_CHECKS[methodOf(provider)] },
      { label: `Email (${emailSource})`, ok: Boolean(email), detail: email ?? 'Missing' },
    ];
    if (provider.type === 'oidc') {
      checks.push({
        label: 'Verified email',
        ok: !rules.requireVerifiedEmail || claimIsTrue(claims.email_verified),
        detail: rules.requireVerifiedEmail
          ? `email_verified is ${claims.email_verified === undefined ? 'missing' : String(claims.email_verified)}`
          : 'Not required for this provider',
      });
    }
    checks.push(
      {
        label: noun === 'claim' ? 'Required claims' : 'Required attributes',
        ok: mismatch === null,
        detail: rules.requiredClaims.length === 0
          ? 'None configured'
          : mismatch
            ? `${mismatch.claim} must be "${mismatch.expected}" but is ${mismatch.actual === null ? 'missing' : `"${mismatch.actual}"`}`
            : 'All present',
      },
      {
        label: 'Allowed sign-in domain',
        ok: Boolean(email) && domainAllowed(email ?? '', settings.allowedDomains),
        detail: settings.allowedDomains.length ? `Allowed: ${settings.allowedDomains.join(', ')}` : 'No allowed domains are set',
      }
    );
    const check = evaluateClaims(claims, rules, settings.allowedDomains, noun);
    const plan = check.ok
      ? await planSsoSignIn(fastify.db, { providerId: provider.id, subject: received.subject, email: check.email }, settings.allowUnlistedSso)
      : null;
    const failure = check.ok ? null : { reason: check.reason, detail: check.detail };
    if (plan) {
      checks.push({ label: 'DepGate account', ok: plan.kind !== 'deny', detail: outcomeOf(plan, null) });
    }
    const reason = failure?.reason ?? (plan?.kind === 'deny' ? plan.reason : null);
    return {
      status: 'done',
      ok: reason === null,
      outcome: outcomeOf(plan, failure),
      reason,
      error: null,
      subject: received.subject,
      email,
      claims,
      checks,
    };
  }

  /** A response the protocol code refused: noted on the provider, audited, back to the login page. */
  async function refuseResponse(
    request: FastifyRequest,
    reply: FastifyReply,
    base: string,
    provider: SsoProvider,
    pending: { testTicket: string | null },
    err: unknown,
    code: number
  ) {
    const reason: LoginFailureReason = err instanceof OidcError || err instanceof SamlError ? err.reason : 'invalid_response';
    const message = err instanceof Error ? err.message : String(err);
    request.log.warn({ provider: provider.name, reason, err: message }, 'Single sign-on response refused');
    if (reason !== 'provider_error') await noteProviderOutcome(fastify.db, provider.id, message);
    if (pending.testTicket) {
      await saveTestResult(fastify.redis, pending.testTicket, failedTest(reason, message));
      return toTestDone(reply, base, code);
    }
    await auditLoginFailure(fastify, request, { method: methodOf(provider), provider: providerRef(provider), reason, detail: message });
    return toLogin(reply, base, reason, code);
  }

  /** From a validated response to a DepGate session (R8, R11, S2). The same for OIDC and SAML. */
  async function finishSignIn(
    request: FastifyRequest,
    reply: FastifyReply,
    base: string,
    provider: SsoProvider,
    received: ReceivedIdentity,
    pending: { returnTo: string | null; testTicket: string | null },
    code: number
  ) {
    const method = methodOf(provider);
    if (pending.testTicket) {
      await saveTestResult(fastify.redis, pending.testTicket, await testOutcome(provider, received));
      await noteProviderOutcome(fastify.db, provider.id, null);
      return toTestDone(reply, base, code);
    }

    // A provider turned off between start and callback no longer signs anyone in.
    if (!provider.enabled) {
      await auditLoginFailure(fastify, request, { method, provider: providerRef(provider), reason: 'provider_unavailable', detail: 'The provider was turned off' });
      return toLogin(reply, base, 'provider_unavailable', code);
    }

    const settings = await loadSigninSettings(fastify.db);
    const check = evaluateClaims(received.claims, received.rules, settings.allowedDomains, received.noun);
    if (!check.ok) {
      await auditLoginFailure(fastify, request, { email: check.email, method, provider: providerRef(provider), reason: check.reason, detail: check.detail });
      return toLogin(reply, base, check.reason, code);
    }

    const account = { providerId: provider.id, subject: received.subject, email: check.email };
    const result = await applySsoSignIn(fastify.db, account, settings.allowUnlistedSso);
    if ('denied' in result) {
      await auditLoginFailure(fastify, request, {
        email: check.email,
        method,
        provider: providerRef(provider),
        reason: result.denied.reason,
        detail: result.denied.detail,
      });
      return toLogin(reply, base, result.denied.reason, code);
    }

    const user: User = result.user;
    const role = canonicalRole(user.role);
    if (!isHumanRole(role)) return toLogin(reply, base, 'not_invited', code);

    const { reqIp, userAgent } = getRequestContext(request);
    if (result.created) {
      void logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester: user.email,
        ecosystem: 'user',
        packageName: user.email,
        resolvedVersion: role,
        repository: null,
        decision: 'USER_PROVISIONED',
        conditionReasons: [`Added on first sign-in with ${provider.name}; not listed in Users & Access`],
        metadata: { provider: provider.name, providerId: provider.id, method },
      });
    } else if (result.linked) {
      void logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester: user.email,
        ecosystem: 'user',
        packageName: user.email,
        resolvedVersion: role,
        repository: null,
        decision: 'IDENTITY_LINKED',
        conditionReasons: [`First sign-in with ${provider.name}`],
        metadata: { provider: provider.name, providerId: provider.id, subject: received.subject, method },
      });
    }

    const session = await issueSessionTokens(fastify, user, { method, providerId: provider.id });
    await recordLogin(fastify, user.id, method, provider.id);
    await noteProviderOutcome(fastify.db, provider.id, null);
    auditLoginSuccess(fastify, request, {
      email: user.email,
      userId: user.id,
      method,
      provider: providerRef(provider),
      role,
      roleSource: result.created ? 'provisioned' : 'configured',
    });
    const handoff = await saveHandoff(fastify.redis, { ...session, returnTo: pending.returnTo });
    return reply.redirect(`${base}/login/sso?code=${handoff}`, code);
  }

  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/auth/sso/:id/callback',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description: 'OIDC redirect URI. Register this at the identity provider.',
        params: idParams,
      },
    },
    async (request, reply) => {
      const base = await resolvePublicUrl(fastify.db);
      if (await limited(request, 'callback')) {
        await auditLoginFailure(fastify, request, { method: 'oidc', reason: 'rate_limited' });
        return toLogin(reply, base, 'rate_limited');
      }

      const pending = await takeLoginState(fastify.redis, request.query.state);
      const provider = pending ? await findProvider(fastify.db, pending.providerId) : null;
      if (!pending || pending.providerId !== request.params.id || !provider || provider.type !== 'oidc') {
        await auditLoginFailure(fastify, request, {
          method: 'oidc',
          reason: 'state_invalid',
          detail: pending ? 'The callback is for another provider' : 'Unknown, expired or reused state',
        });
        return toLogin(reply, base, 'state_invalid');
      }

      const rawQuery = request.raw.url?.split('?')[1] ?? '';
      let identity: OidcIdentity;
      try {
        identity = await completeOidcLogin(providerHandle(provider), pending, rawQuery);
      } catch (err) {
        return refuseResponse(request, reply, base, provider, pending, err, 302);
      }
      return finishSignIn(request, reply, base, provider, fromOidc(provider, identity), pending, 302);
    }
  );

  fastify.post<{ Params: { id: string }; Body: { SAMLResponse?: string; RelayState?: string } }>(
    '/api/auth/saml/:id/acs',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description:
          'SAML Assertion Consumer Service (HTTP-POST binding). Register this at the identity provider. Only answers to requests DepGate sent: IdP-initiated (unsolicited) responses are refused.',
        params: idParams,
        consumes: ['application/x-www-form-urlencoded'],
        body: {
          type: 'object',
          properties: { SAMLResponse: { type: 'string' }, RelayState: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const base = await resolvePublicUrl(fastify.db);
      if (await limited(request, 'acs')) {
        await auditLoginFailure(fastify, request, { method: 'saml', reason: 'rate_limited' });
        return toLogin(reply, base, 'rate_limited', 303);
      }

      const pending = await takeSamlLoginState(fastify.redis, request.body?.RelayState);
      const provider = pending ? await findProvider(fastify.db, pending.providerId) : null;
      if (!pending || pending.providerId !== request.params.id || !provider || provider.type !== 'saml') {
        await auditLoginFailure(fastify, request, {
          method: 'saml',
          reason: 'state_invalid',
          detail: pending
            ? 'The response is for another provider'
            : 'Unknown, expired or reused RelayState (IdP-initiated sign-in is not accepted)',
        });
        return toLogin(reply, base, 'state_invalid', 303);
      }

      const urls = providerUrls(provider.id, base);
      let identity: SamlIdentity;
      try {
        identity = await completeSamlLogin(
          samlHandle(provider),
          { spEntityId: urls.spEntityId, acsUrl: pending.acsUrl },
          pending,
          request.body?.SAMLResponse,
          (assertionId, ttl) => rememberSamlAssertion(fastify.redis, provider.id, assertionId, ttl)
        );
      } catch (err) {
        return refuseResponse(request, reply, base, provider, pending, err, 303);
      }
      return finishSignIn(request, reply, base, provider, fromSaml(provider, identity), pending, 303);
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/auth/saml/:id/metadata',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description: 'SAML service provider metadata. Its URL is also the SP entity ID. Import it at the identity provider.',
        params: idParams,
      },
    },
    async (request, reply) => {
      const provider = await findProvider(fastify.db, request.params.id);
      if (!provider || provider.type !== 'saml') return reply.status(404).send({ error: 'SAML provider not found' });
      const urls = providerUrls(provider.id, await resolvePublicUrl(fastify.db));
      const xml = spMetadataXml({ config: samlConfig(provider), hasPrivateKey: Boolean(provider.spPrivateKeyEnc) }, urls);
      return reply
        .header('content-type', 'application/samlmetadata+xml; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(xml);
    }
  );

  fastify.post<{ Body: { code?: string } }>(
    '/api/auth/sso/exchange',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        description: 'Trades the one-time code from the single sign-on redirect for session tokens. Each code works once, for 60 seconds.',
        body: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              registryToken: { type: 'string' },
              user: { type: 'object', properties: { email: { type: 'string' }, role: { type: 'string' } } },
              returnTo: { type: 'string', nullable: true },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          429: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      if (await limited(request, 'exchange')) return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
      const handoff = await takeHandoff(fastify.redis, request.body?.code);
      if (!handoff) return reply.status(400).send({ error: 'This sign-in has expired. Sign in again.' });
      return reply.send(handoff);
    }
  );
};

export default ssoRoutes;
