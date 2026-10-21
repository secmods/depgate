/**
 * Fills the screenshot instance (docker-compose.yml in this folder) with demo data for a fictional
 * company, Acme: repositories, policies, people, single sign-on, a webhook, log streaming destinations,
 * exceptions, waiver requests, and real package downloads so the Dashboard, Decision Ledger, Monitoring
 * and Artifact cache pages have something to show.
 *
 *   node docs/scripts/seed.mjs
 *
 * Needs outbound internet (public registries), Verdaccio on localhost:4873 with @acme/billing, Mailpit on
 * localhost:8025 (for the invited user), and the Keycloak from docker-compose.yml on localhost:8180 (for the
 * identity providers; without it they are saved turned off). Safe to run twice.
 */

const BASE = process.env.DOCS_BASE_URL ?? 'http://localhost:3060';
const ADMIN = { email: process.env.DOCS_ADMIN_EMAIL ?? 'security@example.com', password: process.env.DOCS_ADMIN_PASSWORD ?? 'docs-demo-admin' };
const DEV = { email: 'alice.chen@example.com', password: 'docs-demo-user' };
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const GATEWAY_ORIGIN = 'https://depgate.example.com';
/** The identity provider as the app container reaches it (the browser resolves the same name to 127.0.0.1). */
const KEYCLOAK_ISSUER = 'http://keycloak.localhost:8180/realms/depgate';
/** The same Keycloak from this script, on its published port. */
const KEYCLOAK_ADMIN = process.env.DOCS_KEYCLOAK_URL ?? 'http://localhost:8180';

const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString();

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok && res.status !== 409) console.warn(`  ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, body: json };
}

async function login(user) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (!res.ok) throw new Error(`Login failed for ${user.email}: ${res.status}`);
  return res.json();
}

// ── Setup ──────────────────────────────────────────────────────────────────

async function setupAdmin() {
  const { token } = await login(ADMIN);
  console.log('Mail settings');
  await api(token, 'PUT', '/api/admin/mail-settings', {
    host: 'host.docker.internal', port: 1025, secure: false, from: 'DepGate <no-reply@example.com>',
  });

  console.log('Repositories');
  await api(token, 'POST', '/api/admin/repositories', {
    ecosystem: 'npm', key: 'acme-internal', type: 'remote', source: 'internal',
    upstreamUrl: 'http://npm.acme.internal:4873', description: 'Acme private packages (Verdaccio)',
  });
  await api(token, 'POST', '/api/admin/repositories', {
    ecosystem: 'pypi', key: 'acme-pypi', type: 'remote', source: 'internal',
    upstreamUrl: 'https://pypi.acme.internal/simple', description: 'Acme private Python packages', isEnabled: false,
  });
  const repos = (await api(token, 'GET', '/api/admin/repositories?ecosystem=npm')).body;
  const npmAll = repos.find((r) => r.key === 'all');
  if (npmAll) await api(token, 'PUT', `/api/admin/repositories/${npmAll.id}`, { memberKeys: ['acme-internal', 'default'] });
  await api(token, 'POST', '/api/admin/repositories', {
    ecosystem: 'npm', key: 'frontend', type: 'virtual', memberKeys: ['acme-internal', 'default'],
    description: 'Entry point for the web team',
  });

  // A new installation already has the eight starter policies; these are Acme's own additions.
  console.log('Policies');
  const policies = [
    { name: 'Protect the @acme namespace', description: 'Internal package names are served only from the internal registry.', decision: 'BLOCK', mode: 'enforce', priority: 1,
      conditions: { ecosystem: ['npm'], reservedNamespaces: ['@acme', 'acme-*'], publicPackages: ['@acme/eslint-config'] } },
    { name: 'Block lodash before 4.17.21', description: 'Prototype pollution fixed in 4.17.21.', decision: 'BLOCK', mode: 'enforce', priority: 5,
      conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '0.0.0 - 4.17.20' } },
    { name: 'Likely-exploited high vulnerabilities', description: 'High-rated vulnerabilities with at least a 10 % chance of exploitation (EPSS).', decision: 'BLOCK', mode: 'monitor', priority: 20,
      conditions: { cvssMin: 7.0, epssMin: 0.1, epssUnknown: 'ignore' } },
    { name: 'Banned licenses', description: 'Network copyleft and source-available licenses.', decision: 'BLOCK', mode: 'enforce', priority: 30,
      conditions: { licenseDenyList: ['AGPL-3.0', 'SSPL-1.0', 'BUSL-1.1'] } },
    { name: 'Approved licenses (npm)', description: 'Only licenses approved by Legal.', decision: 'BLOCK', mode: 'monitor', priority: 40,
      conditions: { ecosystem: ['npm'], licenseAllowList: ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD'], allowUnknownLicense: false } },
  ];
  const existing = (await api(token, 'GET', '/api/admin/policies?limit=100')).body.items ?? [];
  const byName = new Map(existing.map((p) => [p.name, p]));
  for (const p of policies) {
    if (byName.has(p.name)) continue;
    const created = await api(token, 'POST', '/api/admin/policies', p);
    if (created.status < 300) byName.set(p.name, created.body);
  }

  console.log('Webhook');
  const hooks = (await api(token, 'GET', '/api/admin/webhooks')).body;
  if (!Array.isArray(hooks) || hooks.length === 0) {
    await api(token, 'POST', '/api/admin/webhooks', {
      url: 'http://siem.acme.internal/depgate', secret: 'docs-demo-webhook-secret',
      events: ['package_blocked', 'malware_requested', 'dependency_confusion_blocked'],
    });
  }

  console.log('People');
  for (const [email, role] of [[DEV.email, 'User'], ['ben.ortiz@example.com', 'User'], ['priya.nair@example.com', 'Security']]) {
    await api(token, 'POST', '/api/admin/users', { email, role });
  }
  const accounts = (await api(token, 'GET', '/api/admin/service-accounts?search=github-actions')).body.items ?? [];
  let serviceKey = null;
  if (!accounts.some((a) => a.name === 'github-actions')) {
    const sa = await api(token, 'POST', '/api/admin/service-accounts', { name: 'github-actions' });
    serviceKey = sa.body?.key ?? sa.body?.apiKey ?? null;
  }
  const jenkins = (await api(token, 'GET', '/api/admin/service-accounts?search=jenkins-prod')).body.items ?? [];
  if (!jenkins.some((a) => a.name === 'jenkins-prod')) await api(token, 'POST', '/api/admin/service-accounts', { name: 'jenkins-prod' });

  console.log('Exception');
  const exceptions = (await api(token, 'GET', '/api/admin/exceptions')).body.items ?? [];
  if (!exceptions.length) {
    await api(token, 'POST', '/api/admin/exceptions', {
      ecosystem: 'npm', packageName: 'lodash', version: '4.17.20', expiresAt: days(21),
      reason: 'Legacy billing service is pinned to 4.17.20. Upgrade tracked in SEC-1423.',
    });
  }
  return { token, serviceKey, policies: byName };
}

// ── Single sign-on ─────────────────────────────────────────────────────────

async function keycloakAdminToken() {
  const res = await fetch(`${KEYCLOAK_ADMIN}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'admin' }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Keycloak admin sign-in failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

