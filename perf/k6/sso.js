/**
 * Sign-in load (requirements_sso.md §12.1 case 17): a burst of people signing in at once, the
 * "9 a.m." shape, while the API keeps answering signed-in requests.
 *
 *   sso       Full OIDC round trip through Keycloak per iteration: start → provider login page →
 *             credentials → DepGate callback → code exchange → one signed-in API call.
 *   saml      Full SAML 2.0 round trip through Keycloak: start (AuthnRequest, HTTP-Redirect) → login
 *             page → credentials → Keycloak's auto-post form → DepGate ACS (signature, audience,
 *             recipient, InResponseTo, replay checks) → code exchange → one signed-in API call.
 *   password  POST /api/auth/login with the admin account (bcrypt dominates).
 *   session   Signed-in API calls and the public provider list at a fixed rate: the session check
 *             (user exists, not disabled, session version) runs on each one.
 *
 * Needs Keycloak: docker compose --profile sso up -d keycloak. Run: ./perf/run.sh sso
 * Setup adds an OIDC and a SAML provider (registering the SAML client in Keycloak through its admin
 * API) and the acme.test domain; teardown removes them and the load user. SSO_PROTOCOLS=oidc skips SAML.
 */
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3050').replace(/\/$/, '');
const ADMIN_USER = __ENV.ADMIN_USER || 'admin@depgate.local';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'admin';
const ISSUER = __ENV.SSO_ISSUER || 'http://keycloak.localhost:8180/realms/depgate';
const CLIENT_ID = __ENV.SSO_CLIENT_ID || 'depgate';
const CLIENT_SECRET = __ENV.SSO_CLIENT_SECRET || 'depgate-dev-secret';
const SSO_USER = __ENV.SSO_USER || 'qa-e2e-sso-load';
const SSO_EMAIL = __ENV.SSO_EMAIL || 'qa-e2e-sso-load@acme.test';
const SSO_PASSWORD = __ENV.SSO_PASSWORD || 'Passw0rd!';
const DOMAIN = SSO_EMAIL.split('@')[1];
const VUS = parseInt(__ENV.VUS || '3', 10);
const DURATION = __ENV.DURATION || '30s';
const SESSION_RATE = parseInt(__ENV.SESSION_RATE || '50', 10);
const PROVIDER_NAME = 'k6-sso-load';
const SAML_PROVIDER_NAME = 'k6-saml-load';
const PROTOCOLS = (__ENV.SSO_PROTOCOLS || 'oidc,saml').split(',').map((p) => p.trim());
const KEYCLOAK = (__ENV.KEYCLOAK_URL || ISSUER.replace(/\/realms\/.*$/, '')).replace(/\/$/, '');
const SAML_METADATA_URL = __ENV.SAML_METADATA_URL || `${ISSUER}/protocol/saml/descriptor`;
const SAML_CLIENT_NAME = 'DepGate (SAML, k6)';

const ssoRoundTrip = new Trend('sso_roundtrip_ms', true);
const ssoStart = new Trend('sso_start_ms', true);
const ssoCallback = new Trend('sso_callback_ms', true);
const ssoExchange = new Trend('sso_exchange_ms', true);
const idpLogin = new Trend('idp_login_ms', true);
const passwordLogin = new Trend('password_login_ms', true);
const sessionApi = new Trend('session_api_ms', true);
const providersList = new Trend('providers_ms', true);
const samlRoundTrip = new Trend('saml_roundtrip_ms', true);
const samlStart = new Trend('saml_start_ms', true);
const samlAcs = new Trend('saml_acs_ms', true);
const samlExchange = new Trend('saml_exchange_ms', true);
const samlIdpLogin = new Trend('saml_idp_login_ms', true);
const samlFailed = new Rate('saml_failed');
const ssoFailed = new Rate('sso_failed');
const passwordFailed = new Rate('password_failed');
const sessionFailed = new Rate('session_failed');

