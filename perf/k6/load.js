import http from 'k6/http';
import { sleep } from 'k6';
import { ECOSYSTEMS, catalog } from './catalog.js';
import { adminHeaders, adminJsonHeaders, baseUrl, mustJson } from './client.js';
import {
  installCargo,
  installComposer,
  installGo,
  installMaven,
  installNpm,
  installNuget,
  installPypi,
  installRubygems,
  observePin,
} from './install.js';
import { POLICY_PREFIX, RESTORE_NAME, SCENARIO_NOTES, SCENARIOS, expectsNameSplit, policiesFor } from './policies.js';

const scenario = __ENV.SCENARIO || 'mixed';
if (SCENARIOS.indexOf(scenario) === -1) {
  throw new Error(`Unknown SCENARIO "${scenario}". Use one of: ${SCENARIOS.join(', ')}`);
}

const selected = (__ENV.ECOSYSTEMS || ECOSYSTEMS.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const name of selected) {
  if (ECOSYSTEMS.indexOf(name) === -1) {
    throw new Error(`Unknown ecosystem "${name}". Use one of: ${ECOSYSTEMS.join(', ')}`);
  }
}

const vus = positiveInt(__ENV.VUS, 1);
const duration = __ENV.DURATION || '30s';

/** cached: how long the cold pass may take before the warm pass starts. */
const coldDuration = __ENV.COLD_DURATION || '3m';

const scenarios = {};
for (const eco of selected) {
  if (scenario === 'cached') {
    // One install per ecosystem against an empty cache, then the same installs served from it.
    scenarios[`${eco}_cold`] = {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: coldDuration,
      exec: eco,
      tags: { ecosystem: eco, scenario, phase: 'cold' },
    };
    scenarios[`${eco}_warm`] = {
      executor: 'constant-vus',
      vus,
      duration,
      startTime: coldDuration,
      exec: eco,
      tags: { ecosystem: eco, scenario, phase: 'warm' },
      gracefulStop: __ENV.GRACEFUL_STOP || '3m',
    };
    continue;
  }
  scenarios[eco] = {
    executor: 'constant-vus',
    vus,
    duration,
    exec: eco,
    tags: { ecosystem: eco, scenario },
    gracefulStop: __ENV.GRACEFUL_STOP || '3m',
  };
}

export const options = {
  scenarios,
  setupTimeout: '3m',
  teardownTimeout: '2m',
  insecureSkipTLSVerify: __ENV.INSECURE_SKIP_TLS === '1',
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'min', 'max', 'count'],
  thresholds: {
    unexpected_responses: ['rate<0.05'],
  },
};

http.setResponseCallback(http.expectedStatuses(200, 201, 204, 403, 404));

const runners = {
  npm: installNpm,
  pypi: installPypi,
  go: installGo,
  maven: installMaven,
  nuget: installNuget,
  cargo: installCargo,
  composer: installComposer,
  rubygems: installRubygems,
};

export function setup() {
  const health = http.get(`${baseUrl}/healthz`, { timeout: '10s', tags: { phase: 'admin' } });
  if (health.status !== 200) {
    throw new Error(`Gateway ${baseUrl} is not healthy: HTTP ${health.status}`);
  }

  const login = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({
      // Accounts sign in with an email address.
      email: __ENV.ADMIN_USER || 'admin@depgate.local',
      password: __ENV.ADMIN_PASSWORD || 'admin',
    }),
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: '30s', tags: { phase: 'admin' } }
  );
  const session = mustJson(login, 'login');
  if (!session.token) throw new Error('login response did not include a token');
  if (session.user && session.user.role !== 'Security') {
    throw new Error(`Account role is ${session.user.role}. Policy setup needs a Security account.`);
  }

  const headers = adminHeaders(session.token);
  const token = session.token;
  if (scenario === 'cached') clearArtifactCache(headers, token);
  restorePaused(headers, token);
  const removed = deleteLoadPolicies(headers);
  const foreign = listPolicies(headers).filter((policy) => !String(policy.name).startsWith(POLICY_PREFIX) && policy.isEnabled);
  const pausedIds = foreign.map((policy) => policy.id);
  const created = [];
  try {
    if (pausedIds.length > 0) created.push(createPolicy(token, restoreMarker(pausedIds)).id);
    for (const policy of foreign) setEnabled(token, policy.id, false);
    const repositories = scenario === 'scoped' ? scopedRepositories(headers, token) : {};
    for (const policy of policiesFor(scenario, selected, repositories)) created.push(createPolicy(token, policy).id);
    if (pausedIds.length > 0 || created.length > 0) {
      if (expectsNameSplit(scenario)) waitForPolicies(token);
      else sleep(6);
    }
  } catch (err) {
    for (const id of pausedIds) setEnabled(token, id, true);
    deleteLoadPolicies(headers);
    throw err;
  }

  const names = foreign.map((policy) => policy.name).join(', ');
  const rules = created.length - (pausedIds.length > 0 ? 1 : 0);
  console.log(`k6 scenario=${scenario} policies created=${rules} paused=${pausedIds.length} removed leftover=${removed}`);
  console.log(`k6 ${SCENARIO_NOTES[scenario]}`);
  if (names) console.log(`k6 paused: ${names}`);

  return { token, scenario, policyIds: created, pausedIds };
}