/** Registers DepGate as a SAML client in Keycloak, as an admin would after copying the SP entity ID and ACS URL. */
async function registerSamlClient(spEntityId, acsUrl) {
  const kc = await keycloakAdminToken();
  const headers = { authorization: `Bearer ${kc}`, 'content-type': 'application/json' };
  const found = await fetch(`${KEYCLOAK_ADMIN}/admin/realms/depgate/clients?clientId=${encodeURIComponent(spEntityId)}`, { headers }).then((r) => r.json());
  const client = {
    clientId: spEntityId, name: 'DepGate (SAML)', protocol: 'saml', enabled: true, frontchannelLogout: false, redirectUris: [acsUrl],
    attributes: {
      'saml.assertion.signature': 'true', 'saml.server.signature': 'true', 'saml.client.signature': 'false', 'saml.encrypt': 'false',
      'saml.force.post.binding': 'true', 'saml.authnstatement': 'true', 'saml.signature.algorithm': 'RSA_SHA256',
      saml_signature_canonicalization_method: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      saml_force_name_id_format: 'true', saml_name_id_format: 'email', saml_assertion_consumer_url_post: acsUrl,
    },
    protocolMappers: [
      { name: 'email', protocol: 'saml', protocolMapper: 'saml-user-property-mapper',
        config: { 'user.attribute': 'email', 'attribute.name': 'email', 'attribute.nameformat': 'Basic', 'friendly.name': 'email' } },
      { name: 'firstName', protocol: 'saml', protocolMapper: 'saml-user-property-mapper',
        config: { 'user.attribute': 'firstName', 'attribute.name': 'firstName', 'attribute.nameformat': 'Basic' } },
    ],
  };
  const existing = Array.isArray(found) ? found[0] : null;
  const res = await fetch(existing ? `${KEYCLOAK_ADMIN}/admin/realms/depgate/clients/${existing.id}` : `${KEYCLOAK_ADMIN}/admin/realms/depgate/clients`, {
    method: existing ? 'PUT' : 'POST', headers, body: JSON.stringify(client),
  });
  if (!res.ok) throw new Error(`Keycloak SAML client: HTTP ${res.status} ${await res.text()}`);
}

