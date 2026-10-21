import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { Exception } from '../db/entities/Exception.js';
import { findMaliciousEntry } from './malicious-sync.js';
import { canonicalPackageName } from './package-name.js';
import { WaiverRequest } from '../db/entities/WaiverRequest.js';
import {
  evaluatePackageVersionsDetailed,
  getCompiledPolicies,
  type CompiledPolicy,
  type MonitorMatch,
  type PolicyResult,
  type VersionDetail,
} from './policy-engine.js';
import { loadVersionFacts, type VersionFacts } from './package-facts.js';
import { matchesAnyException } from './exception-service.js';
import { classifyRelease, type ReleaseType } from './release-type.js';
import { displayVulnId } from './osv-provider.js';
import { cvssSeverity, vulnCvss, type CvssVersion } from './cvss.js';
import { repositoryIdFor, type RemoteTarget } from './repository-resolve.js';
import {
  namespaceNotFoundResult,
  remoteLabel,
  resolvePackageTargets,
  type PackageRoute,
} from './namespace-protection.js';
import { exceptionCovers, refsFor, repositoryRefMap, scopeContext, scopeIds } from './repository-scope.js';
import { versionInRange } from './version-range.js';
import { formatLicense, parseLicense } from './license-expression.js';
import { npmDeclaredLicense, npmPackumentSource, type PackumentVersion } from './npm-packument.js';
import { listPackageVersions, selectWindow, type ListedVersion, type PackageVersionList } from './package-versions.js';
import { npmRepositorySeed, scorecardView, type ScorecardView } from './scorecard.js';
import type { ScorecardLookup } from './scorecard-rule.js';
import { lookupEpss } from './epss.js';
import { vulnCves } from './epss-rule.js';

export type CheckStatus =
  | 'allowed'
  | 'blocked'
  /** The check ran out of time before this version was decided. */
  | 'unknown';

export type IncompleteReason = 'cve' | 'license' | 'published' | 'scorecard' | 'timeout';

/** The OpenSSF Scorecard of one version (the one asked about, else the default), as the Scorecard rule reads it. */
export type ProjectHealth = ScorecardView & { version: string };

export type CheckedVersion = {
  version: string;
  /** Index in the newest-first list. Rows below `offset + limit` were added only because they were asked for. */
  position: number;
  status: CheckStatus;
  policyName?: string;
  reasons: string[];
  releaseType: ReleaseType;
  publishedAt?: string;
  /**
   * `severity` is the rating of the CVSS score (or the advisory's label). `cvss.version` is null when the
   * score stands in for that label. `epss` is the highest EPSS among the CVE ids; null when none has a score.
   */
  vulnerabilities?: Array<{
    id: string;
    severity: string;
    cvss: { score: number; version: CvssVersion | null } | null;
    cves: string[];
    epss: { score: number; percentile: number } | null;
  }>;
  exception?: { expiresAt: string };
  allowedAfter?: string;
  incomplete?: IncompleteReason[];
  /** The user asked for this version. */
  requested?: boolean;
  /** The version a plain install picks. */
  isDefault?: boolean;
  /** The signed-in user already has a pending waiver request covering it. */
  waiverPending?: boolean;
  /** Blocked by the malicious packages list: no waiver, only a Security override. */
  malicious?: boolean;
  /** Repositories the deciding policy is limited to, e.g. `npm/prod`. Absent when it applies to every repository. */
  policyScope?: string[];
  /** Allowed now, but a policy in monitor mode would block it once enforced. */
  monitoring?: Array<{ policyId: string; policyName: string; reasons: string[] }>;
  /**
   * Requested versions only: the license as the license policies read it, e.g. `MIT OR Apache-2.0`.
   * null when the package declares none; absent when it was not loaded.
   */
  license?: string | null;
};

export type PackageNotice = { kind: 'malware' | 'policy' | 'namespace'; message: string; policyName?: string };