/** cached: the cold pass must start from an empty cache on every pod. */
function clearArtifactCache(headers, token) {
  const status = mustJson(
    http.get(`${baseUrl}/api/artifact-cache/status`, { headers, timeout: '30s', tags: { phase: 'admin' } }),
    'artifact cache status'
  );
  if (!status.enabled) {
    throw new Error('The cached scenario needs the artifact cache: set ARTIFACT_CACHE_ENABLED=true and ARTIFACT_CACHE_MAX_SIZE_GB on the gateway.');
  }
  const purged = http.post(`${baseUrl}/api/artifact-cache/purge`, JSON.stringify({ all: true }), {
    headers: adminJsonHeaders(token),
    timeout: '60s',
    tags: { phase: 'admin' },
  });
  const result = mustJson(purged, 'clear the artifact cache');
  console.log(`k6 artifact cache cleared on ${result.pods} pod(s)`);
  sleep(2);
}

/** Remote created per ecosystem for the scoped scenario's decoys. It never serves: `default` answers first. */
const DECOY_KEY = 'k6-load-decoy';

function listRepositories(headers) {
  return mustJson(
    http.get(`${baseUrl}/api/admin/repositories`, { headers, timeout: '30s', tags: { phase: 'admin' } }),
    'list repositories'
  );
}

/** Removes decoy remotes left by this or an interrupted run. */
function deleteDecoyRemotes(headers) {
  for (const row of listRepositories(headers).filter((r) => r.key === DECOY_KEY)) {
    http.del(`${baseUrl}/api/admin/repositories/${row.id}`, null, { headers, timeout: '30s', tags: { phase: 'admin' } });
  }
}

/**
 * Per ecosystem: the `default` remote, which serves the catalog through `all`, and a decoy remote
 * on the same upstream placed after it, which never serves. Policies scoped to `default` must
 * apply through `all`; the decoys, scoped to the decoy remote, must not (R5). Run with REPO=all.
 */
function scopedRepositories(headers, token) {
  deleteDecoyRemotes(headers);
  const rows = listRepositories(headers);
  const out = {};
  for (const eco of selected) {
    const target = rows.find((row) => row.ecosystem === eco && row.key === 'default');
    if (!target) throw new Error(`Repository ${eco}/default does not exist`);
    const created = http.post(
      `${baseUrl}/api/admin/repositories`,
      JSON.stringify({ ecosystem: eco, key: DECOY_KEY, type: 'remote', upstreamUrl: target.upstreamUrl, source: 'public', description: 'k6 load test. Safe to delete.' }),
      { headers: adminJsonHeaders(token), timeout: '30s', tags: { phase: 'admin' } }
    );
    out[eco] = { target: target.id, other: mustJson(created, `create ${eco}/${DECOY_KEY}`).id };
  }
  return out;
}

export function teardown(data) {
  if (!data || !data.token) return;
  const headers = adminHeaders(data.token);
  for (const id of data.pausedIds || []) setEnabled(data.token, id, true);
  deleteLoadPolicies(headers);
  if (data.scenario === 'scoped') deleteDecoyRemotes(headers);
}

export function npm(data) {
  runners.npm(data);
}
export function pypi(data) {
  runners.pypi(data);
}
export function go(data) {
  runners.go(data);
}
export function maven(data) {
  runners.maven(data);
}
export function nuget(data) {
  runners.nuget(data);
}
export function cargo(data) {
  runners.cargo(data);
}
export function composer(data) {
  runners.composer(data);
}
export function rubygems(data) {
  runners.rubygems(data);
}