async function singleSignOn(token) {
  console.log('Single sign-on');
  // acme.test is the domain of the people in the demo identity provider (e2e/keycloak/depgate-realm.json).
  await api(token, 'PUT', '/api/admin/signin-settings', { allowedDomains: ['example.com', 'acme.test'], allowUnlistedSso: true });
  // A Security user who signs in through the provider, so the test sign-in shows a configured role.
  await api(token, 'POST', '/api/admin/users', { email: 'alice@acme.test', role: 'Security', sendInvite: false });

  const providers = (await api(token, 'GET', '/api/admin/sso-providers')).body;
  const names = new Set(Array.isArray(providers) ? providers.map((p) => p.name) : []);

  if (!names.has('Acme SSO')) {
    const created = await api(token, 'POST', '/api/admin/sso-providers', {
      type: 'oidc', name: 'Acme SSO', buttonLabel: 'Sign in with Acme SSO', enabled: true,
      oidc: {
        issuer: KEYCLOAK_ISSUER, clientId: 'depgate', clientSecret: 'depgate-dev-secret', scopes: 'openid email profile',
        emailClaim: 'email', requireVerifiedEmail: true, requiredClaims: [], useDiscovery: true,
        clientAuthMethod: 'client_secret_basic', clockSkewSeconds: 60, extraAuthParams: [],
      },
    });
    console.log(`  OIDC provider: ${created.status}${created.body?.validationError ? ` (saved turned off: ${created.body.validationError})` : ''}`);
  }

  if (!names.has('Acme SAML')) {
    const setup = (await api(token, 'GET', '/api/admin/sso-providers/setup')).body;
    try {
      await registerSamlClient(setup.urls.spEntityId, setup.urls.acsUrl);
    } catch (err) {
      console.warn(`  SAML client not registered in Keycloak: ${err.message}`);
    }
    const created = await api(token, 'POST', '/api/admin/sso-providers', {
      id: setup.id, type: 'saml', name: 'Acme SAML', buttonLabel: 'Sign in with Acme SAML', enabled: false,
      saml: {
        metadataUrl: `${KEYCLOAK_ISSUER}/protocol/saml/descriptor`,
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', emailAttribute: '', subjectAttribute: '',
        requiredAttributes: [], requireSignedAssertion: true, signRequests: false, acceptEncryptedAssertions: false, clockSkewSeconds: 60,
      },
    });
    console.log(`  SAML provider: ${created.status}${created.body?.validationError ? ` (${created.body.validationError})` : ''}`);
  }
}

// ── Log streaming ──────────────────────────────────────────────────────────

/** The Recommended preset: whole features whose events are all recommended, single events otherwise. */
function recommended(catalog) {
  const features = [];
  const events = [];
  for (const feature of catalog.features) {
    const all = feature.groups.flatMap((g) => g.events);
    const chosen = all.filter((e) => e.default);
    if (chosen.length === all.length) features.push(feature.feature);
    else events.push(...chosen.map((e) => e.key));
  }
  return { features, events };
}

async function logStreaming(token) {
  console.log('Log streaming');
  const catalog = (await api(token, 'GET', '/api/admin/events/catalog')).body;
  const list = (await api(token, 'GET', '/api/admin/stream-destinations')).body;
  const names = new Set((list?.items ?? []).map((d) => d.name));
  const destinations = [
    { name: 'Acme SIEM (Cribl)', type: 'http', enabled: true, selection: recommended(catalog),
      settings: { url: 'http://siem.acme.internal/depgate/events', method: 'POST', format: 'ndjson', gzip: 'on' } },
    { name: 'Platform logs', type: 'jsonl', enabled: true, selection: { features: catalog.features.map((f) => f.feature), events: [] }, settings: {} },
    { name: 'SOC syslog (QRadar)', type: 'syslog', enabled: false, selection: recommended(catalog),
      settings: { host: 'syslog.acme.internal', port: '6514', transport: 'tls', format: 'cef', facility: 'local0', appName: 'depgate' } },
  ];
  for (const d of destinations) {
    if (names.has(d.name)) continue;
    const created = await api(token, 'POST', '/api/admin/stream-destinations', d);
    console.log(`  ${d.name}: ${created.status}`);
  }
}

