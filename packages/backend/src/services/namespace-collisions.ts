import type { DataSource } from 'typeorm';
import { NamespaceCollision } from '../db/entities/NamespaceCollision.js';
import { getCompiledPolicies, type CompiledPolicy } from './policy-engine.js';
import { canonicalName, firstMatchingPattern } from './namespace-patterns.js';
import { getNamespaceCollisionCheck } from './gateway-config.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { PUBLIC_REMOTES } from './repository-resolve.js';
import { recordEvent } from './events/record.js';

/**
 * Optional, off by default (it sends internal names to public registries): warn when a reserved
 * name that internal remotes served also exists on the ecosystem's public registry, before anyone
 * installs the public one.
 */

export const COLLISION_LOOKBACK_DAYS = 90;
const MAX_NAMES = 1000;
const DEFAULT_DELAY_MS = 200;
const TIMEOUT_MS = 10_000;

export type CollisionCheckOptions = {
  /** Public registry base per ecosystem. Default: the ecosystem's public registry. Tests point it at stubs. */
  publicBase?: (ecosystem: string) => string | undefined;
  fetchImpl?: typeof fetch;
  /** Minimum gap between two lookups to the same public registry host: at most 5 a second by default. */
  delayMs?: number;
  now?: Date;
};

export type CollisionCheckResult = {
  /** `off` when the setting is off: nothing was sent anywhere. */
  skipped: 'off' | null;
  checked: number;
  found: number;
  created: number;
};

const PUBLIC_BASES: Record<string, string> = {
  ...Object.fromEntries(PUBLIC_REMOTES.map((remote) => [remote.ecosystem, remote.url])),
  nuget: 'https://api.nuget.org',
};

type Lookup = { exists: boolean; latest?: string | null };

function last(lines: string[]): string | null {
  return lines.length ? lines[lines.length - 1] : null;
}

/** The public lookup URL and how to read its answer, per ecosystem (§9). */
export function collisionLookup(ecosystem: string, name: string, base: string): { url: string; read: (res: Response) => Promise<Lookup> } | null {
  const root = base.replace(/\/$/, '');
  const json = (pick: (body: unknown) => string | null | undefined) => async (res: Response): Promise<Lookup> => {
    const body = (await res.json().catch(() => null)) as unknown;
    return { exists: true, latest: pick(body) ?? null };
  };
  switch (ecosystem) {
    case 'npm':
      return {
        url: `${root}/${name.startsWith('@') ? name.replace(/\//g, '%2f') : encodeURIComponent(name)}`,
        read: json((b) => (b as { 'dist-tags'?: { latest?: string } })?.['dist-tags']?.latest),
      };
    case 'pypi':
      return { url: `${root}/pypi/${encodeURIComponent(name)}/json`, read: json((b) => (b as { info?: { version?: string } })?.info?.version) };
    case 'go':
      return {
        url: `${root}/${name}/@v/list`,
        read: async (res) => {
          const lines = (await res.text()).split('\n').map((line) => line.trim()).filter(Boolean);
          return { exists: lines.length > 0, latest: last(lines) };
        },
      };
    case 'maven': {
      const [group, artifact] = name.split(':');
      if (!group || !artifact) return null;
      return {
        url: `${root}/${group.replace(/\./g, '/')}/${artifact}/maven-metadata.xml`,
        read: async (res) => {
          const xml = await res.text();
          const latest = xml.match(/<release>\s*([^<]+?)\s*<\/release>/)?.[1] ?? xml.match(/<latest>\s*([^<]+?)\s*<\/latest>/)?.[1];
          return { exists: /<metadata[\s>]/.test(xml), latest: latest ?? null };
        },
      };
    }
    case 'nuget':
      return {
        url: `${root}/v3-flatcontainer/${encodeURIComponent(name.toLowerCase())}/index.json`,
        read: json((b) => last(((b as { versions?: string[] })?.versions ?? []).filter((v) => typeof v === 'string'))),
      };
    case 'cargo':
      return { url: `${root}/api/v1/crates/${encodeURIComponent(name)}`, read: json((b) => (b as { crate?: { max_version?: string } })?.crate?.max_version) };
    case 'composer':
      return {
        url: `${root}/p2/${name}.json`,
        read: json((b) => (b as { packages?: Record<string, Array<{ version?: string }>> })?.packages?.[name]?.[0]?.version),
      };
    case 'rubygems':
      return { url: `${root}/api/v1/gems/${encodeURIComponent(name)}.json`, read: json((b) => (b as { version?: string })?.version) };
    default:
      return null;
  }
}