/** The internal namespace rule's view of the package on the checked repository. */
export type NamespaceInfo = {
  reserved: true;
  mode: 'enforce' | 'monitor';
  policyId: string;
  policy: string;
  pattern: string;
  /** Remotes that serve the name, e.g. `npm/acme-artifactory`. Monitor mode: the internal ones among them. */
  internalRemotes: string[];
  /** Public remotes of the repository that are not consulted for the name (enforce mode only). */
  publicRemotesSkipped: string[];
  /** blocked: no internal remote; notFound: no internal remote has it; internal: served from internal remotes. */
  outcome: 'internal' | 'blocked' | 'notFound' | 'monitor';
};

export type PackageCheckResult = {
  ecosystem: string;
  package: string;
  repository: string;
  checkedAt: string;
  checkedAgainst: string[];
  /** Remotes the repository searches, in order, e.g. `npm/acme-private` (R2). */
  searchOrder: string[];
  /** The remote that served the package's metadata, when known, e.g. `npm/default` (R5). */
  servedBy: string | null;
  totalVersions: number;
  evaluated: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** `license`: null when none is declared; absent when it could not be loaded. */
  recommended: { version: string; releaseType: ReleaseType; publishedAt?: string; license?: string | null } | null;
  packageNotice: PackageNotice | null;
  /** Null when no internal namespace policy reserves the name. */
  namespace: NamespaceInfo | null;
  /** Null when no enabled Project health (Scorecard) policy covers the ecosystem, or the check timed out. */
  projectHealth: ProjectHealth | null;
  /** Day the EPSS scores shown with the vulnerabilities are from; null when none were looked up or never synced. */
  epssDate?: string | null;
  missingVersions: string[];
  versions: CheckedVersion[];
};

export type PackageCheckInput = {
  ecosystem: string;
  package: string;
  repository: string;
  versions: string[];
  offset: number;
  limit: number;
  composerDev?: boolean;
  /** Who is checking, for their own pending waivers. */
  userId?: string;
};

export class PackageCheckError extends Error {
  constructor(
    readonly status: 400 | 404 | 502,
    message: string,
    readonly registry?: string
  ) {
    super(message);
  }
}

export const CHECK_TIMEOUT_MS = 10_000;
/** The one extra read for the recommended version's license; past it the license is left out. */
const RECOMMENDED_LICENSE_TIMEOUT_MS = 3_000;

/** `ecosystem/key` labels per scoped policy, read in one query. */
async function policyScopeLabels(db: DataSource, compiled: CompiledPolicy[]): Promise<Map<string, string[]>> {
  const scoped = compiled.filter((policy) => policy.repositoryIds);
  if (scoped.length === 0) return new Map();
  const refs = await repositoryRefMap(db, scoped.map((policy) => ({ repositoryIds: [...policy.repositoryIds!] })));
  return new Map(
    scoped.map((policy) => [
      policy.id,
      refsFor([...policy.repositoryIds!], refs).map((ref) => `${ref.ecosystem}/${ref.key}`),
    ])
  );
}

const TOO_NEW_REASON = /^Release is newer than \d+(?:\.\d+)? hours/;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function remoteHosts(route: PackageRoute): string[] {
  return [...new Set(route.targets.map((target) => hostOf(target.url)))];
}

function namespaceInfo(route: PackageRoute, outcome: NamespaceInfo['outcome'] | null): NamespaceInfo | null {
  const match = route.reserved ?? route.monitored[0];
  if (!match) return null;
  const label = (target: RemoteTarget) => remoteLabel(route.ecosystem, target);
  return {
    reserved: true,
    mode: match.mode,
    policyId: match.policyId,
    policy: match.policyName,
    pattern: match.pattern,
    internalRemotes: route.targets.filter((target) => target.source === 'internal').map(label),
    publicRemotesSkipped: route.reserved ? route.skipped.map(label) : [],
    outcome: route.reserved ? (outcome ?? 'internal') : 'monitor',
  };
}