export const options = {
  // k6 on the host cannot resolve keycloak.localhost by itself; in Docker run.sh adds a host entry instead.
  hosts: __ENV.KEYCLOAK_IP ? { 'keycloak.localhost': __ENV.KEYCLOAK_IP } : undefined,
  setupTimeout: '1m',
  teardownTimeout: '1m',
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  scenarios: {
    ...(PROTOCOLS.includes('oidc') ? { sso: { executor: 'constant-vus', exec: 'ssoLogin', vus: VUS, duration: DURATION } } : {}),
    ...(PROTOCOLS.includes('saml') ? { saml: { executor: 'constant-vus', exec: 'samlLogin', vus: VUS, duration: DURATION } } : {}),
    password: { executor: 'constant-vus', exec: 'passwordSignIn', vus: VUS, duration: DURATION },
    session: {
      executor: 'constant-arrival-rate',
      exec: 'signedInCalls',
      rate: SESSION_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    sso_failed: ['rate<0.01'],
    password_failed: ['rate<0.01'],
    session_failed: ['rate<0.01'],
    // DepGate's own share of a sign-in: code exchange, ID token checks, account lookup, tokens.
    sso_callback_ms: ['p(95)<500'],
    sso_start_ms: ['p(95)<200'],
    sso_exchange_ms: ['p(95)<100'],
    // DepGate's share of a SAML sign-in: XML signature check, assertion checks, account lookup, tokens.
    ...(PROTOCOLS.includes('saml')
      ? { saml_failed: ['rate<0.01'], saml_start_ms: ['p(95)<200'], saml_acs_ms: ['p(95)<500'], saml_exchange_ms: ['p(95)<100'] }
      : {}),
    session_api_ms: ['p(95)<100'],
    providers_ms: ['p(95)<100'],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 201, 204, 302));

function json(body) {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function admin(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

/** DELETE sends no body, so no Content-Type: Fastify refuses an empty JSON body. */
function adminDelete(url, token) {
  const res = http.del(url, null, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status !== 204) console.warn(`DELETE ${url}: HTTP ${res.status}`);
  return res;
}

/** DepGate redirects to its public address; from inside Docker that is reached through BASE_URL instead. */
function toBase(url, publicOrigin) {
  return publicOrigin && url.startsWith(publicOrigin) ? `${BASE}${url.slice(publicOrigin.length)}` : url;
}

export function setup() {
  const login = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: ADMIN_USER, password: ADMIN_PASSWORD }), json({}));
  if (login.status !== 200) throw new Error(`Admin login failed: HTTP ${login.status}`);
  const token = login.json('token');

  const original = http.get(`${BASE}/api/admin/signin-settings`, admin(token)).json();
  const domains = original.allowedDomains.includes(DOMAIN) ? original.allowedDomains : [...original.allowedDomains, DOMAIN];
  http.put(`${BASE}/api/admin/signin-settings`, JSON.stringify({ allowedDomains: domains, allowUnlistedSso: true }), admin(token));

  for (const p of http.get(`${BASE}/api/admin/sso-providers`, admin(token)).json()) {
    if (p.name === PROVIDER_NAME || p.name === SAML_PROVIDER_NAME) adminDelete(`${BASE}/api/admin/sso-providers/${p.id}`, token);
  }
  let providerId = null;
  let publicOrigin = null;
  if (PROTOCOLS.includes('oidc')) {
    const created = http.post(
      `${BASE}/api/admin/sso-providers`,
      JSON.stringify({
        name: PROVIDER_NAME,
        buttonLabel: 'k6 load',
        enabled: true,
        oidc: { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      }),
      admin(token)
    );
    if (created.status !== 201 || created.json('validationError')) {
      throw new Error(`Could not add the OIDC provider: HTTP ${created.status} ${created.body}`);
    }
    providerId = created.json('provider.id');
    publicOrigin = /^(https?:\/\/[^/]+)/.exec(created.json('provider.urls.redirectUri'))[1];
  }
  const saml = PROTOCOLS.includes('saml') ? setupSaml(token) : null;
  return { token, providerId, saml, original, publicOrigin: publicOrigin || (saml && saml.publicOrigin) };
}

function keycloakAdmin() {
  const res = http.post(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    grant_type: 'password',
    client_id: 'admin-cli',
    username: __ENV.KEYCLOAK_ADMIN || 'admin',
    password: __ENV.KEYCLOAK_ADMIN_PASSWORD || 'admin',
  });
  if (res.status !== 200) throw new Error(`Keycloak admin sign-in failed: HTTP ${res.status}`);
  return { headers: { Authorization: `Bearer ${res.json('access_token')}`, 'Content-Type': 'application/json' } };
}