/** Accepts alice's invitation through the link in Mailpit, so she can sign in. */
async function activateDeveloper() {
  try {
    await login(DEV);
    return;
  } catch { /* not yet active */ }
  const search = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${DEV.email}`)}`).then((r) => r.json());
  const id = search.messages?.[0]?.ID;
  if (!id) throw new Error('No invitation for alice in Mailpit');
  const message = await fetch(`${MAILPIT}/api/v1/message/${id}`).then((r) => r.json());
  const token = /token=([A-Za-z0-9._~-]+)/.exec(message.Text ?? message.HTML ?? '')?.[1];
  if (!token) throw new Error('No token in the invitation');
  const res = await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: decodeURIComponent(token), password: DEV.password }),
  });
  if (!res.ok) throw new Error(`set-password ${res.status} ${await res.text()}`);
}

// ── Traffic ────────────────────────────────────────────────────────────────

const local = (url) => url.replace(GATEWAY_ORIGIN, BASE);

async function download(url, headers) {
  try {
    const res = await fetch(local(url), { headers });
    await res.arrayBuffer();
    return res.status;
  } catch (err) {
    return `error ${err.message}`;
  }
}

async function npmInstall(token, name, version, repo = 'default') {
  const headers = { authorization: `Bearer ${token}` };
  const meta = await fetch(`${BASE}/npm/${repo}/${name.replace(/\//g, '%2f')}`, { headers });
  if (!meta.ok) return `meta ${meta.status}`;
  const doc = await meta.json();
  // DepGate drops the latest tag when that version is blocked (for example by the 72-hour quarantine); take the newest listed version then.
  const v = version ?? doc['dist-tags']?.latest ?? Object.keys(doc.versions ?? {}).pop();
  const tarball = doc.versions?.[v]?.dist?.tarball
    ?? `${BASE}/npm/${repo}/${name}/-/${name.split('/').pop()}-${v}.tgz`;
  return download(tarball, headers);
}

async function pypiInstall(token, name) {
  const headers = { authorization: `Basic ${Buffer.from(`_:${token}`).toString('base64')}` };
  const index = await fetch(`${BASE}/pypi/default/simple/${name}/`, { headers });
  if (!index.ok) return `index ${index.status}`;
  const html = await index.text();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const file = links.reverse().find((l) => /\.whl|\.tar\.gz/.test(l) && !/data-yanked/.test(l));
  return file ? download(new URL(file, `${BASE}/pypi/default/simple/${name}/`).href, headers) : 'no file';
}

async function basicGet(token, path) {
  return download(BASE + path, { authorization: `Basic ${Buffer.from(`_:${token}`).toString('base64')}` });
}