type Timed<T> = { done: true; value: T } | { done: false };

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function latestExpiry(rows: Exception[], version: string, ecosystem: string): Date | null {
  let best: Date | null = null;
  for (const row of rows) {
    if (!matchesAnyException([row], version, ecosystem)) continue;
    if (!best || row.expiresAt > best) best = row.expiresAt;
  }
  return best;
}

function waiverCovers(ecosystem: string, waiverVersion: string, version: string): boolean {
  const spec = waiverVersion.trim();
  if (!spec || spec === '*' || spec === version) return true;
  return versionInRange(ecosystem, version, spec) === 'match';
}

function allowedAfter(result: PolicyResult, policy: CompiledPolicy | undefined, publishedAt: string | undefined): string | undefined {
  if (!policy?.releaseAgeMaxHours || !publishedAt) return undefined;
  if (!result.reasons.some((reason) => TOO_NEW_REASON.test(reason))) return undefined;
  const at = Date.parse(publishedAt) + policy.releaseAgeMaxHours * 3_600_000;
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

type RowContext = {
  ecosystem: string;
  positions: Map<string, number>;
  exceptions: Exception[];
  policies: Map<string, CompiledPolicy>;
  /** `ecosystem/key` labels of each scoped policy's repositories. */
  scopes: Map<string, string[]>;
  pendingWaivers: WaiverRequest[];
  requested: Set<string>;
  defaultVersion?: string;
};

function publishTime(listed: ListedVersion, detail: VersionDetail | undefined, display: VersionFacts | undefined): string | undefined {
  return detail?.facts?.publishedAt ?? display?.publishedAt ?? listed.publishedAt;
}

function buildRow(
  ctx: RowContext,
  listed: ListedVersion,
  result: PolicyResult | null | undefined,
  detail: VersionDetail | undefined,
  display: VersionFacts | undefined,
  timedOut: boolean,
  monitoring: MonitorMatch[] | undefined
): CheckedVersion {
  const { version } = listed;
  const row: CheckedVersion = {
    version,
    position: ctx.positions.get(version) ?? -1,
    status: 'allowed',
    reasons: [],
    releaseType: classifyRelease(ctx.ecosystem, version).type,
    publishedAt: publishTime(listed, detail, display),
  };
  if (ctx.requested.has(version)) row.requested = true;
  if (ctx.defaultVersion === version) row.isDefault = true;

  if (timedOut) {
    row.status = 'unknown';
    row.incomplete = ['timeout'];
    return row;
  }

  const facts = detail?.facts;
  if (facts?.cveKnown && !facts.cveUnavailable) {
    row.vulnerabilities = facts.vulns.map((vuln) => {
      const cvss = vulnCvss(vuln);
      return {
        id: displayVulnId(vuln),
        severity: cvssSeverity(cvss),
        cvss: cvss ? { score: cvss.score, version: cvss.version } : null,
        cves: vulnCves(vuln),
        epss: null,
      };
    });
  }

  if (!result || result.decision === 'ALLOW') {
    row.status = 'allowed';
    if (monitoring?.length) {
      row.monitoring = monitoring.map((match) => ({
        policyId: match.policyId,
        policyName: match.policyName,
        reasons: match.reasons,
      }));
    }
    const expiry = latestExpiry(ctx.exceptions, version, ctx.ecosystem);
    if (!result && expiry) {
      row.policyName = 'Exception';
      row.exception = { expiresAt: expiry.toISOString() };
      return row;
    }
    if (result) {
      row.policyName = result.policyName;
      row.reasons = result.reasons;
      const scope = ctx.scopes.get(result.policyId);
      if (scope) row.policyScope = scope;
    }
    if (detail?.incomplete.length) row.incomplete = [...detail.incomplete];
    return row;
  }

  row.policyName = result.policyName;
  row.reasons = result.reasons;
  const scope = ctx.scopes.get(result.policyId);
  if (scope) row.policyScope = scope;
  row.status = 'blocked';
  if (result.policyId === 'malicious') row.malicious = true;
  const after = allowedAfter(result, ctx.policies.get(result.policyId), row.publishedAt);
  if (after) row.allowedAfter = after;
  if (ctx.pendingWaivers.some((waiver) => waiverCovers(ctx.ecosystem, waiver.version, version))) {
    row.waiverPending = true;
  }
  return row;
}

function npmLicense(meta: PackumentVersion | undefined): string | undefined {
  return npmDeclaredLicense(meta);
}

/** The facts the engine used win; null means none declared, undefined that it could not be loaded. */
function licenseLabel(engine: VersionFacts | undefined, loaded: VersionFacts | undefined): string | null | undefined {
  const fact = engine?.licenseKnown ? engine : loaded;
  if (!fact?.licenseKnown || (fact.metaUnavailable && !fact.license)) return undefined;
  const tree = parseLicense(fact.license);
  return tree ? formatLicense(tree) : null;
}

/**
 * Newest allowed stable version, else the newest allowed version of any type.
 * Only fully checked versions count: an allow on missing data is never recommended.
 */
export function recommendVersion(rows: CheckedVersion[]): CheckedVersion | null {
  const clean = rows.filter((row) => row.status === 'allowed' && !row.incomplete?.length);
  return clean.find((row) => row.releaseType === 'stable') ?? clean[0] ?? null;
}

function packageWideBlock(
  rows: CheckedVersion[],
  results: Map<string, PolicyResult | null>,
  policies: Map<string, CompiledPolicy>
): PackageNotice | null {
  if (rows.length === 0) return null;
  let policyId: string | null = null;
  for (const row of rows) {
    const result = results.get(row.version);
    if (!result || result.decision !== 'BLOCK') return null;
    if (policyId && result.policyId !== policyId) return null;
    policyId = result.policyId;
  }
  const policy = policyId ? policies.get(policyId) : undefined;
  if (!policy || policy.packageMatchers.length === 0 || policy.versionRangeRaw) return null;
  return {
    kind: 'policy',
    policyName: policy.name,
    message: `Every version of this package is blocked by policy "${policy.name}"`,
  };
}

async function listOrFail(
  db: DataSource,
  redis: Redis,
  input: PackageCheckInput,
  hosts: string[],
  route: PackageRoute
): Promise<PackageVersionList | null> {
  let list: PackageVersionList | null;
  try {
    list = await listPackageVersions(
      db,
      redis,
      input.ecosystem,
      input.repository,
      input.package,
      {
        composerDev: input.composerDev,
        composerVersions: input.ecosystem === 'composer' ? input.versions : undefined,
        goVersions: input.ecosystem === 'go' ? input.versions : undefined,
      },
      route
    );
  } catch (err) {
    const registry = hosts.join(', ');
    const detail = err instanceof Error ? err.message : String(err);
    throw new PackageCheckError(502, `Couldn't reach ${registry}: ${detail}`, registry);
  }
  // A reserved name no internal remote has is the download's outcome too (404 and a ledger row), not an error.
  if (!list && !route.reserved) throw new PackageCheckError(404, `Package not found in ${input.repository}`);
  return list;
}

/** The answer when the internal namespace rule decides before any version is listed. */
/** The remote the package came from, when the route knows it without probing. */
async function servedByLabel(route: PackageRoute): Promise<string | null> {
  if (route.targets.length === 1) return remoteLabel(route.ecosystem, route.targets[0]);
  const source = route.servingSource ? await route.servingSource().catch(() => null) : null;
  return source ? remoteLabel(route.ecosystem, source) : null;
}

function namespaceOutcome(input: PackageCheckInput, route: PackageRoute, result: PolicyResult, outcome: 'blocked' | 'notFound'): PackageCheckResult {
  return {
    ecosystem: input.ecosystem,
    package: input.package,
    repository: input.repository,
    checkedAt: new Date().toISOString(),
    checkedAgainst: remoteHosts(route),
    searchOrder: route.targets.map((target) => remoteLabel(route.ecosystem, target)),
    servedBy: null,
    totalVersions: 0,
    evaluated: 0,
    offset: input.offset,
    limit: input.limit,
    hasMore: false,
    recommended: null,
    packageNotice: { kind: 'namespace', message: result.reasons[0] ?? '', policyName: result.policyName },
    namespace: namespaceInfo(route, outcome),
    projectHealth: null,
    missingVersions: input.versions,
    versions: [],
  };
}

/**
 * Package check: which versions of a package the gateway would serve, and why not.
 * The decision comes from the same engine and data as a download. Nothing is written:
 * no ledger rows, download metrics or webhooks.
 */
export async function runPackageCheck(
  db: DataSource,
  redis: Redis,
  input: PackageCheckInput,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<PackageCheckResult> {
  // Someone who just saved a policy and checks again must see it, whichever replica answers.
  const verified = await getCompiledPolicies(db, { verifyPolicies: true });
  const route = await resolvePackageTargets(db, input.ecosystem, input.repository, input.package, { policies: verified });
  if (route.targets.length + route.skipped.length === 0) {
    throw new PackageCheckError(400, `Repository "${input.repository}" does not exist or is not enabled for ${input.ecosystem}`);
  }
  if (route.block) return namespaceOutcome(input, route, route.block, 'blocked');
  const hosts = remoteHosts(route);
  const list = await listOrFail(db, redis, input, hosts, route);
  if (!list) return namespaceOutcome(input, route, namespaceNotFoundResult(route)!, 'notFound');
  // R5: the versions listed came from the remote that served the package document.
  if (input.ecosystem === 'npm' && !route.servingSource) {
    let source: Promise<RemoteTarget | null> | null = null;
    route.servingSource = () => (source ??= npmPackumentSource(db, redis, input.package, route));
  }
  const window = selectWindow(input.ecosystem, list, input.versions, input.offset, input.limit);
  const windowVersions = window.rows.map((row) => row.version);

  const evaluation = evaluatePackageVersionsDetailed(
    db,
    input.ecosystem,
    input.package,
    window.rows.map((row) => ({ version: row.version, versionMeta: row.versionMeta })),
    redis,
    list.packageLastReleaseAt,
    // Someone who just saved a policy and checks again must see it, whichever replica answers.
    // Monitoring policies are walked to show what they would block; nothing is recorded.
    { repoKey: input.repository, verifyPolicies: true, monitor: true, route }
  );
  // Publish dates for the Released column. npm already has them in the packument.
  const display =
    input.ecosystem === 'npm' || windowVersions.length === 0
      ? Promise.resolve(new Map<string, VersionFacts>())
      : loadVersionFacts(
          db,
          redis,
          input.ecosystem,
          input.package,
          windowVersions,
          { license: false, publishedAt: true, cve: false },
          input.repository,
          undefined,
          route
        ).catch(() => new Map<string, VersionFacts>());

  // The license of each version someone asked about. Only those, so the table costs no extra reads.
  const requestedRows = window.rows.filter((row) => window.requested.has(row.version));
  const licenses: Promise<Map<string, VersionFacts>> =
    requestedRows.length === 0
      ? Promise.resolve(new Map())
      : input.ecosystem === 'npm'
        ? Promise.resolve(
            new Map(
              requestedRows.map((row) => [
                row.version,
                { vulns: [], license: npmLicense(row.versionMeta), licenseKnown: true, publishedKnown: false, cveKnown: false },
              ])
            )
          )
        : loadVersionFacts(
            db,
            redis,
            input.ecosystem,
            input.package,
            requestedRows.map((row) => row.version),
            { license: true, publishedAt: false, cve: false },
            input.repository,
            undefined,
            route
          ).catch(() => new Map<string, VersionFacts>());

  const [timed, packageExceptions, malicious, compiled, pendingWaivers] = await Promise.all([
    withDeadline(Promise.all([evaluation, display, licenses]), timeoutMs),
    db
      .getRepository(Exception)
      .createQueryBuilder('e')
      .where('e.ecosystem = :ecosystem', { ecosystem: input.ecosystem })
      .andWhere('e.packageName = :packageName', { packageName: canonicalPackageName(input.ecosystem, input.package) })
      .andWhere('e.expiresAt > :now', { now: new Date() })
      // A policy-scoped approval is not an exception for the package as a whole.
      .andWhere('e.policyId IS NULL')
      .getMany(),
    findMaliciousEntry(db, input.ecosystem, input.package),
    Promise.resolve(verified),
    input.userId
      ? db.getRepository(WaiverRequest).find({
          where: {
            requestedById: input.userId,
            ecosystem: input.ecosystem,
            packageName: canonicalPackageName(input.ecosystem, input.package),
            status: 'pending',
          },
        })
      : Promise.resolve([] as WaiverRequest[]),
  ]);
  // A timed-out evaluation keeps running and warms the caches, so a retry is fast.
  if (!timed.done) void evaluation.catch(() => undefined);

  const [{ results, details, monitor }, displayFacts, licenseFacts] = timed.done
    ? timed.value
    : [
        {
          results: new Map<string, PolicyResult | null>(),
          details: new Map<string, VersionDetail>(),
          monitor: new Map<string, MonitorMatch[]>(),
        },
        new Map<string, VersionFacts>(),
        new Map<string, VersionFacts>(),
      ];
  const policies = new Map(compiled.map((policy) => [policy.id, policy]));
  // An exception applies when its scope names this repository or the remote serving the package (R5).
  const exceptionScope = await scopeContext(
    packageExceptions.map((row) => scopeIds(row.repositoryIds)),
    () => repositoryIdFor(db, input.ecosystem, input.repository),
    route.targets,
    route.servingSource
  );
  const exceptions = packageExceptions.filter((row) => exceptionCovers(scopeIds(row.repositoryIds), exceptionScope));
  const ctx: RowContext = {
    ecosystem: input.ecosystem,
    positions: new Map(list.versions.map((row, index) => [row.version, index])),
    exceptions,
    policies,
    scopes: await policyScopeLabels(db, compiled),
    pendingWaivers,
    requested: window.requested,
    defaultVersion: window.defaultVersion,
  };
  const rows = window.rows.map((listed) =>
    buildRow(
      ctx,
      listed,
      results.get(listed.version),
      details.get(listed.version),
      displayFacts.get(listed.version),
      !timed.done,
      monitor.get(listed.version)
    )
  );
  for (const row of rows) {
    if (!row.requested) continue;
    const label = licenseLabel(details.get(row.version)?.facts, licenseFacts.get(row.version));
    if (label !== undefined) row.license = label;
  }
  const epssDate = await attachEpss(db, rows);

  let packageNotice: PackageNotice | null = null;
  if (malicious && malicious.overrideStatus !== 'ALLOW' && !malicious.versionRange) {
    packageNotice = { kind: 'malware', message: 'This package is on the malicious packages list' };
  } else if (timed.done) {
    packageNotice = packageWideBlock(rows, results, policies);
  }

  const recommended = packageNotice?.kind === 'malware' ? null : recommendVersion(rows);
  const [projectHealth, recommendedLicense] = await Promise.all([
    timed.done ? projectHealthOf(db, redis, input, route, compiled, rows, window.rows, details) : null,
    recommended ? licenseOfRecommended(db, redis, input, route, recommended, window.rows, details) : undefined,
  ]);
  return {
    ecosystem: input.ecosystem,
    package: input.package,
    repository: input.repository,
    checkedAt: new Date().toISOString(),
    checkedAgainst: hosts,
    searchOrder: route.targets.map((target) => remoteLabel(route.ecosystem, target)),
    servedBy: await servedByLabel(route),
    totalVersions: list.versions.length,
    evaluated: rows.length,
    offset: input.offset,
    limit: input.limit,
    hasMore: input.offset + input.limit < list.versions.length,
    recommended: recommended
      ? {
          version: recommended.version,
          releaseType: recommended.releaseType,
          publishedAt: recommended.publishedAt,
          ...(recommendedLicense !== undefined ? { license: recommendedLicense } : {}),
        }
      : null,
    packageNotice,
    namespace: namespaceInfo(route, null),
    projectHealth,
    epssDate,
    missingVersions: window.missing,
    versions: rows,
  };
}

/**
 * The recommended version's license, since it can differ from the version asked for.
 * Reuses what the check already read (the version asked for, the engine's facts, npm's packument);
 * otherwise one lookup for that version. undefined: it could not be loaded in time.
 */
async function licenseOfRecommended(
  db: DataSource,
  redis: Redis,
  input: PackageCheckInput,
  route: PackageRoute,
  recommended: CheckedVersion,
  listed: ListedVersion[],
  details: Map<string, VersionDetail>
): Promise<string | null | undefined> {
  if (recommended.requested) return recommended.license;
  const engine = details.get(recommended.version)?.facts;
  if (engine?.licenseKnown) return licenseLabel(engine, undefined);
  if (input.ecosystem === 'npm') {
    const meta = listed.find((row) => row.version === recommended.version)?.versionMeta;
    return licenseLabel(undefined, { vulns: [], license: npmLicense(meta), licenseKnown: true, publishedKnown: false, cveKnown: false });
  }
  const lookup = loadVersionFacts(
    db,
    redis,
    input.ecosystem,
    input.package,
    [recommended.version],
    { license: true, publishedAt: false, cve: false },
    input.repository,
    undefined,
    route
  ).catch(() => null);
  const timed = await withDeadline(lookup, RECOMMENDED_LICENSE_TIMEOUT_MS);
  return timed.done ? licenseLabel(undefined, timed.value?.get(recommended.version)) : undefined;
}

/** EPSS for every listed vulnerability, from one lookup in DepGate's store. Returns the scores' day. */
async function attachEpss(db: DataSource, rows: CheckedVersion[]): Promise<string | null> {
  const cves = [...new Set(rows.flatMap((row) => (row.vulnerabilities ?? []).flatMap((vuln) => vuln.cves)))];
  if (cves.length === 0) return null;
  const { scores, scoreDate } = await lookupEpss(db, cves);
  for (const row of rows) {
    for (const vuln of row.vulnerabilities ?? []) {
      let best: { score: number; percentile: number } | null = null;
      for (const cve of vuln.cves) {
        const value = scores.get(cve);
        if (value && (!best || value.score > best.score)) best = value;
      }
      vuln.epss = best;
    }
  }
  return scoreDate;
}

/**
 * The Scorecard of the version asked about (else the default, else the newest checked one).
 * The evaluation's facts are used when it reached the Scorecard rule; otherwise one lookup.
 */
async function projectHealthOf(
  db: DataSource,
  redis: Redis,
  input: PackageCheckInput,
  route: PackageRoute,
  compiled: CompiledPolicy[],
  rows: CheckedVersion[],
  listed: ListedVersion[],
  details: Map<string, VersionDetail>
): Promise<ProjectHealth | null> {
  const covered = compiled.some((policy) => policy.scorecard && (!policy.ecosystems || policy.ecosystems.has(input.ecosystem)));
  if (!covered || rows.length === 0) return null;
  const version = (rows.find((row) => row.requested) ?? rows.find((row) => row.isDefault) ?? rows[0]).version;
  let lookup: ScorecardLookup | undefined = details.get(version)?.facts?.scorecard;
  if (!lookup) {
    const meta = listed.find((row) => row.version === version)?.versionMeta;
    const repository = input.ecosystem === 'npm' ? npmRepositorySeed(meta) : undefined;
    const seeded = repository
      ? new Map([[version, { licenseKnown: false, publishedKnown: false, repository }]])
      : undefined;
    const loaded = await loadVersionFacts(
      db,
      redis,
      input.ecosystem,
      input.package,
      [version],
      { license: false, publishedAt: false, cve: false, scorecard: true },
      input.repository,
      seeded,
      route
    ).catch(() => null);
    lookup = loaded?.get(version)?.scorecard;
  }
  return lookup ? { version, ...scorecardView(lookup) } : null;
}