/** The namespace policies whose reserved namespaces hold the name and that do not exempt it. */
export function reservingPolicies(policies: CompiledPolicy[], ecosystem: string, name: string): CompiledPolicy[] {
  const canonical = canonicalName(ecosystem, name);
  return policies.filter(
    (policy) =>
      policy.namespace?.ecosystem === ecosystem &&
      firstMatchingPattern(ecosystem, policy.namespace.patterns, name) !== null &&
      !policy.namespace.publicPackages.some((matches) => matches(canonical))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCollisionCheck(db: DataSource, options: CollisionCheckOptions = {}): Promise<CollisionCheckResult> {
  const result: CollisionCheckResult = { skipped: null, checked: 0, found: 0, created: 0 };
  if (!(await getNamespaceCollisionCheck(db))) return { ...result, skipped: 'off' };
  const policies = (await getCompiledPolicies(db, { policiesFromDatabase: true })).filter((policy) => policy.namespace);
  if (policies.length === 0) return result;
  const ecosystems = [...new Set(policies.map((policy) => policy.namespace!.ecosystem))];
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - COLLISION_LOOKBACK_DAYS * 86_400_000);
  const rows: { ecosystem: string; package_name: string }[] = await db.query(
    `SELECT DISTINCT ecosystem, package_name FROM package_usage
      WHERE last_seen_at > $1 AND ecosystem = ANY($2::text[]) AND source_type = 'internal'
      LIMIT ${MAX_NAMES}`,
    [since, ecosystems]
  );
  const doFetch = options.fetchImpl ?? fetch;
  const delay = options.delayMs ?? DEFAULT_DELAY_MS;
  const lastLookup = new Map<string, number>();
  const paceHost = async (url: string) => {
    if (!(delay > 0)) return;
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* use the text */
    }
    const wait = (lastLookup.get(host) ?? 0) + delay - Date.now();
    if (wait > 0) await sleep(wait);
    lastLookup.set(host, Date.now());
  };
  const collisions = db.getRepository(NamespaceCollision);

  for (const row of rows) {
    const owners = reservingPolicies(policies, row.ecosystem, row.package_name);
    if (owners.length === 0) continue;
    const base = options.publicBase?.(row.ecosystem) ?? PUBLIC_BASES[row.ecosystem];
    const lookup = base ? collisionLookup(row.ecosystem, row.package_name, base) : null;
    if (!lookup) continue;
    const breaker = getCircuitBreaker(`namespace-collision:${row.ecosystem}`);
    if (!breaker.canExecute()) continue;
    await paceHost(lookup.url);
    result.checked += 1;
    let found: Lookup = { exists: false };
    try {
      const res = await doFetch(lookup.url, {
        headers: { 'User-Agent': 'depgate/0.1 (+https://depgate.local)', Accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200) found = await lookup.read(res);
      else if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      breaker.recordSuccess();
    } catch {
      breaker.recordFailure();
      continue;
    }
    if (!found.exists) continue;
    result.found += 1;
    for (const policy of owners) {
      const existing = await collisions.findOne({ where: { policyId: policy.id, ecosystem: row.ecosystem, name: row.package_name } });
      if (existing) {
        existing.lastCheckedAt = now;
        existing.publicLatestVersion = found.latest ?? existing.publicLatestVersion;
        await collisions.save(existing);
        continue;
      }
      const saved = await collisions.save(
        collisions.create({
          policyId: policy.id,
          ecosystem: row.ecosystem,
          name: row.package_name,
          firstSeenAt: now,
          lastCheckedAt: now,
          publicLatestVersion: found.latest ?? null,
        })
      );
      result.created += 1;
      const reasons = [`Reserved internal name "${row.package_name}" also exists on the public ${row.ecosystem} registry`];
      recordEvent(db, {
        type: 'NAMESPACE_COLLISION_FOUND',
        actor: { kind: 'system', name: 'DepGate' },
        target: { kind: 'package', id: saved?.id ?? null, ecosystem: row.ecosystem, name: row.package_name },
        policy: { id: policy.id, name: policy.name },
        summary: reasons[0],
        reasons,
        details: { publicLatestVersion: found.latest ?? null },
        webhookPayload: {
          event: 'namespace_collision',
          timestamp: now.toISOString(),
          ecosystem: row.ecosystem,
          packageName: row.package_name,
          policyId: policy.id,
          policyName: policy.name,
          publicLatestVersion: found.latest ?? null,
          reasons,
        },
      });
    }
  }
  return result;
}