function removeKeycloakSamlClients(kc) {
  for (const client of http.get(`${KEYCLOAK}/admin/realms/depgate/clients?max=500`, kc).json()) {
    if (client.protocol === 'saml' && client.name === SAML_CLIENT_NAME) http.del(`${KEYCLOAK}/admin/realms/depgate/clients/${client.id}`, null, kc);
  }
}

/** Adds a SAML provider from Keycloak's metadata, and registers its SP entity ID and ACS URL in Keycloak. */
function setupSaml(token) {
  const setup = http.get(`${BASE}/api/admin/sso-providers/setup`, admin(token)).json();
  const kc = keycloakAdmin();
  removeKeycloakSamlClients(kc);
  const client = http.post(
    `${KEYCLOAK}/admin/realms/depgate/clients`,
    JSON.stringify({
      clientId: setup.urls.spEntityId,
      name: SAML_CLIENT_NAME,
      protocol: 'saml',
      enabled: true,
      frontchannelLogout: false,
      redirectUris: [setup.urls.acsUrl],
      attributes: {
        'saml.assertion.signature': 'true',
        'saml.server.signature': 'true',
        'saml.client.signature': 'false',
        'saml.force.post.binding': 'true',
        'saml.signature.algorithm': 'RSA_SHA256',
        saml_force_name_id_format: 'true',
        saml_name_id_format: 'email',
        saml_assertion_consumer_url_post: setup.urls.acsUrl,
      },
    }),
    kc
  );
  if (client.status !== 201) throw new Error(`Could not register the SAML client in Keycloak: HTTP ${client.status} ${client.body}`);
  const created = http.post(
    `${BASE}/api/admin/sso-providers`,
    JSON.stringify({
      id: setup.id,
      type: 'saml',
      name: SAML_PROVIDER_NAME,
      buttonLabel: 'k6 SAML load',
      enabled: true,
      saml: { metadataUrl: SAML_METADATA_URL, signRequests: false },
    }),
    admin(token)
  );
  if (created.status !== 201 || created.json('validationError')) {
    throw new Error(`Could not add the SAML provider: HTTP ${created.status} ${created.body}`);
  }
  return { providerId: setup.id, publicOrigin: /^(https?:\/\/[^/]+)/.exec(setup.urls.acsUrl)[1] };
}

export function teardown(data) {
  if (data.providerId) adminDelete(`${BASE}/api/admin/sso-providers/${data.providerId}`, data.token);
  if (data.saml) {
    adminDelete(`${BASE}/api/admin/sso-providers/${data.saml.providerId}`, data.token);
    removeKeycloakSamlClients(keycloakAdmin());
  }
  http.put(`${BASE}/api/admin/signin-settings`, JSON.stringify(data.original), admin(data.token));
  const user = http.get(`${BASE}/api/admin/users?search=${encodeURIComponent(SSO_EMAIL)}`, admin(data.token)).json('items').find((u) => u.email === SSO_EMAIL);
  if (user) adminDelete(`${BASE}/api/admin/users/${user.id}`, data.token);
}

function fail(stage, res) {
  ssoFailed.add(1);
  if (!__ENV.QUIET) console.warn(`sso ${stage}: HTTP ${res.status} ${String(res.headers.Location || res.body || '').slice(0, 200)}`);
}

