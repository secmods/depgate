import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import semver from 'semver';
import { config } from '../config.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { compilePolicy, matchPolicyVersions, type PolicyConditions } from './policy-engine.js';
import { withCvssMin } from './cvss.js';
import type { Job } from 'bullmq';
import { enqueue, registerHandler } from './jobs/queue.js';
import { recheckJobId } from './jobs/ids.js';
import { policyRules } from './policy-rules.js';
import { matchesAnyException } from './exception-service.js';
import { canonicalPackageName } from './package-name.js';
import { compareVersions, isVersionInput, STORED_VERSION_MAX_LENGTH, versionSpecError } from './version-range.js';
import { mapLimit } from './package-facts.js';
import { csvLine } from './csv.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Serializes the retention purge across replicas. Any constant unique to this job. */
const PURGE_LOCK_KEY = 74_201_535;
/** Versions shown inline per package; the rest are in the CSV. */
const VERSIONS_PER_PACKAGE = 100;
const RECHECK_CONCURRENCY = 4;
const RECHECK_CHUNK = 200;
const RECHECK_TTL_SECONDS = 15 * 60;

type Log = { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };

export type PackageStatus = 'will_block' | 'partly' | 'approved';
export type StatusFilter = PackageStatus | 'all';
/** What an approval may cover: any scope, or only listed versions (vulnerability rules). */
export type ApprovalScope = 'any' | 'versions';

export class MonitorError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

function key(ecosystem: string, packageName: string): string {
  return `${ecosystem}\u0000${packageName}`;
}

function splitKey(value: string): [string, string] {
  const at = value.indexOf('\u0000');
  return [value.slice(0, at), value.slice(at + 1)];
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** TypeORM's Postgres driver returns [rows, rowCount] for DELETE/UPDATE. */
function affected(raw: unknown): number {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === 'number') return raw[1];
  return Array.isArray(raw) ? raw.length : 0;
}

/** `7d` → 7, `all` or nothing → null. */
export function parseLastSeenWithin(value: string | undefined): number | null {
  if (!value || value === 'all') return null;
  const match = /^(\d+)d$/.exec(value);
  if (!match) throw new MonitorError(400, 'lastSeenWithin must be 7d, 30d, 90d or all');
  return parseInt(match[1], 10);
}

/** Packages and License rules can approve any scope; Vulnerability only listed versions; age and type never. */
export function approvalScope(conditions: PolicyConditions | undefined): ApprovalScope | null {
  const rule = policyRules(conditions)[0];
  if (rule === 'packages' || rule === 'license') return 'any';
  if (rule === 'vulnerability') return 'versions';
  return null;
}

// --- Approvals (policy-scoped exceptions) ---

type PackageApproval = {
  /** Recorded versions covered by an active exception, with the latest expiry that covers each. */
  approved: Map<string, { expiresAt: Date; hits: number }>;
  total: number;
};

/**
 * Which recorded versions an active exception covers: one for every policy, or one scoped to
 * this policy. Only packages with such an exception are loaded, so the common case is cheap.
 */