async function traffic(registryToken, label) {
  console.log(`Traffic as ${label}`);
  const npm = [
    'express', 'react', 'react-dom', 'axios', 'chalk', 'commander', 'debug', 'semver', 'uuid', 'dotenv', 'zod', 'yargs',
    'typescript', 'prettier', 'ms', 'qs', 'mime', 'cookie', 'body-parser', 'minimist',
    // licenses outside the approved npm list (recorded by the monitoring policy)
    'caniuse-lite', 'argparse', 'spdx-exceptions', 'spdx-license-ids', 'lz-string', 'jackspeak', 'path-scurry', 'mdn-data',
  ];
  for (const name of npm) console.log(`  npm ${name}: ${await npmInstall(registryToken, name)}`);
  const pinned = [
    ['lodash', '4.17.20'], ['lodash', '4.17.19'], ['lodash', '4.17.15'], ['lodash', '4.17.21'],
    ['minimist', '1.2.5'], ['shell-quote', '1.7.2'], ['node-fetch', '2.6.0'], ['axios', '0.21.0'],
    ['follow-redirects', '1.14.0'], ['ws', '7.4.5'], ['json5', '2.2.1'], ['semver', '7.5.1'],
    ['typescript', '5.7.0-beta'], ['react', '19.0.0-rc.1'], ['vue', '3.5.0-beta.1'],
    ['event-stream', '3.3.6'],
  ];
  for (const [name, v] of pinned) console.log(`  npm ${name}@${v}: ${await npmInstall(registryToken, name, v)}`);
  console.log(`  npm @acme/billing via all: ${await npmInstall(registryToken, '@acme/billing', undefined, 'all')}`);
  console.log(`  npm @acme/billing via default: ${await npmInstall(registryToken, '@acme/billing', undefined, 'default')}`);
  for (const name of ['requests', 'idna', 'certifi', 'urllib3', 'six', 'click', 'flask', 'jinja2', 'itsdangerous', 'packaging']) {
    console.log(`  pypi ${name}: ${await pypiInstall(registryToken, name)}`);
  }
  for (const [path, label2] of [
    ['/maven/default/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar', 'maven commons-lang3'],
    ['/maven/default/com/google/code/gson/gson/2.11.0/gson-2.11.0.jar', 'maven gson'],
    ['/maven/default/org/apache/logging/log4j/log4j-core/2.14.1/log4j-core-2.14.1.jar', 'maven log4j-core 2.14.1'],
    ['/go/default/github.com/google/uuid/@v/v1.6.0.zip', 'go uuid'],
    ['/go/default/github.com/spf13/cobra/@v/v1.8.1.zip', 'go cobra'],
    ['/cargo/default/api/v1/crates/serde/1.0.210/download', 'cargo serde'],
    ['/cargo/default/api/v1/crates/anyhow/1.0.89/download', 'cargo anyhow'],
    ['/rubygems/default/gems/rake-13.2.1.gem', 'rubygems rake'],
    ['/nuget/default/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg', 'nuget Newtonsoft.Json'],
  ]) {
    console.log(`  ${label2}: ${await basicGet(registryToken, path)}`);
  }
}

// ── Waivers ────────────────────────────────────────────────────────────────

async function waivers(devToken, adminToken) {
  const mine = (await api(devToken, 'GET', '/api/waiver-requests')).body.items ?? [];
  if (mine.length) return;
  console.log('Waiver requests');
  const requests = [
    { ecosystem: 'npm', packageName: 'shell-quote', version: '1.7.2', expiresAt: days(14), reason: 'Build tooling only, never shipped. Upgrade blocked by a transitive pin in our bundler; needed for the 4.2 release branch.' },
    { ecosystem: 'npm', packageName: 'typescript', version: '5.7.0-beta', expiresAt: days(30), reason: 'Evaluating the new compiler flags in a spike branch.' },
    { ecosystem: 'npm', packageName: 'minimist', version: '1.2.5', expiresAt: days(7), reason: 'Pinned by a vendored CLI; replacing it this sprint.' },
  ];
  const created = [];
  for (const r of requests) created.push((await api(devToken, 'POST', '/api/waiver-requests', r)).body);
  const last = created[2];
  if (last?.id) await api(adminToken, 'POST', `/api/waiver-requests/${last.id}/reject`, { reviewNote: 'minimist 1.2.6 is a drop-in fix. Please upgrade instead.' });
}

// ── Run ────────────────────────────────────────────────────────────────────

const { token: adminToken, serviceKey } = await setupAdmin();
await singleSignOn(adminToken).catch((err) => console.warn(`  Single sign-on not set up: ${err.message}`));
await logStreaming(adminToken).catch((err) => console.warn(`  Log streaming not set up: ${err.message}`));
await activateDeveloper().catch((err) => console.warn(`  Developer not activated: ${err.message}`));

const admin = await login(ADMIN);
let dev = null;
try { dev = await login(DEV); } catch { /* traffic as admin only */ }

await traffic((dev ?? admin).registryToken, dev ? DEV.email : ADMIN.email);
if (serviceKey) {
  const ci = await api(serviceKey, 'POST', '/api/admin/ci-tokens', {
    name: 'github-actions', expiresIn: '2h', metadata: { repository: 'acme/storefront', pr_number: '4821', build_number: '9102' },
  });
  if (ci.body?.token) await traffic(ci.body.token, 'CI token github-actions');
}
// The same files a second time, so the artifact cache shows hits.
await traffic(admin.registryToken, ADMIN.email);
if (dev) await waivers(dev.token, adminToken);
console.log('Done');

// Show a production-like mail server on the Email tab (invitations above went to Mailpit).
await api(adminToken, 'PUT', '/api/admin/mail-settings', {
  host: 'smtp.acme.internal', port: 587, secure: false, user: 'depgate', password: 'docs-demo-smtp', from: 'DepGate <no-reply@acme.example>',
});