export function handleSummary(data) {
  const rows = selected.map((eco) => rowFor(data, eco)).filter((row) => row.installs > 0);
  const report = {
    scenario,
    note: SCENARIO_NOTES[scenario],
    baseUrl,
    vus,
    duration,
    ecosystems: selected,
    rows,
  };
  const text = render(report);
  const dir = (__ENV.RESULTS_DIR || 'perf/results').replace(/\/$/, '');
  return {
    stdout: `${text}\n`,
    [`${dir}/${scenario}.report.json`]: JSON.stringify(report, null, 2),
  };
}

function rowFor(data, eco) {
  return {
    ecosystem: eco,
    installs: count(data, `${eco}_installs`),
    install_p95_ms: round(stat(data, `${eco}_install_ms`, 'p(95)')),
    install_med_ms: round(stat(data, `${eco}_install_ms`, 'med')),
    metadata_p95_ms: round(stat(data, `${eco}_metadata_ms`, 'p(95)')),
    metadata_med_ms: round(stat(data, `${eco}_metadata_ms`, 'med')),
    allowed_p95_ms: round(stat(data, `${eco}_allowed_download_ms`, 'p(95)')),
    allowed_med_ms: round(stat(data, `${eco}_allowed_download_ms`, 'med')),
    blocked_p95_ms: round(stat(data, `${eco}_blocked_download_ms`, 'p(95)')),
    blocked_med_ms: round(stat(data, `${eco}_blocked_download_ms`, 'med')),
    blocked_rate: round(rate(data, `${eco}_blocked`)),
    unexpected_rate: round(rate(data, `${eco}_unexpected`)),
    cache_hits: count(data, `${eco}_cache_hit_ms`),
    cache_misses: count(data, `${eco}_cache_miss_ms`),
    cache_bypasses: count(data, `${eco}_cache_bypass_ms`),
    cache_hit_p95_ms: round(stat(data, `${eco}_cache_hit_ms`, 'p(95)')),
    cache_miss_p95_ms: round(stat(data, `${eco}_cache_miss_ms`, 'p(95)')),
  };
}

function render(report) {
  const lines = [
    `DepGate load  scenario=${report.scenario}  vus=${report.vus}  duration=${report.duration}`,
    report.note,
    '',
    pad('ecosystem', 12) +
      pad('installs', 10) +
      pad('allow p95', 12) +
      pad('block p95', 12) +
      pad('meta p95', 12) +
      pad('blocked', 10) +
      'errors',
  ];
  for (const row of report.rows) {
    lines.push(
      pad(row.ecosystem, 12) +
        pad(String(row.installs), 10) +
        pad(ms(row.allowed_p95_ms), 12) +
        pad(ms(row.blocked_p95_ms), 12) +
        pad(ms(row.metadata_p95_ms), 12) +
        pad(pct(row.blocked_rate), 10) +
        pct(row.unexpected_rate)
    );
  }
  if (report.rows.length === 0) lines.push('(no completed installs)');
  if (report.scenario === 'cached') {
    lines.push('');
    lines.push(pad('ecosystem', 12) + pad('cold p95', 12) + pad('warm p95', 12) + pad('stored', 10) + pad('hits', 10) + 'not stored');
    for (const row of report.rows) {
      lines.push(
        pad(row.ecosystem, 12) +
          pad(ms(row.cache_miss_p95_ms), 12) +
          pad(ms(row.cache_hit_p95_ms), 12) +
          pad(String(row.cache_misses), 10) +
          pad(String(row.cache_hits), 10) +
          String(row.cache_bypasses)
      );
    }
  }
  lines.push('');
  lines.push('Times are milliseconds. allow p95 is a served file. block p95 is a rejected file (HTTP 403).');
  lines.push('PyPI, Composer, and RubyGems block p95 is the index response that dropped the pin.');
  if (report.scenario === 'cached') {
    lines.push('cold p95 is a file fetched from the registry and stored (MISS); warm p95 is a file served from the cache (HIT).');
  }
  return lines.join('\n');
}

function restoreMarker(pausedIds) {
  return {
    name: RESTORE_NAME,
    description: JSON.stringify({ paused: pausedIds }),
    decision: 'ALLOW',
    priority: 1000,
    isEnabled: false,
    conditions: { packageBlockList: ['__k6_restore_marker__'] },
  };
}

