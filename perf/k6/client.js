import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { ECOSYSTEMS } from './catalog.js';

export const baseUrl = (__ENV.BASE_URL || 'http://localhost:3050').replace(/\/$/, '');
export const repo = __ENV.REPO || 'default';
export const timeout = __ENV.TIMEOUT || '120s';
export const skipDownload = __ENV.SKIP_DOWNLOAD === '1' || __ENV.SKIP_DOWNLOAD === 'true';

const GATEWAY_PREFIXES = ['/npm/', '/pypi/', '/go/', '/maven/', '/nuget/', '/cargo/', '/composer/', '/rubygems/'];

/** One series per ecosystem so the summary can be compared without tag cardinality. */
export const series = {};
for (const eco of ECOSYSTEMS) {
  series[eco] = {
    install: new Trend(`${eco}_install_ms`, true),
    metadata: new Trend(`${eco}_metadata_ms`, true),
    artifact: new Trend(`${eco}_artifact_ms`, true),
    allowedDownload: new Trend(`${eco}_allowed_download_ms`, true),
    blockedDownload: new Trend(`${eco}_blocked_download_ms`, true),
    blocked: new Rate(`${eco}_blocked`),
    unexpected: new Rate(`${eco}_unexpected`),
    installs: new Counter(`${eco}_installs`),
    cacheHit: new Trend(`${eco}_cache_hit_ms`, true),
    cacheMiss: new Trend(`${eco}_cache_miss_ms`, true),
    cacheBypass: new Trend(`${eco}_cache_bypass_ms`, true),
  };
}

export const unexpectedResponses = new Rate('unexpected_responses');
export const allowedDownload = new Trend('allowed_download_ms', true);
export const blockedDownload = new Trend('blocked_download_ms', true);

export function joinUrl(base, path) {
  return `${base.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

export function authHeaders(token, userAgent, accept) {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': userAgent,
    Accept: accept,
  };
}

/**
 * k6 does not provide the URL constructor. Split an absolute http(s) URL ourselves.
 * Returns null when the string is not an absolute http(s) URL.
 */
function parseHttpUrl(url) {
  const match = /^(https?:)\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(url);
  if (!match) return null;
  return {
    protocol: match[1].toLowerCase(),
    host: match[2],
    pathname: match[3] || '/',
    search: match[4] || '',
  };
}

/**
 * Keep a URL only when it already targets this gateway.
 * Artifact links that still point at the upstream registry are not followed.
 * A gateway URL on another host (GATEWAY_URL vs BASE_URL) is rewritten onto BASE_URL.
 */
export function asGateway(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/')) {
    return GATEWAY_PREFIXES.some((prefix) => url.startsWith(prefix)) ? joinUrl(baseUrl, url) : null;
  }
  const parsed = parseHttpUrl(url);
  const origin = parseHttpUrl(baseUrl);
  if (!parsed || !origin) return null;
  const onGateway =
    parsed.host === origin.host || GATEWAY_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
  if (!onGateway) return null;
  return `${origin.protocol}//${origin.host}${parsed.pathname}${parsed.search}`;
}

export function bodyJson(res) {
  if (!res || res.status === 0 || !res.body) return null;
  try {
    return res.json();
  } catch (err) {
    return null;
  }
}

export function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // `&amp;` last, so that "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, '&');
}

function trendFor(eco, phase) {
  if (phase === 'artifact') return series[eco].artifact;
  return series[eco].metadata;
}

export function recordHttp(eco, phase, res, packageName) {
  const duration = res && res.timings ? res.timings.duration : 0;
  trendFor(eco, phase).add(duration);
  const ok = res && (res.status === 200 || res.status === 403);
  check(res, { 'http 200 or 403': (r) => r.status === 200 || r.status === 403 });
  if (!ok && __ENV.QUIET !== '1') {
    const path = res && res.url ? String(res.url).split('?')[0] : packageName;
    console.warn(`k6: ${eco} ${phase} ${packageName} HTTP ${res ? res.status : 0} ${path}`);
  }
  return res && res.status === 403 ? 'block' : ok ? 'ok' : 'error';
}

