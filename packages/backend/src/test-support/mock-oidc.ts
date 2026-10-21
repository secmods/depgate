/**
 * A small OpenID Connect provider for tests. Test-only; excluded from the build.
 * It signs ID tokens with its own RSA key and can be told to misbehave (wrong audience, expired token,
 * `alg: none`, another key...) so the checks a real provider never fails on demand can be tested.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAccount {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  /** Any other ID token claims, e.g. `hd`. */
  claims?: Record<string, unknown>;
  /** Claims only userinfo returns. */
  userinfo?: Record<string, unknown>;
}

export interface Tamper {
  aud?: string;
  iss?: string;
  /** Seconds from now; negative means already expired. */
  expiresIn?: number;
  alg?: 'none' | 'HS256' | 'other-key';
  nonce?: string;
  /** Answer the authorization request with this error instead of a code. */
  error?: string;
  /** Token endpoint returns no id_token. */
  omitIdToken?: boolean;
  /** Authorization response carries another state. */
  state?: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string | null;
  challenge: string | null;
  account: MockAccount;
  tamper: Tamper;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export class MockOidcProvider {
  readonly clientId = 'depgate-test-client';
  readonly clientSecret = 'depgate-test-secret';
  issuer = '';
  /** The account the next authorization request signs in as. */
  account: MockAccount = { sub: 'subject-1', email: 'someone@example.com', email_verified: true };
  /** Misbehaviour for the next authorization request only. */
  tamper: Tamper = {};
  /** Discovery document changes, e.g. another issuer. */
  discoveryOverrides: Record<string, unknown> = {};
  /** Empty JWKS, to test the save-time key check. */
  publishNoKeys = false;
  /** What the token endpoint saw, for client-authentication assertions. */
  lastTokenRequest: { authorization: string | null; body: URLSearchParams } | null = null;
  readonly requests: string[] = [];

  private server: Server | null = null;
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly kid = randomBytes(8).toString('hex');
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, MockAccount>();

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        // Plain text, so an error message is never interpreted as HTML.
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String(err));
      });
    });
    // Longer than any test: clients reuse idle sockets, and a socket closed under them reads as ECONNRESET.
    this.server.keepAliveTimeout = 120_000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Signs as the provider would. `alg` and key can be changed to simulate forgeries. */
  idToken(payload: Record<string, unknown>, alg: Tamper['alg'] | 'RS256' = 'RS256'): string {
    const header = alg === 'none' ? { alg: 'none', typ: 'JWT' } : { alg: alg === 'HS256' ? 'HS256' : 'RS256', typ: 'JWT', kid: this.kid };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    if (alg === 'none') return `${input}.`;
    if (alg === 'HS256') return `${input}.${createHmac('sha256', this.clientSecret).update(input).digest('base64url')}`;
    const key: KeyObject = alg === 'other-key' ? this.otherKey.privateKey : this.key.privateKey;
    return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`;
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.issuer);
    this.requests.push(`${req.method} ${url.pathname}`);

    if (url.pathname === '/.well-known/openid-configuration') {
      return this.send(res, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['openid', 'email', 'profile'],
        ...this.discoveryOverrides,
      });
    }

    if (url.pathname === '/jwks') {
      const jwk = this.key.publicKey.export({ format: 'jwk' });
      return this.send(res, 200, { keys: this.publishNoKeys ? [] : [{ ...jwk, kid: this.kid, use: 'sig', alg: 'RS256' }] });
    }

    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      const tamper = this.tamper;
      this.tamper = {};
      if (q.get('client_id') !== this.clientId || q.get('response_type') !== 'code' || !redirectUri) {
        return this.send(res, 400, { error: 'invalid_request' });
      }
      const back = new URL(redirectUri);
      back.searchParams.set('state', tamper.state ?? q.get('state') ?? '');
      back.searchParams.set('iss', this.issuer);
      if (tamper.error) {
        back.searchParams.set('error', tamper.error);
        back.searchParams.set('error_description', 'The user cancelled');
      } else {
        if (q.get('code_challenge') && q.get('code_challenge_method') !== 'S256') return this.send(res, 400, { error: 'invalid_request' });
        const code = randomBytes(16).toString('hex');
        this.codes.set(code, {
          clientId: q.get('client_id')!,
          redirectUri,
          nonce: q.get('nonce'),
          challenge: q.get('code_challenge'),
          account: this.account,
          tamper,
        });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href });
      return void res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req));
      const authorization = req.headers.authorization ?? null;
      this.lastTokenRequest = { authorization, body: form };
      let clientId = form.get('client_id');
      let secret = form.get('client_secret');
      if (authorization?.startsWith('Basic ')) {
        const [id, pass] = Buffer.from(authorization.slice(6), 'base64').toString('utf8').split(':');
        clientId = decodeURIComponent(id);
        secret = decodeURIComponent(pass ?? '');
      }
      if (clientId !== this.clientId || secret !== this.clientSecret) return this.send(res, 401, { error: 'invalid_client' });
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!pending || pending.redirectUri !== form.get('redirect_uri')) return this.send(res, 400, { error: 'invalid_grant' });
      if (pending.challenge) {
        const verifier = form.get('code_verifier') ?? '';
        const computed = createHash('sha256').update(verifier).digest('base64url');
        if (computed !== pending.challenge) return this.send(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
      }
      const now = Math.floor(Date.now() / 1000);
      const { account, tamper } = pending;
      const claims: Record<string, unknown> = {
        iss: tamper.iss ?? this.issuer,
        sub: account.sub,
        aud: tamper.aud ?? this.clientId,
        iat: now,
        exp: now + (tamper.expiresIn ?? 300),
        ...(pending.nonce || tamper.nonce ? { nonce: tamper.nonce ?? pending.nonce } : {}),
        ...(account.email !== undefined ? { email: account.email } : {}),
        ...(account.email_verified !== undefined ? { email_verified: account.email_verified } : {}),
        ...(account.claims ?? {}),
      };
      const accessToken = randomBytes(16).toString('hex');
      this.accessTokens.set(accessToken, account);
      return this.send(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        ...(tamper.omitIdToken ? {} : { id_token: this.idToken(claims, tamper.alg ?? 'RS256') }),
      }, { 'cache-control': 'no-store' });
    }

    if (url.pathname === '/userinfo') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const account = this.accessTokens.get(token);
      if (!account) return this.send(res, 401, { error: 'invalid_token' });
      return this.send(res, 200, { sub: account.sub, ...(account.userinfo ?? {}) });
    }

    this.send(res, 404, { error: 'not_found' });
  }

  /**
   * Plays the browser: follows DepGate's redirect to /authorize and returns the callback URL the
   * provider sends the browser back to.
   */
  async authorize(authorizationUrl: string): Promise<URL> {
    const res = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status !== 302 || !location) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
    return new URL(location);
  }
}