export async function loadApprovals(db: DataSource | EntityManager, policyId: string): Promise<Map<string, PackageApproval>> {
  const out = new Map<string, PackageApproval>();
  // Hits keep the name as the client sent it (a recheck fetches with it); exceptions store it canonical.
  const hitNames: { ecosystem: string; package_name: string }[] = await db.query(
    `SELECT DISTINCT ecosystem, package_name FROM monitor_hits WHERE policy_id = $1`,
    [policyId]
  );
  if (hitNames.length === 0) return out;
  const canonicalOf = new Map(
    hitNames.map((row) => [key(row.ecosystem, row.package_name), key(row.ecosystem, canonicalPackageName(row.ecosystem, row.package_name))])
  );
  const canonicalKeys = [...new Set(canonicalOf.values())].map(splitKey);
  const exceptions = await db
    .getRepository(Exception)
    .createQueryBuilder('e')
    .where('e.expiresAt > :now', { now: new Date() })
    .andWhere('(e.policyId IS NULL OR e.policyId = :policyId)', { policyId })
    .andWhere('(e.ecosystem, e.package_name) IN (SELECT * FROM unnest(CAST(:ecosystems AS text[]), CAST(:names AS text[])))', {
      ecosystems: canonicalKeys.map(([eco]) => eco),
      names: canonicalKeys.map(([, name]) => name),
    })
    .getMany();
  if (exceptions.length === 0) return out;
  const byCanonical = new Map<string, Exception[]>();
  for (const row of exceptions) {
    const k = key(row.ecosystem, row.packageName);
    const list = byCanonical.get(k);
    if (list) list.push(row);
    else byCanonical.set(k, [row]);
  }
  const byPackage = new Map<string, Exception[]>();
  for (const [hitKey, canonicalKey] of canonicalOf) {
    const list = byCanonical.get(canonicalKey);
    if (list) byPackage.set(hitKey, list);
  }
  const keys = [...byPackage.keys()].map(splitKey);
  const rows: { ecosystem: string; package_name: string; version: string; hit_count: number }[] = await db.query(
    `SELECT h.ecosystem, h.package_name, h.version, h.hit_count
       FROM monitor_hits h
      WHERE h.policy_id = $1
        AND (h.ecosystem, h.package_name) IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
    [policyId, keys.map(([eco]) => eco), keys.map(([, name]) => name)]
  );
  for (const row of rows) {
    const k = key(row.ecosystem, row.package_name);
    let entry = out.get(k);
    if (!entry) {
      entry = { approved: new Map(), total: 0 };
      out.set(k, entry);
    }
    entry.total += 1;
    let best: Date | null = null;
    for (const exception of byPackage.get(k) ?? []) {
      if (!matchesAnyException([exception], row.version, row.ecosystem)) continue;
      if (!best || exception.expiresAt > best) best = exception.expiresAt;
    }
    if (best) entry.approved.set(row.version, { expiresAt: best, hits: toNumber(row.hit_count) });
  }
  return out;
}

function statusOf(approval: PackageApproval | undefined, total: number): {
  status: PackageStatus;
  approvedVersions: number;
  approvedUntil: string | null;
} {
  const approvedVersions = approval?.approved.size ?? 0;
  if (!approval || approvedVersions === 0) return { status: 'will_block', approvedVersions: 0, approvedUntil: null };
  let until: Date | null = null;
  for (const { expiresAt } of approval.approved.values()) {
    if (!until || expiresAt < until) until = expiresAt;
  }
  return {
    status: approvedVersions >= total ? 'approved' : 'partly',
    approvedVersions,
    approvedUntil: until?.toISOString() ?? null,
  };
}

type ApprovalSummary = {
  approvedPackages: number;
  partlyApprovedPackages: number;
  approvedVersions: number;
  approvedDownloads: number;
  fullyApproved: string[];
  partlyApproved: string[];
};

function summarizeApprovals(approvals: Map<string, PackageApproval>): ApprovalSummary {
  const summary: ApprovalSummary = {
    approvedPackages: 0,
    partlyApprovedPackages: 0,
    approvedVersions: 0,
    approvedDownloads: 0,
    fullyApproved: [],
    partlyApproved: [],
  };
  for (const [k, approval] of approvals) {
    const { status } = statusOf(approval, approval.total);
    if (status === 'approved') {
      summary.approvedPackages += 1;
      summary.fullyApproved.push(k);
    } else if (status === 'partly') {
      summary.partlyApprovedPackages += 1;
      summary.partlyApproved.push(k);
    }
    summary.approvedVersions += approval.approved.size;
    for (const { hits } of approval.approved.values()) summary.approvedDownloads += hits;
  }
  return summary;
}

// --- Recheck state ---

const runningRechecks = new Map<string, string>();

function recheckKey(policyId: string): string {
  return `monitor:recheck:${policyId}`;
}

function recheckProgressKey(policyId: string): string {
  return `monitor:recheck:progress:${policyId}`;
}

function recheckFailedKey(policyId: string): string {
  return `monitor:recheck:failed:${policyId}`;
}

export type RecheckState = { progress: { done: number; total: number } | null; failed: boolean };

/** Progress of a running recheck ("n of m packages") and whether the last one failed for good. */
export async function recheckStates(redis: Redis | null | undefined, policyIds: string[]): Promise<Map<string, RecheckState>> {
  const out = new Map<string, RecheckState>();
  if (!redis || policyIds.length === 0) return out;
  try {
    const progress = await redis.mget(...policyIds.map(recheckProgressKey));
    const failed = await redis.mget(...policyIds.map(recheckFailedKey));
    policyIds.forEach((id, index) => {
      let parsed: RecheckState['progress'];
      try {
        parsed = progress[index] ? (JSON.parse(progress[index]!) as { done: number; total: number }) : null;
      } catch {
        parsed = null;
      }
      out.set(id, { progress: parsed, failed: !!failed[index] });
    });
  } catch {
    /* reported as unknown */
  }
  return out;
}

export async function rechecking(redis: Redis | null | undefined, policyIds: string[]): Promise<Set<string>> {
  const out = new Set(policyIds.filter((id) => runningRechecks.has(id)));
  const rest = policyIds.filter((id) => !out.has(id));
  if (rest.length === 0 || !redis) return out;
  try {
    const values = await redis.mget(...rest.map(recheckKey));
    rest.forEach((id, index) => {
      if (values[index]) out.add(id);
    });
  } catch {
    /* this replica's own rechecks are still reported */
  }
  return out;
}

// --- Policy summaries ---

export type MonitorPolicySummary = {
  id: string;
  name: string;
  description: string | null;
  conditions: Record<string, unknown>;
  isEnabled: boolean;
  priority: number;
  mode: string;
  modeChangedAt: string | null;
  packages: number;
  versions: number;
  downloads: number;
  willBlock: number;
  approved: number;
  partlyApproved: number;
  approvable: boolean;
  approvalScope: ApprovalScope | null;
  lastSeenAt: string | null;
  capped: boolean;
  rowLimit: number;
  rechecking: boolean;
  /** While rechecking: how many recorded packages are done. */
  recheckProgress: { done: number; total: number } | null;
  /** The last recheck failed after its retries; Security can start it again. */
  recheckFailed: boolean;
  retentionDays: number;
};

type PolicyStats = { packages: number; versions: number; downloads: number; lastSeenAt: string | null; firstSeenAt: string | null };

async function policyStats(db: DataSource, policyIds: string[]): Promise<Map<string, PolicyStats>> {
  const out = new Map<string, PolicyStats>();
  if (policyIds.length === 0) return out;
  const rows: Record<string, unknown>[] = await db.query(
    `SELECT policy_id, count(DISTINCT (ecosystem, package_name))::int AS packages, count(*)::int AS versions,
            COALESCE(sum(hit_count), 0)::bigint AS downloads, max(last_seen_at) AS last_seen, min(first_seen_at) AS first_seen
       FROM monitor_hits WHERE policy_id = ANY($1::uuid[]) GROUP BY policy_id`,
    [policyIds]
  );
  for (const row of rows) {
    out.set(String(row.policy_id), {
      packages: toNumber(row.packages),
      versions: toNumber(row.versions),
      downloads: toNumber(row.downloads),
      lastSeenAt: toIso(row.last_seen),
      firstSeenAt: toIso(row.first_seen),
    });
  }
  return out;
}

export async function listMonitorPolicies(
  db: DataSource,
  redis: Redis | null | undefined,
  status: 'monitoring' | 'enforced'
): Promise<MonitorPolicySummary[]> {
  const policies =
    status === 'monitoring'
      ? await db.getRepository(Policy).find({ where: { mode: 'monitor' }, order: { priority: 'ASC', createdAt: 'ASC' } })
      : await db
          .getRepository(Policy)
          .createQueryBuilder('p')
          .where("p.mode = 'enforce'")
          .andWhere('p.modeChangedAt >= :since', {
            since: new Date(Date.now() - config.monitor.enforcedRetentionDays * DAY_MS),
          })
          .andWhere('EXISTS (SELECT 1 FROM monitor_hits h WHERE h.policy_id = p.id)')
          .orderBy('p.modeChangedAt', 'DESC')
          .getMany();
  return summarizePolicies(db, redis, policies);
}

/** One policy's card numbers, monitoring or enforced, for the Monitoring details page. */
export async function monitorPolicySummary(
  db: DataSource,
  redis: Redis | null | undefined,
  policyId: string
): Promise<MonitorPolicySummary> {
  const policy = await getMonitorPolicy(db, policyId);
  if (policy.decision !== 'BLOCK') throw new MonitorError(404, 'Only Block policies have a monitoring report');
  const [summary] = await summarizePolicies(db, redis, [policy]);
  return summary;
}

async function summarizePolicies(
  db: DataSource,
  redis: Redis | null | undefined,
  policies: Policy[]
): Promise<MonitorPolicySummary[]> {
  const ids = policies.map((policy) => policy.id);
  const [stats, busy, states] = await Promise.all([policyStats(db, ids), rechecking(redis, ids), recheckStates(redis, ids)]);
  return Promise.all(
    policies.map(async (policy) => {
      const stat = stats.get(policy.id) ?? { packages: 0, versions: 0, downloads: 0, lastSeenAt: null, firstSeenAt: null };
      const approvals = stat.versions > 0 ? summarizeApprovals(await loadApprovals(db, policy.id)) : null;
      const scope = approvalScope(policy.conditions as PolicyConditions);
      return {
        id: policy.id,
        name: policy.name,
        description: policy.description,
        conditions: withCvssMin((policy.conditions ?? {}) as PolicyConditions),
        isEnabled: policy.isEnabled,
        priority: policy.priority,
        mode: policy.mode,
        modeChangedAt: toIso(policy.modeChangedAt),
        packages: stat.packages,
        versions: stat.versions,
        downloads: stat.downloads,
        willBlock: stat.packages - (approvals?.approvedPackages ?? 0),
        approved: approvals?.approvedPackages ?? 0,
        partlyApproved: approvals?.partlyApprovedPackages ?? 0,
        approvable: scope !== null,
        approvalScope: scope,
        lastSeenAt: stat.lastSeenAt,
        capped: stat.versions >= config.monitor.maxRowsPerPolicy,
        rowLimit: config.monitor.maxRowsPerPolicy,
        rechecking: busy.has(policy.id),
        recheckProgress: busy.has(policy.id) ? (states.get(policy.id)?.progress ?? null) : null,
        recheckFailed: !busy.has(policy.id) && (states.get(policy.id)?.failed ?? false),
        retentionDays: config.monitor.retentionDays,
      };
    })
  );
}

export async function getMonitorPolicy(db: DataSource, policyId: string): Promise<Policy> {
  const policy = await db.getRepository(Policy).findOne({ where: { id: policyId } });
  if (!policy) throw new MonitorError(404, 'Policy not found');
  return policy;
}

// --- Report ---

export type ReasonGroup = {
  reasonKey: string;
  packages: number;
  versions: number;
  downloads: number;
  share: number;
  lastSeenAt: string | null;
  reasons: string[];
};

export async function reasonGroups(db: DataSource, policyId: string, lastSeenDays: number | null): Promise<ReasonGroup[]> {
  const params: unknown[] = [policyId];
  let since = '';
  if (lastSeenDays != null) {
    params.push(new Date(Date.now() - lastSeenDays * DAY_MS));
    since = ` AND last_seen_at >= $${params.length}`;
  }
  const [rows, totals]: [Record<string, unknown>[], Record<string, unknown>[]] = await Promise.all([
    db.query(
      `SELECT reason_key, count(DISTINCT (ecosystem, package_name))::int AS packages, count(*)::int AS versions,
              COALESCE(sum(hit_count), 0)::bigint AS downloads, max(last_seen_at) AS last_seen,
              (array_agg(reasons ORDER BY hit_count DESC))[1] AS reasons
         FROM monitor_hits WHERE policy_id = $1${since}
        GROUP BY reason_key
        ORDER BY packages DESC, downloads DESC, reason_key`,
      params
    ),
    db.query(
      `SELECT count(DISTINCT (ecosystem, package_name))::int AS packages FROM monitor_hits WHERE policy_id = $1${since}`,
      params
    ),
  ]);
  const total = toNumber(totals[0]?.packages);
  return rows.map((row) => ({
    reasonKey: String(row.reason_key),
    packages: toNumber(row.packages),
    versions: toNumber(row.versions),
    downloads: toNumber(row.downloads),
    share: total > 0 ? toNumber(row.packages) / total : 0,
    lastSeenAt: toIso(row.last_seen),
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
  }));
}

export type PackageFilters = {
  policyId: string;
  reasonKey?: string;
  ecosystem?: string;
  status: StatusFilter;
  lastSeenDays: number | null;
  search?: string;
  /** Repository key downloads were seen on, e.g. `prod`. */
  repository?: string;
};

type Where = { sql: string; params: unknown[] };

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Row filters plus the package-level status filter, as SQL over monitor_hits h. */
function buildWhere(filters: PackageFilters, approvals: ApprovalSummary): Where {
  const params: unknown[] = [filters.policyId];
  const clauses = ['h.policy_id = $1'];
  if (filters.reasonKey) {
    params.push(filters.reasonKey);
    clauses.push(`h.reason_key = $${params.length}`);
  }
  if (filters.ecosystem) {
    params.push(filters.ecosystem);
    clauses.push(`h.ecosystem = $${params.length}`);
  }
  if (filters.lastSeenDays != null) {
    params.push(new Date(Date.now() - filters.lastSeenDays * DAY_MS));
    clauses.push(`h.last_seen_at >= $${params.length}`);
  }
  if (filters.search?.trim()) {
    params.push(`%${escapeLike(filters.search.trim())}%`);
    clauses.push(`h.package_name ILIKE $${params.length}`);
  }
  if (filters.repository?.trim()) {
    params.push(JSON.stringify([filters.repository.trim()]));
    clauses.push(`h.repositories @> $${params.length}::jsonb`);
  }
  const inKeys = (keys: string[], negate: boolean) => {
    const pairs = keys.map(splitKey);
    params.push(pairs.map(([eco]) => eco), pairs.map(([, name]) => name));
    const list = `(SELECT * FROM unnest($${params.length - 1}::text[], $${params.length}::text[]))`;
    clauses.push(`(h.ecosystem, h.package_name) ${negate ? 'NOT IN' : 'IN'} ${list}`);
  };
  // "Will be blocked" is every package with a version nobody approved, partly approved ones included.
  if (filters.status === 'will_block' && approvals.fullyApproved.length > 0) inKeys(approvals.fullyApproved, true);
  if (filters.status === 'approved') inKeys(approvals.fullyApproved, false);
  if (filters.status === 'partly') inKeys(approvals.partlyApproved, false);
  return { sql: clauses.join(' AND '), params };
}

export type MonitorVersion = {
  version: string;
  reasonKey: string;
  reasons: string[];
  downloads: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  approved: boolean;
  approvedUntil: string | null;
  /** Repository keys downloads of this version were seen on. */
  repositories: string[];
};

export type MonitorPackage = {
  ecosystem: string;
  packageName: string;
  versionCount: number;
  versionRange: { min: string; max: string } | null;
  reasonKey: string;
  reasonKeys: string[];
  reasons: string[];
  downloads: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  status: PackageStatus;
  approvedVersions: number;
  totalVersions: number;
  approvedUntil: string | null;
  alsoMatchedBy: Array<{ policyId: string; policyName: string }>;
  /** Repository keys any download of the package was seen on. */
  repositories: string[];
  versions: MonitorVersion[];
};

function repositoryList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sortVersionsDesc(ecosystem: string, versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const cmp = compareVersions(ecosystem, b, a);
    return cmp ?? b.localeCompare(a, undefined, { numeric: true });
  });
}

export async function listPackages(
  db: DataSource,
  filters: PackageFilters,
  page: { sort: 'downloads' | 'last_seen'; limit: number; offset: number }
): Promise<{ items: MonitorPackage[]; total: number }> {
  const approvals = await loadApprovals(db, filters.policyId);
  const summary = summarizeApprovals(approvals);
  if ((filters.status === 'approved' && summary.fullyApproved.length === 0) || (filters.status === 'partly' && summary.partlyApproved.length === 0)) {
    return { items: [], total: 0 };
  }
  const where = buildWhere(filters, summary);
  const order =
    page.sort === 'last_seen'
      ? '"lastSeenAt" DESC, downloads DESC, h.ecosystem, h.package_name'
      : 'downloads DESC, "lastSeenAt" DESC, h.ecosystem, h.package_name';
  const limitAt = where.params.length + 1;
  const [rows, counted]: [Record<string, unknown>[], Record<string, unknown>[]] = await Promise.all([
    db.query(
      `SELECT h.ecosystem, h.package_name, count(*)::int AS versions, COALESCE(sum(h.hit_count), 0)::bigint AS downloads,
              max(h.last_seen_at) AS "lastSeenAt", min(h.first_seen_at) AS first_seen,
              mode() WITHIN GROUP (ORDER BY h.reason_key) AS reason_key
         FROM monitor_hits h WHERE ${where.sql}
        GROUP BY h.ecosystem, h.package_name
        ORDER BY ${order}
        LIMIT $${limitAt} OFFSET $${limitAt + 1}`,
      [...where.params, page.limit, page.offset]
    ),
    db.query(
      `SELECT count(*)::int AS total FROM (SELECT 1 FROM monitor_hits h WHERE ${where.sql} GROUP BY h.ecosystem, h.package_name) t`,
      where.params
    ),
  ]);
  const total = toNumber(counted[0]?.total);
  if (rows.length === 0) return { items: [], total };

  const pageKeys = rows.map((row) => [String(row.ecosystem), String(row.package_name)] as [string, string]);
  const versionWhere = buildWhere({ ...filters, status: 'all' }, summary);
  const at = versionWhere.params.length;
  const [versionRows, others, totals]: [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]] =
    await Promise.all([
      db.query(
        `SELECT h.ecosystem, h.package_name, h.version, h.reason_key, h.reasons, h.hit_count, h.first_seen_at, h.last_seen_at,
                h.repositories
           FROM monitor_hits h
          WHERE ${versionWhere.sql}
            AND (h.ecosystem, h.package_name) IN (SELECT * FROM unnest($${at + 1}::text[], $${at + 2}::text[]))`,
        [...versionWhere.params, pageKeys.map(([eco]) => eco), pageKeys.map(([, name]) => name)]
      ),
      db.query(
        `SELECT DISTINCT h.ecosystem, h.package_name, p.id AS policy_id, p.name AS policy_name
           FROM monitor_hits h JOIN policies p ON p.id = h.policy_id
          WHERE p.mode = 'monitor' AND h.policy_id <> $1
            AND (h.ecosystem, h.package_name) IN (SELECT * FROM unnest($2::text[], $3::text[]))
          ORDER BY p.name`,
        [filters.policyId, pageKeys.map(([eco]) => eco), pageKeys.map(([, name]) => name)]
      ),
      // Status counts every recorded version of the package, whatever the filters show.
      db.query(
        `SELECT h.ecosystem, h.package_name, count(*)::int AS total FROM monitor_hits h
          WHERE h.policy_id = $1 AND (h.ecosystem, h.package_name) IN (SELECT * FROM unnest($2::text[], $3::text[]))
          GROUP BY h.ecosystem, h.package_name`,
        [filters.policyId, pageKeys.map(([eco]) => eco), pageKeys.map(([, name]) => name)]
      ),
    ]);

  const versionsByPackage = new Map<string, Record<string, unknown>[]>();
  for (const row of versionRows) {
    const k = key(String(row.ecosystem), String(row.package_name));
    const list = versionsByPackage.get(k);
    if (list) list.push(row);
    else versionsByPackage.set(k, [row]);
  }
  const alsoBy = new Map<string, Array<{ policyId: string; policyName: string }>>();
  for (const row of others) {
    const k = key(String(row.ecosystem), String(row.package_name));
    const list = alsoBy.get(k) ?? [];
    list.push({ policyId: String(row.policy_id), policyName: String(row.policy_name) });
    alsoBy.set(k, list);
  }
  const totalVersions = new Map(totals.map((row) => [key(String(row.ecosystem), String(row.package_name)), toNumber(row.total)]));

  const items = rows.map((row): MonitorPackage => {
    const ecosystem = String(row.ecosystem);
    const packageName = String(row.package_name);
    const k = key(ecosystem, packageName);
    const approval = approvals.get(k);
    const all = totalVersions.get(k) ?? toNumber(row.versions);
    const status = statusOf(approval, all);
    const raw = versionsByPackage.get(k) ?? [];
    const byVersion = new Map(raw.map((v) => [String(v.version), v]));
    const ordered = sortVersionsDesc(ecosystem, [...byVersion.keys()]);
    const reasonKey = String(row.reason_key);
    const sample = raw
      .filter((v) => String(v.reason_key) === reasonKey)
      .sort((a, b) => toNumber(b.hit_count) - toNumber(a.hit_count))[0];
    return {
      ecosystem,
      packageName,
      versionCount: toNumber(row.versions),
      versionRange: ordered.length ? { min: ordered[ordered.length - 1], max: ordered[0] } : null,
      reasonKey,
      reasonKeys: [...new Set(raw.map((v) => String(v.reason_key)))].sort(),
      reasons: Array.isArray(sample?.reasons) ? (sample.reasons as string[]) : [],
      downloads: toNumber(row.downloads),
      firstSeenAt: toIso(row.first_seen),
      lastSeenAt: toIso(row.lastSeenAt),
      status: status.status,
      approvedVersions: status.approvedVersions,
      totalVersions: all,
      approvedUntil: status.approvedUntil,
      alsoMatchedBy: alsoBy.get(k) ?? [],
      repositories: [...new Set(raw.flatMap((v) => repositoryList(v.repositories)))].sort(),
      versions: ordered.slice(0, VERSIONS_PER_PACKAGE).map((version) => {
        const v = byVersion.get(version)!;
        const approved = approval?.approved.get(version);
        return {
          version,
          reasonKey: String(v.reason_key),
          reasons: Array.isArray(v.reasons) ? (v.reasons as string[]) : [],
          downloads: toNumber(v.hit_count),
          firstSeenAt: toIso(v.first_seen_at),
          lastSeenAt: toIso(v.last_seen_at),
          approved: !!approved,
          approvedUntil: approved?.expiresAt.toISOString() ?? null,
          repositories: repositoryList(v.repositories),
        };
      }),
    };
  });
  return { items, total };
}

// --- Enforce dialog ---

export type MonitorImpact = {
  policyId: string;
  policyName: string;
  mode: string;
  monitoringSince: string | null;
  daysMonitored: number;
  retentionDays: number;
  packages: number;
  versions: number;
  packagesToBlock: number;
  versionsToBlock: number;
  downloadsToBlock: number;
  downloadsPerDay: number;
  approvedPackages: number;
  partlyApprovedPackages: number;
  approvedVersions: number;
  topReasons: ReasonGroup[];
  lastSeenAt: string | null;
};

export async function monitorImpact(db: DataSource, policy: Policy): Promise<MonitorImpact> {
  const [stats, approvals, groups] = await Promise.all([
    policyStats(db, [policy.id]),
    loadApprovals(db, policy.id),
    reasonGroups(db, policy.id, null),
  ]);
  const stat = stats.get(policy.id) ?? { packages: 0, versions: 0, downloads: 0, lastSeenAt: null, firstSeenAt: null };
  const summary = summarizeApprovals(approvals);
  const now = Date.now();
  const since = policy.modeChangedAt ? new Date(policy.modeChangedAt).getTime() : stat.firstSeenAt ? Date.parse(stat.firstSeenAt) : now;
  // Counts cover the retention window at most, so a long-running policy is not averaged over days already purged.
  const retention = config.monitor.retentionDays;
  const windowStart = retention > 0 ? Math.max(since, now - retention * DAY_MS) : since;
  const days = Math.max(1, (now - windowStart) / DAY_MS);
  const downloadsToBlock = Math.max(stat.downloads - summary.approvedDownloads, 0);
  return {
    policyId: policy.id,
    policyName: policy.name,
    mode: policy.mode,
    monitoringSince: toIso(policy.modeChangedAt),
    daysMonitored: Math.max(0, Math.floor((now - since) / DAY_MS)),
    retentionDays: retention,
    packages: stat.packages,
    versions: stat.versions,
    packagesToBlock: stat.packages - summary.approvedPackages,
    versionsToBlock: stat.versions - summary.approvedVersions,
    downloadsToBlock,
    downloadsPerDay: Math.round((downloadsToBlock / days) * 10) / 10,
    approvedPackages: summary.approvedPackages,
    partlyApprovedPackages: summary.partlyApprovedPackages,
    approvedVersions: summary.approvedVersions,
    topReasons: groups.slice(0, 3),
    lastSeenAt: stat.lastSeenAt,
  };
}

// --- CSV export ---

const CSV_BATCH = 2000;

/** Every row matching the filters, streamed in keyset batches so 50,000 rows never sit in memory. */
export async function* monitorCsv(
  db: DataSource,
  filters: PackageFilters,
  granularity: 'package' | 'version'
): AsyncGenerator<string> {
  const approvals = await loadApprovals(db, filters.policyId);
  const summary = summarizeApprovals(approvals);
  const empty =
    (filters.status === 'approved' && summary.fullyApproved.length === 0) ||
    (filters.status === 'partly' && summary.partlyApproved.length === 0);
  const where = buildWhere(filters, summary);
  if (granularity === 'version') {
    yield csvLine(['Ecosystem', 'Package', 'Version', 'Reason', 'Reasons', 'Downloads', 'First seen', 'Last downloaded', 'Approved', 'Approved until']);
    if (empty) return;
    let after: [string, string, string] = ['', '', ''];
    for (;;) {
      const at = where.params.length;
      const rows: Record<string, unknown>[] = await db.query(
        `SELECT h.ecosystem, h.package_name, h.version, h.reason_key, h.reasons, h.hit_count, h.first_seen_at, h.last_seen_at
           FROM monitor_hits h WHERE ${where.sql}
            AND (h.ecosystem, h.package_name, h.version) > ($${at + 1}, $${at + 2}, $${at + 3})
          ORDER BY h.ecosystem, h.package_name, h.version
          LIMIT ${CSV_BATCH}`,
        [...where.params, ...after]
      );
      let chunk = '';
      for (const row of rows) {
        const approved = approvals.get(key(String(row.ecosystem), String(row.package_name)))?.approved.get(String(row.version));
        chunk += csvLine([
          String(row.ecosystem),
          String(row.package_name),
          String(row.version),
          String(row.reason_key),
          Array.isArray(row.reasons) ? (row.reasons as string[]).join('; ') : '',
          toNumber(row.hit_count),
          toIso(row.first_seen_at),
          toIso(row.last_seen_at),
          approved ? 'yes' : 'no',
          approved?.expiresAt.toISOString() ?? '',
        ]);
      }
      if (chunk) yield chunk;
      if (rows.length < CSV_BATCH) return;
      const last = rows[rows.length - 1];
      after = [String(last.ecosystem), String(last.package_name), String(last.version)];
    }
  }

  yield csvLine([
    'Ecosystem',
    'Package',
    'Versions',
    'Lowest version',
    'Highest version',
    'Reason',
    'Downloads',
    'First seen',
    'Last downloaded',
    'Status',
    'Approved versions',
    'Approved until',
  ]);
  if (empty) return;
  let after: [string, string] = ['', ''];
  for (;;) {
    const at = where.params.length;
    const rows: Record<string, unknown>[] = await db.query(
      `SELECT h.ecosystem, h.package_name, count(*)::int AS versions, array_agg(h.version) AS version_list,
              COALESCE(sum(h.hit_count), 0)::bigint AS downloads, min(h.first_seen_at) AS first_seen, max(h.last_seen_at) AS last_seen,
              mode() WITHIN GROUP (ORDER BY h.reason_key) AS reason_key
         FROM monitor_hits h WHERE ${where.sql}
          AND (h.ecosystem, h.package_name) > ($${at + 1}, $${at + 2})
        GROUP BY h.ecosystem, h.package_name
        ORDER BY h.ecosystem, h.package_name
        LIMIT ${CSV_BATCH}`,
      [...where.params, ...after]
    );
    let chunk = '';
    for (const row of rows) {
      const ecosystem = String(row.ecosystem);
      const approval = approvals.get(key(ecosystem, String(row.package_name)));
      const status = statusOf(approval, approval?.total ?? toNumber(row.versions));
      const ordered = sortVersionsDesc(ecosystem, (row.version_list as string[]) ?? []);
      chunk += csvLine([
        ecosystem,
        String(row.package_name),
        toNumber(row.versions),
        ordered[ordered.length - 1] ?? '',
        ordered[0] ?? '',
        String(row.reason_key),
        toNumber(row.downloads),
        toIso(row.first_seen),
        toIso(row.last_seen),
        status.status === 'will_block' ? 'Will be blocked' : status.status === 'partly' ? 'Partly approved' : 'Approved',
        status.approvedVersions,
        status.approvedUntil ?? '',
      ]);
    }
    if (chunk) yield chunk;
    if (rows.length < CSV_BATCH) return;
    const last = rows[rows.length - 1];
    after = [String(last.ecosystem), String(last.package_name)];
  }
}

// --- Approve ---

export type ApproveItem = { ecosystem: string; packageName: string; versions: string[] };

const RANGE_LIKE = /^(>=|<=|>|<|=)|\s-\s|\|\|/;
const SEMVER_ECOSYSTEMS = new Set(['npm', 'go', 'cargo']);

/**
 * A vulnerability approval names one release. npm, Go, and Cargo treat `1`, `1.2`, and `1.2.x`
 * as ranges, so those ecosystems require a full version such as `1.2.5`.
 */
function isExactApprovalVersion(value: string, ecosystem: string | undefined): boolean {
  const eco = (ecosystem ?? '').trim().toLowerCase();
  if (!eco || SEMVER_ECOSYSTEMS.has(eco)) return semver.valid(value) != null;
  return isVersionInput(value, [eco]);
}

/** One scoped exception's version text from what the dialog sent: `*`, a range, or `=a || =b`. */
export function approvalSpec(versions: string[], scope: ApprovalScope, ecosystem?: string): string {
  const list = [...new Set(versions.map((v) => v.trim()).filter(Boolean))];
  if (list.length === 0) throw new MonitorError(400, 'Choose at least one version to approve');
  if (list.includes('*')) {
    if (scope === 'versions') {
      throw new MonitorError(400, 'A vulnerability approval lists versions. All versions cannot be approved, so a future vulnerable release is not let through');
    }
    return '*';
  }
  if (scope === 'versions' && list.some((v) => RANGE_LIKE.test(v) || !isExactApprovalVersion(v, ecosystem))) {
    throw new MonitorError(400, 'A vulnerability approval lists versions, not a range');
  }
  return list.map((v) => (RANGE_LIKE.test(v) ? v : `=${v}`)).join(' || ');
}

/** Approving again adds to what the record already covers. */
export function widenSpec(existing: string, added: string): string {
  if (existing.trim() === '*' || added.trim() === '*') return '*';
  const parts: string[] = [];
  for (const part of [...existing.split('||'), ...added.split('||')]) {
    const clause = part.trim();
    if (clause && !parts.includes(clause)) parts.push(clause);
  }
  return parts.join(' || ');
}

export type ApprovalAudit = { action: 'EXCEPTION_ADDED' | 'EXCEPTION_UPDATED'; exception: Exception };

export async function approvePackages(
  db: DataSource,
  policy: Policy,
  input: { items: ApproveItem[]; expiresAt: Date; reason: string; approvedBy: string }
): Promise<ApprovalAudit[]> {
  if (policy.decision !== 'BLOCK') throw new MonitorError(400, 'Only Block policies have approvals');
  const scope = approvalScope(policy.conditions as PolicyConditions);
  if (!scope) {
    throw new MonitorError(400, 'Release age and release type policies cannot approve packages. Edit the rule, or use a waiver');
  }
  if (!input.reason.trim()) throw new MonitorError(400, 'A reason is required');
  if (!(input.expiresAt.getTime() > Date.now())) throw new MonitorError(400, 'expiresAt must be a future date');
  if (input.items.length === 0) throw new MonitorError(400, 'Choose at least one package');

  return db.transaction(async (manager) => {
    const repo = manager.getRepository(Exception);
    const audits: ApprovalAudit[] = [];
    for (const item of input.items) {
      const spec = approvalSpec(item.versions, scope, item.ecosystem);
      const existing = await repo.findOne({
        where: { policyId: policy.id, ecosystem: item.ecosystem, packageName: canonicalPackageName(item.ecosystem, item.packageName) },
        order: { createdAt: 'ASC' },
      });
      const active = existing && existing.expiresAt.getTime() > Date.now();
      const version = active ? widenSpec(existing.version, spec) : spec;
      if (version.length > STORED_VERSION_MAX_LENGTH) {
        throw new MonitorError(
          400,
          `${item.packageName}: the approved versions need ${version.length} characters, more than ${STORED_VERSION_MAX_LENGTH}. Approve a range from the lowest to the highest version${scope === 'any' ? ', or all versions' : ''}`
        );
      }
      const problem = versionSpecError(version, [item.ecosystem], STORED_VERSION_MAX_LENGTH);
      if (problem) throw new MonitorError(400, `${item.packageName}: ${problem}`);
      const row = existing ?? repo.create({ policyId: policy.id, ecosystem: item.ecosystem, packageName: item.packageName });
      row.version = version;
      // Widening never shortens an approval that already runs longer.
      row.expiresAt = active && existing.expiresAt > input.expiresAt ? existing.expiresAt : input.expiresAt;
      row.reason = input.reason.trim();
      row.approvedBy = input.approvedBy;
      const saved = await repo.save(row);
      audits.push({ action: existing ? 'EXCEPTION_UPDATED' : 'EXCEPTION_ADDED', exception: saved });
    }
    return audits;
  });
}

// --- Restart, mode changes, recheck ---

export async function clearMonitorHits(db: DataSource | EntityManager, policyId: string): Promise<number> {
  return affected(await db.query('DELETE FROM monitor_hits WHERE policy_id = $1', [policyId]));
}

/** Deletes the policy's rows and resets "Monitoring since". Approvals are kept. */
export async function restartMonitoring(db: DataSource, policy: Policy): Promise<number> {
  if (policy.mode !== 'monitor') throw new MonitorError(400, 'Only a policy in monitor mode can restart monitoring');
  stopRecheck(policy.id);
  return db.transaction(async (manager) => {
    const cleared = await clearMonitorHits(manager, policy.id);
    policy.modeChangedAt = new Date();
    // save() bumps the policy cache, so new downloads use fresh Redis counters.
    await manager.getRepository(Policy).save(policy);
    return cleared;
  });
}

export function stopRecheck(policyId: string): void {
  runningRechecks.delete(policyId);
}

/**
 * After a monitoring policy's rule changed, keep only the recorded versions the new rule still
 * matches. Runs in the background with cached facts and limited concurrency; a version whose
 * facts cannot be read is kept. A newer save cancels an older recheck of the same policy.
 */
export async function startRecheck(app: { db: DataSource; redis?: Redis | null; log?: Log }, policy: Policy): Promise<void> {
  const token = randomUUID();
  const redis = app.redis ?? null;
  if (redis) {
    // The flag names the newest recheck; an older one, queued or running anywhere, sees it change and stops.
    const flagged = await redis
      .multi()
      .set(recheckKey(policy.id), token, 'EX', RECHECK_TTL_SECONDS)
      .del(recheckFailedKey(policy.id), recheckProgressKey(policy.id))
      .exec()
      .then(() => true)
      .catch(() => false);
    if (flagged) {
      const queued = await enqueue(
        'monitor',
        'recheck',
        { policyId: policy.id, token, signature: ruleSignature(policy.conditions), modeEpoch: policyModeEpoch(policy) },
        { jobId: recheckJobId(policy.id, token) }
      );
      if (queued) return;
    }
  }
  // The queue is unavailable: recheck in this process, as before.
  runningRechecks.set(policy.id, token);
  const current = () => runningRechecks.get(policy.id) === token;
  const job = Promise.resolve()
    .then(() => runRecheck(app.db, redis, policy, current))
    .catch((err) => app.log?.warn({ err, policyId: policy.id }, 'Monitor recheck failed'))
    .finally(async () => {
      if (!current()) return;
      runningRechecks.delete(policy.id);
      if (!redis) return;
      try {
        if ((await redis.get(recheckKey(policy.id))) === token) await redis.del(recheckKey(policy.id));
      } catch {
        /* the flag expires on its own */
      }
    });
  return job;
}

function policyModeEpoch(policy: Policy): number {
  return policy.modeChangedAt ? new Date(policy.modeChangedAt).getTime() : 0;
}

/** The worker for `monitor/recheck`. It stops when a newer rule change, a mode change or a restart replaced it. */
export function registerMonitorJobs(app: { db: DataSource; redis: Redis | null }): void {
  registerHandler('monitor', 'recheck', async (job: Job) => {
    const { policyId, token, signature, modeEpoch } = job.data as {
      policyId: string;
      token: string;
      signature: string;
      modeEpoch: number;
    };
    const redis = app.redis;
    const stillCurrent = async (): Promise<boolean> => {
      if (redis && (await redis.get(recheckKey(policyId)).catch(() => token)) !== token) return false;
      const policy = await app.db.getRepository(Policy).findOne({ where: { id: policyId } });
      return !!policy && policy.mode === 'monitor' && ruleSignature(policy.conditions) === signature && policyModeEpoch(policy) === modeEpoch;
    };
    const policy = await app.db.getRepository(Policy).findOne({ where: { id: policyId } });
    if (!policy || !(await stillCurrent())) return { skipped: 'Replaced by a newer change' };
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      await runRecheck(app.db, redis, policy, stillCurrent, async (done, total) => {
        await job.updateProgress({ done, total }).catch(() => undefined);
        await redis?.set(recheckProgressKey(policyId), JSON.stringify({ done, total }), 'EX', RECHECK_TTL_SECONDS).catch(() => undefined);
      });
    } catch (err) {
      if (final) await redis?.set(recheckFailedKey(policyId), '1', 'EX', 7 * 86_400).catch(() => undefined);
      throw err;
    }
    if (redis && (await redis.get(recheckKey(policyId)).catch(() => null)) === token) {
      await redis.del(recheckKey(policyId), recheckProgressKey(policyId)).catch(() => undefined);
    }
    return { rechecked: true };
  });
}

async function runRecheck(
  db: DataSource,
  redis: Redis | null,
  policy: Policy,
  current: () => boolean | Promise<boolean>,
  progress?: (done: number, total: number) => Promise<void>
): Promise<void> {
  const compiled = compilePolicy(policy);
  if (compiled.ecosystems) {
    await db.query('DELETE FROM monitor_hits WHERE policy_id = $1 AND NOT (ecosystem = ANY($2::text[]))', [
      policy.id,
      [...compiled.ecosystems],
    ]);
  }
  const groups: { ecosystem: string; package_name: string; versions: string[] }[] = await db.query(
    `SELECT ecosystem, package_name, array_agg(version) AS versions FROM monitor_hits WHERE policy_id = $1 GROUP BY ecosystem, package_name`,
    [policy.id]
  );
  let done = 0;
  await progress?.(0, groups.length);
  await mapLimit(groups, RECHECK_CONCURRENCY, async (group) => {
    for (let start = 0; start < group.versions.length; start += RECHECK_CHUNK) {
      if (!(await current())) return;
      const chunk = group.versions.slice(start, start + RECHECK_CHUNK);
      const matches = await matchPolicyVersions(db, redis, compiled, group.ecosystem, group.package_name, chunk);
      if (!(await current())) return;
      const gone: string[] = [];
      const kept: { version: string; reasonKey: string; reasons: string }[] = [];
      for (const version of chunk) {
        const outcome = matches.get(version);
        if (!outcome || outcome.match === 'unknown') continue;
        if (outcome.match === false) gone.push(version);
        else kept.push({ version, reasonKey: outcome.reasonKey.slice(0, 512), reasons: JSON.stringify(outcome.reasons) });
      }
      if (gone.length > 0) {
        await db.query(
          'DELETE FROM monitor_hits WHERE policy_id = $1 AND ecosystem = $2 AND package_name = $3 AND version = ANY($4::text[])',
          [policy.id, group.ecosystem, group.package_name, gone]
        );
      }
      if (kept.length > 0) {
        await db.query(
          `UPDATE monitor_hits h SET reason_key = u.reason_key, reasons = u.reasons::jsonb
             FROM unnest($4::text[], $5::text[], $6::text[]) AS u(version, reason_key, reasons)
            WHERE h.policy_id = $1 AND h.ecosystem = $2 AND h.package_name = $3 AND h.version = u.version`,
          [
            policy.id,
            group.ecosystem,
            group.package_name,
            kept.map((k) => k.version),
            kept.map((k) => k.reasonKey),
            kept.map((k) => k.reasons),
          ]
        );
      }
    }
    done += 1;
    await progress?.(done, groups.length);
  });
}

/** The fields whose change makes recorded rows stale. Name, description and priority do not. */
export function ruleSignature(conditions: Record<string, unknown> | null | undefined): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== '')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, sorted(v)])
      );
    }
    return value;
  };
  return JSON.stringify(sorted(conditions ?? {}));
}

// --- Retention ---

export type PurgeResult = { expired: number; enforced: number };

/**
 * Drops rows nobody downloaded within MONITOR_RETENTION_DAYS (0 keeps them) and the read-only
 * rows of policies enforced more than 30 days ago. Advisory-locked: when another replica is
 * purging, this returns null without waiting.
 */
export async function purgeMonitorHits(
  db: DataSource,
  options: { retentionDays?: number; enforcedRetentionDays?: number } = {}
): Promise<PurgeResult | null> {
  const retentionDays = options.retentionDays ?? config.monitor.retentionDays;
  const enforcedDays = options.enforcedRetentionDays ?? config.monitor.enforcedRetentionDays;
  return db.transaction(async (manager) => {
    const locked: { locked: boolean }[] = await manager.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [PURGE_LOCK_KEY]);
    if (!locked[0]?.locked) return null;
    const enforced = affected(
      await manager.query(
        `DELETE FROM monitor_hits h USING policies p
          WHERE p.id = h.policy_id AND p.mode = 'enforce'
            AND (p.mode_changed_at IS NULL OR p.mode_changed_at < now() - make_interval(days => $1))`,
        [enforcedDays]
      )
    );
    const expired =
      retentionDays > 0
        ? affected(
            await manager.query('DELETE FROM monitor_hits WHERE last_seen_at < now() - make_interval(days => $1)', [
              retentionDays,
            ])
          )
        : 0;
    return { expired, enforced };
  });
}