/**
 * Time the file transfer. HTTP 200 is an allowed download. HTTP 403 is a blocked download.
 */
export function recordArtifact(eco, res, packageName) {
  const duration = res && res.timings ? res.timings.duration : 0;
  series[eco].artifact.add(duration);
  const status = res ? res.status : 0;
  if (status === 200) {
    series[eco].allowedDownload.add(duration);
    allowedDownload.add(duration);
    // HIT, MISS (fetched and stored) or BYPASS (fetched, not stored); absent before the artifact cache existed.
    const cache = String((res.headers && res.headers['X-Depgate-Cache']) || '').toUpperCase();
    if (cache === 'HIT') series[eco].cacheHit.add(duration);
    else if (cache === 'MISS') series[eco].cacheMiss.add(duration);
    else if (cache === 'BYPASS') series[eco].cacheBypass.add(duration);
  } else if (status === 403) {
    series[eco].blockedDownload.add(duration);
    blockedDownload.add(duration);
  }
  check(res, { 'artifact 200 or 403': (r) => r.status === 200 || r.status === 403 });
  if (status !== 200 && status !== 403 && __ENV.QUIET !== '1') {
    const path = res && res.url ? String(res.url).split('?')[0] : packageName;
    console.warn(`k6: ${eco} artifact ${packageName} HTTP ${status} ${path}`);
  }
  if (status === 200) return 'allow';
  if (status === 403) return 'block';
  return 'error';
}

/**
 * PyPI, Composer, and RubyGems drop a blocked file from the index and never mint a
 * download URL. The index response is the blocked-download sample for those pins.
 */
export function recordStoppedDownload(eco, res) {
  const duration = res && res.timings ? res.timings.duration : 0;
  series[eco].blockedDownload.add(duration);
  blockedDownload.add(duration);
}

/**
 * One sample per package. mixed, block-package, and allowlist require deny pins to
 * block and approve pins to download. Anything else in those scenarios is an error.
 */
export function finishPackage(eco, scenario, pkg, outcome, detail) {
  const blocked = outcome === 'block';
  const listChecked = scenario === 'mixed' || scenario === 'block-package' || scenario === 'allowlist';
  let unexpected = outcome === 'error';
  if (listChecked && pkg.list === 'deny' && outcome !== 'block') unexpected = true;
  if (listChecked && pkg.list === 'approve' && outcome !== 'allow') unexpected = true;
  if (scenario === 'allow' && outcome === 'block') unexpected = true;
  series[eco].blocked.add(blocked);
  series[eco].unexpected.add(unexpected);
  unexpectedResponses.add(unexpected);
  if (unexpected && __ENV.QUIET !== '1') {
    console.warn(`k6: ${eco} ${pkg.name}@${pkg.version} ${outcome}${detail ? ` (${detail})` : ''}`);
  }
}

export function missingVersionOutcome(scenario) {
  return scenario === 'allow' ? 'error' : 'block';
}

export function batchGet(urls, headers, eco, phase) {
  if (urls.length === 0) return [];
  return http.batch(
    urls.map((entry) => ({
      method: 'GET',
      url: entry.url,
      params: {
        headers,
        timeout,
        responseType: phase === 'artifact' ? 'none' : 'text',
        tags: { ecosystem: eco, phase, scenario: __ENV.SCENARIO || 'mixed' },
      },
    }))
  );
}

export function adminHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

export function adminJsonHeaders(token) {
  return Object.assign({ 'Content-Type': 'application/json' }, adminHeaders(token));
}

export function mustJson(res, what) {
  if (!res || res.status < 200 || res.status >= 300) {
    const body = res && res.body ? String(res.body).slice(0, 300) : '';
    throw new Error(`${what} failed: HTTP ${res ? res.status : 0} ${body}`);
  }
  return res.json();
}