export function ssoLogin(data) {
  // A fresh cookie jar each time, so Keycloak shows its login form instead of reusing a session.
  const jar = new http.CookieJar();
  const began = Date.now();

  let res = http.get(`${BASE}/api/auth/sso/${data.providerId}/start`, { redirects: 0, jar, tags: { name: 'sso_start' } });
  ssoStart.add(res.timings.duration);
  const toIdp = res.headers.Location || '';
  if (res.status !== 302 || toIdp.includes('sso_error')) return fail('start', res);

  res = http.get(toIdp, { redirects: 0, jar, tags: { name: 'idp_login_page' } });
  const action = res.status === 200 ? res.html().find('#kc-form-login').attr('action') : null;
  if (!action) return fail('provider login page', res);

  res = http.post(action, { username: SSO_USER, password: SSO_PASSWORD, credentialId: '' }, { redirects: 0, jar, tags: { name: 'idp_login' } });
  idpLogin.add(res.timings.duration);
  const callback = res.headers.Location || '';
  if (res.status !== 302 || !callback.includes('/api/auth/sso/')) return fail('provider login', res);

  res = http.get(toBase(callback, data.publicOrigin), { redirects: 0, jar, tags: { name: 'sso_callback' } });
  ssoCallback.add(res.timings.duration);
  const landing = res.headers.Location || '';
  const code = /\/login\/sso\?code=([A-Za-z0-9_-]+)/.exec(landing);
  if (res.status !== 302 || !code) return fail('callback', res);

  res = http.post(`${BASE}/api/auth/sso/exchange`, JSON.stringify({ code: code[1] }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'sso_exchange' },
  });
  ssoExchange.add(res.timings.duration);
  if (res.status !== 200) return fail('exchange', res);
  ssoRoundTrip.add(Date.now() - began);

  const signedIn = http.get(`${BASE}/api/admin/config/gateway`, { headers: { Authorization: `Bearer ${res.json('token')}` }, tags: { name: 'sso_first_call' } });
  const ok = check(signedIn, { 'SSO session works': (r) => r.status === 200 });
  if (!ok) return fail('first signed-in call', signedIn);
  ssoFailed.add(0);
}

function samlFail(stage, res) {
  samlFailed.add(1);
  if (!__ENV.QUIET) console.warn(`saml ${stage}: HTTP ${res.status} ${String(res.headers.Location || res.body || '').slice(0, 200)}`);
}

export function samlLogin(data) {
  const jar = new http.CookieJar();
  const began = Date.now();

  let res = http.get(`${BASE}/api/auth/sso/${data.saml.providerId}/start`, { redirects: 0, jar, tags: { name: 'saml_start' } });
  samlStart.add(res.timings.duration);
  const toIdp = res.headers.Location || '';
  if (res.status !== 302 || !toIdp.includes('SAMLRequest=')) return samlFail('start', res);

  res = http.get(toIdp, { redirects: 0, jar, tags: { name: 'saml_idp_login_page' } });
  const action = res.status === 200 ? res.html().find('#kc-form-login').attr('action') : null;
  if (!action) return samlFail('provider login page', res);

  // Keycloak answers the credentials with an HTML form that posts the SAMLResponse to the ACS.
  res = http.post(action, { username: SSO_USER, password: SSO_PASSWORD, credentialId: '' }, { redirects: 0, jar, tags: { name: 'saml_idp_login' } });
  samlIdpLogin.add(res.timings.duration);
  const page = res.status === 200 ? res.html() : null;
  const acs = page ? page.find('form').attr('action') : null;
  const samlResponse = page ? page.find('input[name="SAMLResponse"]').attr('value') : null;
  const relayState = page ? page.find('input[name="RelayState"]').attr('value') : null;
  if (!acs || !samlResponse || !acs.includes('/api/auth/saml/')) return samlFail('provider login', res);

  res = http.post(toBase(acs, data.saml.publicOrigin), { SAMLResponse: samlResponse, RelayState: relayState }, { redirects: 0, jar, tags: { name: 'saml_acs' } });
  samlAcs.add(res.timings.duration);
  const code = /\/login\/sso\?code=([A-Za-z0-9_-]+)/.exec(res.headers.Location || '');
  if (res.status !== 303 || !code) return samlFail('acs', res);

  res = http.post(`${BASE}/api/auth/sso/exchange`, JSON.stringify({ code: code[1] }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'saml_exchange' },
  });
  samlExchange.add(res.timings.duration);
  if (res.status !== 200) return samlFail('exchange', res);
  samlRoundTrip.add(Date.now() - began);

  const signedIn = http.get(`${BASE}/api/admin/config/gateway`, { headers: { Authorization: `Bearer ${res.json('token')}` }, tags: { name: 'saml_first_call' } });
  if (!check(signedIn, { 'SAML session works': (r) => r.status === 200 })) return samlFail('first signed-in call', signedIn);
  samlFailed.add(0);
}