function createPolicy(token, policy) {
  const res = http.post(`${baseUrl}/api/admin/policies`, JSON.stringify(policy), {
    headers: adminJsonHeaders(token),
    timeout: '30s',
    tags: { phase: 'admin' },
  });
  return mustJson(res, `create policy ${policy.name}`);
}

function setEnabled(token, id, isEnabled) {
  const res = http.put(`${baseUrl}/api/admin/policies/${id}`, JSON.stringify({ isEnabled }), {
    headers: adminJsonHeaders(token),
    timeout: '30s',
    tags: { phase: 'admin' },
  });
  if (res.status === 404) return;
  mustJson(res, `${isEnabled ? 'enable' : 'disable'} policy ${id}`);
}

function restorePaused(headers, token) {
  const marker = listPolicies(headers).find((policy) => policy.name === RESTORE_NAME);
  if (!marker) return;
  let ids = [];
  try {
    const parsed = JSON.parse(marker.description || '{}');
    if (parsed && Array.isArray(parsed.paused)) ids = parsed.paused;
  } catch (err) {
    ids = [];
  }
  for (const id of ids) setEnabled(token, id, true);
  const res = http.del(`${baseUrl}/api/admin/policies/${marker.id}`, null, {
    headers,
    timeout: '30s',
    tags: { phase: 'admin' },
  });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`delete restore marker failed: HTTP ${res.status}`);
  }
  if (ids.length > 0) console.log(`k6 restored ${ids.length} policies paused by an earlier run`);
}

function waitForPolicies(token) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    sleep(attempt === 0 ? 6 : 5);
    try {
      assertPoliciesApply(token);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function assertPoliciesApply(token) {
  const eco = selected[0];
  const pins = catalog[eco] || [];
  const deny = pins.find((pkg) => pkg.list === 'deny');
  const approve = pins.find((pkg) => pkg.list === 'approve');
  if (!deny || !approve) throw new Error(`Catalog for ${eco} needs a deny pin and an approve pin.`);
  const denyStatus = observePin(eco, deny, token);
  if (denyStatus !== 403) {
    throw new Error(
      `Block policy was not enforced on ${eco}: ${deny.name}@${deny.version} returned HTTP ${denyStatus} (expected 403).`
    );
  }
  const allowStatus = observePin(eco, approve, token);
  if (allowStatus !== 200) {
    throw new Error(
      `Allow policy was not enforced on ${eco}: ${approve.name}@${approve.version} returned HTTP ${allowStatus} (expected 200).`
    );
  }
}

function listPolicies(headers) {
  const items = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const res = http.get(`${baseUrl}/api/admin/policies?limit=100&offset=${offset}`, {
      headers,
      timeout: '30s',
      tags: { phase: 'admin' },
    });
    const body = mustJson(res, 'list policies');
    const batch = body.items || [];
    items.push(...batch);
    offset += batch.length;
    if (batch.length === 0 || offset >= (body.total || 0)) break;
  }
  return items;
}

function deleteLoadPolicies(headers) {
  const stale = listPolicies(headers).filter((policy) => String(policy.name).startsWith(POLICY_PREFIX));
  for (const policy of stale) {
    const res = http.del(`${baseUrl}/api/admin/policies/${policy.id}`, null, {
      headers,
      timeout: '30s',
      tags: { phase: 'admin' },
    });
    if (res.status !== 204 && res.status !== 404) {
      throw new Error(`delete policy ${policy.name} failed: HTTP ${res.status}`);
    }
  }
  return stale.length;
}

function stat(data, metric, name) {
  const values = data.metrics[metric] && data.metrics[metric].values;
  if (!values || values[name] === undefined) return null;
  return values[name];
}

function rate(data, metric) {
  const values = data.metrics[metric] && data.metrics[metric].values;
  if (!values || values.rate === undefined) return null;
  return values.rate;
}

function count(data, metric) {
  const values = data.metrics[metric] && data.metrics[metric].values;
  if (!values || values.count === undefined) return 0;
  return values.count;
}

function round(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(value * 10) / 10;
}

function ms(value) {
  return value === null ? '-' : value.toFixed(0);
}

function pct(value) {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
}

function positiveInt(raw, fallback) {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