export function passwordSignIn() {
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: ADMIN_USER, password: ADMIN_PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'password_login' },
  });
  passwordLogin.add(res.timings.duration);
  passwordFailed.add(res.status !== 200);
}

export function signedInCalls(data) {
  const res = http.get(`${BASE}/api/admin/config/gateway`, { headers: { Authorization: `Bearer ${data.token}` }, tags: { name: 'session_api' } });
  sessionApi.add(res.timings.duration);
  const list = http.get(`${BASE}/api/auth/providers`, { tags: { name: 'providers' } });
  providersList.add(list.timings.duration);
  sessionFailed.add(res.status !== 200 || list.status !== 200);
}

function stat(data, name, key) {
  const metric = data.metrics[name];
  return metric && metric.values[key] !== undefined ? Math.round(metric.values[key] * 10) / 10 : null;
}

export function handleSummary(data) {
  const rows = [
    ['SSO round trip (incl. Keycloak)', 'sso_roundtrip_ms'],
    ['  DepGate start', 'sso_start_ms'],
    ['  Keycloak credential check', 'idp_login_ms'],
    ['  DepGate callback', 'sso_callback_ms'],
    ['  DepGate code exchange', 'sso_exchange_ms'],
    ['SAML round trip (incl. Keycloak)', 'saml_roundtrip_ms'],
    ['  DepGate start (AuthnRequest)', 'saml_start_ms'],
    ['  Keycloak credential check', 'saml_idp_login_ms'],
    ['  DepGate ACS', 'saml_acs_ms'],
    ['  DepGate code exchange', 'saml_exchange_ms'],
    ['Password sign-in', 'password_login_ms'],
    ['Signed-in API call', 'session_api_ms'],
    ['Public provider list', 'providers_ms'],
  ].map(([label, metric]) => ({
    label,
    metric,
    count: data.metrics[metric] ? data.metrics[metric].values.count ?? null : null,
    med: stat(data, metric, 'med'),
    p95: stat(data, metric, 'p(95)'),
    p99: stat(data, metric, 'p(99)'),
  }));
  const failures = {
    sso: stat(data, 'sso_failed', 'rate'),
    saml: stat(data, 'saml_failed', 'rate'),
    password: stat(data, 'password_failed', 'rate'),
    session: stat(data, 'session_failed', 'rate'),
  };
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [
    `DepGate sign-in load  vus=${VUS}  duration=${DURATION}  session rate=${SESSION_RATE}/s  base=${BASE}`,
    '',
    pad('', 34) + pad('count', 8) + pad('med ms', 10) + pad('p95 ms', 10) + 'p99 ms',
    ...rows.map((r) => pad(r.label, 34) + pad(r.count ?? '-', 8) + pad(r.med ?? '-', 10) + pad(r.p95 ?? '-', 10) + (r.p99 ?? '-')),
    '',
    `Failure rate  sso=${failures.sso}  saml=${failures.saml}  password=${failures.password}  session=${failures.session}`,
  ];
  const dir = (__ENV.RESULTS_DIR || 'perf/results').replace(/\/$/, '');
  return {
    stdout: `${lines.join('\n')}\n`,
    [`${dir}/sso.auth.json`]: JSON.stringify({ vus: VUS, duration: DURATION, sessionRate: SESSION_RATE, rows, failures }, null, 2),
  };
}
