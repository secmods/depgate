import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Minimatch } from 'minimatch';
import {
  compileLicensePatterns,
  formatLicense,
  licenseApproved,
  licenseDenied,
  parseLicense,
} from './license-expression.js';
import { Policy, PolicyDecision, PolicyMode } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import {
  latestVersionPublishTime,
  npmDeclaredLicense,
  packumentTimeMap,
  withVersionPublishTime,
  type PackumentVersion,
} from './npm-packument.js';
import { findMaliciousEntryCached, maliciousMatch, malwareListed, type MalwareHit } from './malicious-sync.js';
import { canonicalPackageName, PackagePattern } from './package-name.js';
import { matchingException } from './exception-service.js';
import { versionInRange } from './version-range.js';
import { classifyRelease, releaseTypeReason } from './release-type.js';
import { readReference, readReferenceEntry } from './reference-cache.js';
import { loadVersionFacts, type SeededFacts, type VersionFacts } from './package-facts.js';
import { repositoryIdFor } from './repository-resolve.js';
import type { PackageRoute } from './namespace-protection.js';
import { exceptionCovers, policyCovers, scopeContext, scopeIds } from './repository-scope.js';
import {
  canonicalName,
  compileNamespacePatterns,
  compilePublicPackages,
  firstMatchingPattern,
  type CompiledNamespacePattern,
  type PublicPackageMatcher,
} from './namespace-patterns.js';
import { compileScorecard, scorecardOutcome, type CompiledScorecard, type ScorecardConditions } from './scorecard-rule.js';
import { npmRepositorySeed } from './scorecard.js';
import { compileEpss, evaluateVulnerabilities, type CompiledEpss, type EpssConditions } from './epss-rule.js';
import { compileCvss, withCvssMin, type CompiledCvss, type CvssConditions } from './cvss.js';

export type PolicyConditions = ScorecardConditions & EpssConditions & CvssConditions & {
  ecosystem?: string[];
  packageBlockList?: string[];
  /** License rule, block mode: these licenses are blocked. */
  licenseDenyList?: string[];
  /** License rule, allow-only mode: every other license is blocked. */
  licenseAllowList?: string[];
  /** Allow-only mode: let a package with no license information through. Default false. */
  allowUnknownLicense?: boolean;
  versionRange?: string;
  releaseAgeMinDays?: number;
  releaseAgeMaxHours?: number;
  cveBlockList?: string[];
  /** Release stages to match: prerelease, dev, snapshot, pseudo. */
  releaseTypes?: string[];
  /** Internal namespace rule: names served only from internal remotes. One ecosystem per policy. */
  reservedNamespaces?: string[];
  /**
   * Internal namespace rule: the remotes (repository IDs) that may serve the reserved names. Empty or
   * missing: every remote marked Internal. Set: exactly these, public ones included (R6).
   */
  allowedRemotes?: string[];
  /** Names (or globs) inside the reserved namespaces that may come from public remotes. */
  publicPackages?: string[];
};

export type PolicyResult = {
  decision: PolicyDecision;
  policyId: string;
  policyName: string;
  reasons: string[];
  remediation?: string;
};

/**
 * A monitor-mode policy that matched a version the gateway still allowed.
 * reasonKey groups the report: the matched package pattern, the release type,
 * `too_new`/`unmaintained`, `cve:<ID>`, `cvss:<CVE>` or `epss:<CVE>`, or the license expression.
 * Reports recorded before CVSS replaced severity also hold `severity:<highest>`.
 */
export type MonitorMatch = {
  policyId: string;
  policyName: string;
  reasons: string[];
  reasonKey: string;
  /** When monitoring (re)started, in ms. Keys the recorder's Redis counters; not part of API output. */
  modeEpoch?: number;
};

export type PackageContext = {
  name: string;
  version: string;
  ecosystem?: string;
  license?: string;
  publishedAt?: string;
  /** Package's newest release time (for unmaintained check) */
  packageLastReleaseAt?: string;
  [key: string]: unknown;
};

function getLicense(meta: PackumentVersion): string | undefined {
  return npmDeclaredLicense(meta);
}

function getPublishedTime(meta: PackumentVersion | undefined): Date | undefined {
  const t = meta?.time ?? meta?.published;
  if (typeof t === 'string') {
    const parsed = new Date(t);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

export { packumentTimeMap, latestVersionPublishTime, withVersionPublishTime };

function matchPackageBlockList(ecosystem: string | undefined, name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new PackagePattern(pattern).match(ecosystem, name));
}

type LicenseRule = {
  mode: 'deny' | 'allow';
  matchers: Minimatch[];
  /** Allow mode: let a package with no license information through. */
  allowUnknown: boolean;
};

function licenseRule(conditions: PolicyConditions): LicenseRule | null {
  if (conditions.licenseAllowList?.length) {
    return {
      mode: 'allow',
      matchers: compileLicensePatterns(conditions.licenseAllowList),
      allowUnknown: conditions.allowUnknownLicense === true,
    };
  }
  if (conditions.licenseDenyList?.length) {
    return { mode: 'deny', matchers: compileLicensePatterns(conditions.licenseDenyList), allowUnknown: false };
  }
  return null;
}

/**
 * Why the license rule matches, or an empty list when it does not.
 * Deny: a listed license that cannot be avoided (`MIT OR GPL-3.0` escapes a GPL-3.0 ban).
 * Allow only: any license that is not approved, and an unknown one unless the policy lets it through.
 */
function licenseReasons(license: string | undefined, rule: LicenseRule): string[] {
  const tree = parseLicense(license);
  if (rule.mode === 'deny') {
    const denied = tree
      ? licenseDenied(tree, rule.matchers)
      : rule.matchers.some((matcher) => matcher.match('UNKNOWN'));
    return denied ? [`License "${(license ?? '').trim() || 'UNKNOWN'}" matches policy license list`] : [];
  }
  if (!tree) {
    return rule.allowUnknown ? [] : ['License is unknown, and only approved licenses are allowed'];
  }
  return licenseApproved(tree, rule.matchers) ? [] : [`License "${formatLicense(tree)}" is not in the approved list`];
}

function versionMatchesPolicy(
  ecosystem: string | undefined,
  version: string,
  range: string,
  decision?: PolicyDecision
): { match: boolean; reason: string } | null {
  const verdict = versionInRange(ecosystem, version, range);
  if (verdict === 'miss' || (verdict === 'unknown' && decision === 'ALLOW')) return null;
  return {
    match: true,
    reason:
      verdict === 'unknown'
        ? `Version ${version} could not be compared to range "${range}"`
        : `Version ${version} matches range "${range}"`,
  };
}

function matchReleaseAgeMinDays(publishedAt: Date | undefined, minDays: number): boolean {
  if (!publishedAt) return false;
  const ageDays = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > minDays;
}

function matchReleaseAgeMaxHours(publishedAt: Date | undefined, maxHours: number): boolean {
  if (!publishedAt) return false;
  const ageHours = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60);
  return ageHours < maxHours;
}

/**
 * The release age rule: too new (this version) or unmaintained (the package's newest
 * release). One version can never be both, so either one matches. Returns null when the
 * policy has no release age rule, and an empty list when it has one that does not match.
 */
function releaseAgeReasons(
  publishedAt: Date | undefined,
  lastReleaseAt: Date | undefined,
  minDays: number | null | undefined,
  maxHours: number | null | undefined
): string[] | null {
  const checkUnmaintained = minDays != null && minDays > 0;
  const checkTooNew = maxHours != null && maxHours > 0;
  if (!checkUnmaintained && !checkTooNew) return null;
  const reasons: string[] = [];
  if (checkUnmaintained && matchReleaseAgeMinDays(lastReleaseAt, minDays)) {
    reasons.push(`Package last release is older than ${minDays} days (unmaintained)`);
  }
  if (checkTooNew && matchReleaseAgeMaxHours(publishedAt, maxHours)) {
    reasons.push(`Release is newer than ${maxHours} hours (unvetted)`);
  }
  return reasons;
}

export function evaluateConditions(
  ctx: PackageContext,
  conditions: PolicyConditions,
  versionMeta?: PackumentVersion,
  decision?: PolicyDecision
): { match: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (conditions.packageBlockList?.length) {
    const ecosystem = typeof ctx.ecosystem === 'string' ? ctx.ecosystem : undefined;
    if (!matchPackageBlockList(ecosystem, ctx.name, conditions.packageBlockList)) {
      return { match: false, reasons: [] };
    }
    reasons.push(`Package "${ctx.name}" matches ${decision === 'ALLOW' ? 'allow' : 'block'} list`);
  }

  const license = licenseRule(conditions);
  if (license) {
    const licenseText = (versionMeta ? getLicense(versionMeta) : ctx.license) ?? ctx.license;
    const licenseMatch = licenseReasons(licenseText, license);
    if (licenseMatch.length === 0) return { match: false, reasons: [] };
    reasons.push(...licenseMatch);
  }

  if (conditions.versionRange) {
    const versionMatch = versionMatchesPolicy(ctx.ecosystem, ctx.version, conditions.versionRange, decision);
    if (!versionMatch) return { match: false, reasons: [] };
    reasons.push(versionMatch.reason);
  }

  if (conditions.releaseTypes?.length) {
    const release = classifyRelease(ctx.ecosystem, ctx.version);
    if (!conditions.releaseTypes.includes(release.type)) return { match: false, reasons: [] };
    reasons.push(releaseTypeReason(ctx.version, release));
  }

  const publishedAt = versionMeta ? getPublishedTime(versionMeta) : undefined;
  const lastReleaseAt = ctx.packageLastReleaseAt ? new Date(ctx.packageLastReleaseAt) : publishedAt;
  const ageReasons = releaseAgeReasons(
    publishedAt,
    lastReleaseAt,
    conditions.releaseAgeMinDays,
    conditions.releaseAgeMaxHours
  );
  if (ageReasons) {
    if (ageReasons.length === 0) return { match: false, reasons: [] };
    reasons.push(...ageReasons);
  }

  return { match: reasons.length > 0, reasons };
}

export type VersionEvaluation = {
  version: string;
  versionMeta?: PackumentVersion;
};

export type EvaluateOptions = {
  /** Read policies from Postgres instead of the process cache. */
  policiesFromDatabase?: boolean;
  /** Confirm the cached policies against Redis first, so a policy saved a moment ago on any replica applies. */
  verifyPolicies?: boolean;
  repoKey?: string;
  /**
   * Walk monitor-mode policies and collect what they would block. Only the artifact download
   * path and Package check set this; metadata never filters or loads facts for monitor policies.
   */
  monitor?: boolean;
  /**
   * The internal namespace block of the request's route (no internal remote can serve the name).
   * Only the malicious packages list comes before it; exceptions and Allow policies do not lift it.
   */
  namespaceBlock?: PolicyResult | null;
  /** The request's resolved route, so facts are read from the same remotes and cache scope as the request. */
  route?: PackageRoute;
};

export type CompiledNamespace = {
  ecosystem: string;
  patterns: CompiledNamespacePattern[];
  publicPackages: PublicPackageMatcher[];
  /** Remotes that may serve the names; null for every internal remote. */
  allowedRemoteIds: Set<string> | null;
};

export type CompiledPolicy = {
  id: string;
  name: string;
  decision: PolicyDecision;
  mode: PolicyMode;
  /** mode_changed_at in ms, so a restart of monitoring starts fresh Redis counters. */
  modeEpoch: number;
  ecosystems: Set<string> | null;
  packageMatchers: PackagePattern[];
  license: LicenseRule | null;
  versionRangeRaw: string | null;
  releaseAgeMinDays: number | null;
  releaseAgeMaxHours: number | null;
  cveBlockList: string[];
  /** CVSS minimum of the Vulnerability rule. */
  cvss: CompiledCvss | null;
  /** EPSS threshold of the Vulnerability rule; it applies to the same vulnerability as the CVSS minimum (D2). */
  epss: CompiledEpss | null;
  releaseTypes: Set<string> | null;
  /** Repositories the policy applies to; null for every repository. */
  repositoryIds: Set<string> | null;
  /** Internal namespace rule. It decides where a name is fetched from, never a version, so it never matches here. */
  namespace: CompiledNamespace | null;
  /** OpenSSF Scorecard rule. */
  scorecard: CompiledScorecard | null;
  needsLicense: boolean;
  needsPublishedAt: boolean;
  needsCve: boolean;
};

export type FactSlot = 'license' | 'published' | 'cve' | 'scorecard';

type NeedFlags = { license: boolean; publishedAt: boolean; cve: boolean; epss: boolean; scorecard: boolean };

function noNeeds(): NeedFlags {
  return { license: false, publishedAt: false, cve: false, epss: false, scorecard: false };
}

/** EPSS rides on the CVE slot: a policy with an EPSS threshold asks for both in the same round. */
function noteNeed(need: NeedFlags, slot: FactSlot, policy: CompiledPolicy): void {
  if (slot === 'license') need.license = true;
  else if (slot === 'published') need.publishedAt = true;
  else if (slot === 'cve') {
    need.cve = true;
    if (policy.epss) need.epss = true;
  } else need.scorecard = true;
}

function anyNeed(need: NeedFlags): boolean {
  return need.license || need.publishedAt || need.cve || need.scorecard;
}

/**
 * What a read-only caller such as Package check needs beyond the decision: the facts the
 * engine loaded, and the policies it could not evaluate because a fact was missing.
 * A missing fact never blocks a download; it only stops the caller calling the result clean.
 */
export type VersionDetail = {
  incomplete: FactSlot[];
  facts?: VersionFacts;
};

function compileNamespace(conditions: PolicyConditions): CompiledNamespace | null {
  const ecosystems = conditions.ecosystem ?? [];
  if (!conditions.reservedNamespaces?.length || ecosystems.length !== 1) return null;
  const ecosystem = ecosystems[0];
  const patterns = compileNamespacePatterns(ecosystem, conditions.reservedNamespaces);
  if (patterns.length === 0) return null;
  return {
    ecosystem,
    patterns,
    publicPackages: compilePublicPackages(ecosystem, conditions.publicPackages),
    allowedRemoteIds: conditions.allowedRemotes?.length ? new Set(conditions.allowedRemotes) : null,
  };
}

export function compilePolicy(policy: Policy): CompiledPolicy {
  const conditions = withCvssMin((policy.conditions ?? {}) as PolicyConditions);
  const packageMatchers = (conditions.packageBlockList ?? []).map((pattern) => new PackagePattern(pattern));
  const license = licenseRule(conditions);
  const releaseAgeMinDays =
    conditions.releaseAgeMinDays != null && conditions.releaseAgeMinDays > 0
      ? conditions.releaseAgeMinDays
      : null;
  const releaseAgeMaxHours =
    conditions.releaseAgeMaxHours != null && conditions.releaseAgeMaxHours > 0
      ? conditions.releaseAgeMaxHours
      : null;
  const cveBlockList = conditions.cveBlockList ?? [];
  const cvss = compileCvss(conditions);
  const epss = compileEpss(conditions);
  return {
    id: policy.id,
    name: policy.name,
    decision: policy.decision,
    // Only Block policies can monitor; anything else is enforced whatever the column says.
    mode: policy.mode === 'monitor' && policy.decision === 'BLOCK' ? 'monitor' : 'enforce',
    modeEpoch: policy.modeChangedAt ? new Date(policy.modeChangedAt).getTime() : 0,
    ecosystems: conditions.ecosystem?.length ? new Set(conditions.ecosystem) : null,
    packageMatchers,
    license,
    versionRangeRaw: conditions.versionRange?.trim() ? conditions.versionRange.trim() : null,
    releaseAgeMinDays,
    releaseAgeMaxHours,
    cveBlockList,
    cvss,
    epss,
    releaseTypes: conditions.releaseTypes?.length ? new Set(conditions.releaseTypes) : null,
    repositoryIds: scopeIds(policy.repositoryIds),
    namespace: compileNamespace(conditions),
    scorecard: compileScorecard(conditions),
    needsLicense: license !== null,
    needsPublishedAt: releaseAgeMinDays != null || releaseAgeMaxHours != null,
    needsCve: cveBlockList.length > 0 || cvss !== null || epss !== null,
  };
}

async function loadPolicies(db: DataSource): Promise<CompiledPolicy[]> {
  const rows = await db.getRepository(Policy).find({
    where: { isEnabled: true },
    order: { priority: 'ASC' },
  });
  return rows.map(compilePolicy);
}

export async function getCompiledPolicies(
  db: DataSource,
  options?: EvaluateOptions
): Promise<CompiledPolicy[]> {
  if (options?.policiesFromDatabase) return loadPolicies(db);
  return readReference('policies', () => loadPolicies(db), { verify: options?.verifyPolicies });
}

function policyResult(policy: CompiledPolicy, reasons: string[]): PolicyResult {
  return {
    decision: policy.decision,
    policyId: policy.id,
    policyName: policy.name,
    reasons,
    remediation: `Contact your administrator to review policy "${policy.name}" (ID: ${policy.id})`,
  };
}

/** The license as the report groups it: the normalized expression, or UNKNOWN. */
export function licenseReasonKey(license: string | undefined): string {
  const tree = parseLicense(license);
  return tree ? formatLicense(tree) : 'UNKNOWN';
}

type MatchOutcome = {
  match: boolean;
  reasons: string[];
  reasonKey?: string;
  need?: FactSlot;
  unavailable?: FactSlot;
};

function matchCompiled(
  ctx: PackageContext,
  policy: CompiledPolicy,
  facts: VersionFacts | undefined
): MatchOutcome {
  if (policy.ecosystems && !policy.ecosystems.has(String(ctx.ecosystem ?? ''))) {
    return { match: false, reasons: [] };
  }
  if (policy.namespace) return { match: false, reasons: [] };

  const reasons: string[] = [];
  let reasonKey: string | undefined;

  if (policy.packageMatchers.length > 0) {
    const ecosystem = typeof ctx.ecosystem === 'string' ? ctx.ecosystem : undefined;
    const matcher = policy.packageMatchers.find((candidate) => candidate.match(ecosystem, ctx.name));
    if (!matcher) return { match: false, reasons: [] };
    reasons.push(`Package "${ctx.name}" matches ${policy.decision === 'ALLOW' ? 'allow' : 'block'} list`);
    reasonKey = matcher.pattern;
  }

  if (policy.versionRangeRaw) {
    const versionMatch = versionMatchesPolicy(
      typeof ctx.ecosystem === 'string' ? ctx.ecosystem : undefined,
      ctx.version,
      policy.versionRangeRaw,
      policy.decision
    );
    if (!versionMatch) return { match: false, reasons: [] };
    reasons.push(versionMatch.reason);
    reasonKey ??= policy.versionRangeRaw;
  }

  // Release type is string work only, so it runs before anything that loads facts.
  if (policy.releaseTypes) {
    const release = classifyRelease(String(ctx.ecosystem ?? ''), ctx.version);
    if (!policy.releaseTypes.has(release.type)) return { match: false, reasons: [] };
    reasons.push(releaseTypeReason(ctx.version, release));
    reasonKey ??= release.type;
  }

  if (policy.needsLicense) {
    if (!facts?.licenseKnown) return { match: false, reasons: [], need: 'license' };
    if (facts.metaUnavailable && !facts.license && !ctx.license) {
      return { match: false, reasons: [], unavailable: 'license' };
    }
    const licenseText = facts.license ?? ctx.license;
    const licenseMatch = licenseReasons(licenseText, policy.license!);
    if (licenseMatch.length === 0) return { match: false, reasons: [] };
    reasons.push(...licenseMatch);
    reasonKey ??= licenseReasonKey(licenseText);
  }

  if (policy.needsPublishedAt) {
    const versionDateKnown = Boolean(facts?.publishedKnown || ctx.publishedAt);
    // "Newer than N hours" is about this version, so the package's newest release date cannot stand in for it.
    // "No release in N days" is about the package, and that date is enough.
    const needsVersionDate = policy.releaseAgeMaxHours != null && !versionDateKnown;
    const needsPackageDate = policy.releaseAgeMinDays != null && !versionDateKnown && !ctx.packageLastReleaseAt;
    if (needsVersionDate || needsPackageDate) {
      return { match: false, reasons: [], need: 'published' };
    }
  }
  const publishedAt = facts?.publishedAt
    ? new Date(facts.publishedAt)
    : ctx.publishedAt
      ? new Date(ctx.publishedAt)
      : undefined;
  const lastReleaseAt = ctx.packageLastReleaseAt
    ? new Date(ctx.packageLastReleaseAt)
    : publishedAt;
  const ageReasons = releaseAgeReasons(publishedAt, lastReleaseAt, policy.releaseAgeMinDays, policy.releaseAgeMaxHours);
  if (ageReasons) {
    if (ageReasons.length === 0) {
      const unknownAge =
        (policy.releaseAgeMaxHours != null && !publishedAt) || (policy.releaseAgeMinDays != null && !lastReleaseAt);
      return { match: false, reasons: [], unavailable: unknownAge ? 'published' : undefined };
    }
    reasons.push(...ageReasons);
    const tooNew = policy.releaseAgeMaxHours != null && matchReleaseAgeMaxHours(publishedAt, policy.releaseAgeMaxHours);
    reasonKey ??= tooNew ? 'too_new' : 'unmaintained';
  }

  if (policy.needsCve) {
    if (!facts?.cveKnown || (policy.epss && !facts.epssKnown)) return { match: false, reasons: [], need: 'cve' };
    if (facts.cveUnavailable) return { match: false, reasons: [], unavailable: 'cve' };
    const outcome = evaluateVulnerabilities(
      facts.vulns ?? [],
      { cveBlockList: policy.cveBlockList, cvss: policy.cvss, epss: policy.epss },
      policy.epss ? { scores: facts.epss ?? new Map(), scoreDate: facts.epssDate ?? null } : null
    );
    if (!outcome) return { match: false, reasons: [] };
    reasons.push(...outcome.reasons);
    reasonKey ??= outcome.reasonKey;
  }

  if (policy.scorecard) {
    if (!facts?.scorecard) return { match: false, reasons: [], need: 'scorecard' };
    const outcome = scorecardOutcome(facts.scorecard, policy.scorecard, ctx.name);
    const unavailable: FactSlot | undefined = outcome.unavailable ? 'scorecard' : undefined;
    if (!outcome.match) return { match: false, reasons: [], unavailable };
    reasons.push(...outcome.reasons);
    reasonKey ??= outcome.reasonKey;
    return { match: true, reasons, reasonKey, unavailable };
  }

  return { match: reasons.length > 0, reasons, reasonKey };
}

/**
 * Keep what earlier rounds learned. Without this, a later round that loads only CVE data
 * would forget the license, ask for it again, and could exhaust the round limit and allow.
 */
function mergeFacts(previous: VersionFacts | undefined, next: VersionFacts): VersionFacts {
  if (!previous) return next;
  const merged: VersionFacts = { ...next };
  if (previous.licenseKnown && !next.licenseKnown) {
    merged.license = previous.license;
    merged.licenseKnown = true;
  }
  if (previous.publishedKnown && !next.publishedKnown) {
    merged.publishedAt = previous.publishedAt;
    merged.publishedKnown = true;
  }
  if (previous.cveKnown && !next.cveKnown) {
    merged.vulns = previous.vulns;
    merged.cveKnown = true;
    merged.cveUnavailable = previous.cveUnavailable;
  }
  if (previous.epssKnown && !next.epssKnown) {
    merged.epss = previous.epss;
    merged.epssDate = previous.epssDate;
    merged.epssKnown = true;
  }
  if (previous.scorecard && !next.scorecard) merged.scorecard = previous.scorecard;
  if (previous.metaUnavailable && !next.licenseKnown && !next.publishedKnown) merged.metaUnavailable = true;
  merged.packageLastReleaseAt = next.packageLastReleaseAt ?? previous.packageLastReleaseAt;
  return merged;
}

export function maliciousResult(reason: string | undefined, name: string): PolicyResult {
  return {
    decision: 'BLOCK',
    policyId: 'malicious',
    policyName: 'Malicious packages list',
    reasons: [reason ?? `Package "${name}" is in the malicious packages list`],
    remediation:
      'Contact your administrator to review or override the malicious package entry if this is a false positive.',
  };
}

export async function evaluatePackageVersions(
  db: DataSource,
  ecosystem: string,
  pkg: string,
  versions: VersionEvaluation[],
  redis?: Redis | null,
  packageLastReleaseAt?: string,
  options?: EvaluateOptions
): Promise<Map<string, PolicyResult | null>> {
  return evaluateVersions(db, ecosystem, pkg, versions, redis, packageLastReleaseAt, options, {});
}

/**
 * The same evaluation as a download, plus the facts used, the policies that could not
 * be evaluated, and (with `monitor`) what monitoring policies would block, per version.
 * Reads only: no ledger rows, webhooks or monitor rows.
 */
export async function evaluatePackageVersionsDetailed(
  db: DataSource,
  ecosystem: string,
  pkg: string,
  versions: VersionEvaluation[],
  redis?: Redis | null,
  packageLastReleaseAt?: string,
  options?: EvaluateOptions
): Promise<{
  results: Map<string, PolicyResult | null>;
  details: Map<string, VersionDetail>;
  monitor: Map<string, MonitorMatch[]>;
}> {
  const details = new Map<string, VersionDetail>();
  const monitor = new Map<string, MonitorMatch[]>();
  const results = await evaluateVersions(db, ecosystem, pkg, versions, redis, packageLastReleaseAt, options, {
    details,
    monitor,
  });
  return { results, details, monitor };
}

type EvaluationOutput = {
  details?: Map<string, VersionDetail>;
  /** Monitor matches of versions whose final decision is allowed. */
  monitor?: Map<string, MonitorMatch[]>;
  /** Every monitor match, also of versions an enforced policy blocks (for BLOCK_MONITOR events). */
  monitorAll?: Map<string, MonitorMatch[]>;
  /** What the event of a download names without another lookup (R-P2, R-P6). */
  facts?: Map<string, DownloadFacts>;
};

/** The malware list entry and the exception behind a download's decision, from the rows the engine already loaded. */
export type DownloadFacts = {
  malware?: MalwareHit;
  exception?: { id: string; reason: string | null };
};

/**
 * Unexpired exceptions for one package: one query per package until an exception or a policy is
 * written or the reference max age passes. A kept list is loaded again once one of its rows expires.
 */
function activeExceptions(db: DataSource, ecosystem: string, pkg: string, verify?: boolean): Promise<Exception[]> {
  const packageName = canonicalPackageName(ecosystem, pkg);
  return readReferenceEntry(
    'exceptions',
    `${ecosystem}\0${packageName}`,
    () =>
      db
        .getRepository(Exception)
        .createQueryBuilder('e')
        .where('e.ecosystem = :ecosystem', { ecosystem })
        .andWhere('e.packageName = :packageName', { packageName })
        .andWhere('e.expiresAt > :now', { now: new Date() })
        .getMany(),
    { verify, isValid: (rows) => rows.every((row) => row.expiresAt.getTime() > Date.now()) }
  );
}

async function evaluateVersions(
  db: DataSource,
  ecosystem: string,
  pkg: string,
  versions: VersionEvaluation[],
  redis: Redis | null | undefined,
  packageLastReleaseAt: string | undefined,
  options: EvaluateOptions | undefined,
  out: EvaluationOutput
): Promise<Map<string, PolicyResult | null>> {
  const details = out.details ?? null;
  const monitorOn = options?.monitor === true;
  const results = new Map<string, PolicyResult | null>();
  if (versions.length === 0) return results;

  const verify = options?.verifyPolicies;
  const [exceptions, malicious, policies] = await Promise.all([
    activeExceptions(db, ecosystem, pkg, verify),
    findMaliciousEntryCached(db, ecosystem, pkg, { verify }),
    getCompiledPolicies(db, options),
  ]);

  type Pending = {
    item: VersionEvaluation;
    ctx: PackageContext;
  };
  // Scope (R5): a policy on a remote covers what that remote serves, through any repository URL.
  // Only scopes that name a member remote but not the URL's repository need the serving remote.
  const route = options?.route;
  const scope = await scopeContext(
    [...policies.map((policy) => policy.repositoryIds), ...exceptions.map((row) => scopeIds(row.repositoryIds))],
    () => repositoryIdFor(db, ecosystem, options?.repoKey || 'default'),
    route?.targets,
    route?.servingSource
  );
  const inScope = policies.filter((policy) => policyCovers(policy.repositoryIds, scope));
  // An exception with a policy only stops that policy matching; the rest cover every policy.
  const globalExceptions: Exception[] = [];
  const scopedExceptions = new Map<string, Exception[]>();
  for (const row of exceptions) {
    if (!exceptionCovers(scopeIds(row.repositoryIds), scope)) continue;
    if (!row.policyId) {
      globalExceptions.push(row);
      continue;
    }
    const list = scopedExceptions.get(row.policyId);
    if (list) list.push(row);
    else scopedExceptions.set(row.policyId, [row]);
  }

  const pending: Pending[] = [];
  const namespaceBlock = options?.namespaceBlock ?? options?.route?.block ?? null;
  const factsOut = out.facts ?? null;
  const noteFacts = (version: string, patch: DownloadFacts) => {
    if (!factsOut) return;
    factsOut.set(version, { ...factsOut.get(version), ...patch });
  };
  for (const item of versions) {
    if (factsOut) {
      const listed = malwareListed(malicious, item.version);
      if (listed) noteFacts(item.version, { malware: listed });
    }
    if (namespaceBlock) {
      const maliciousHit = maliciousMatch(malicious, item.version);
      results.set(item.version, maliciousHit.blocked ? maliciousResult(maliciousHit.reason, pkg) : namespaceBlock);
      continue;
    }
    const exception = matchingException(globalExceptions, item.version, ecosystem);
    if (exception) {
      noteFacts(item.version, { exception: { id: exception.id, reason: exception.reason ?? null } });
      results.set(item.version, null);
      continue;
    }
    const maliciousHit = maliciousMatch(malicious, item.version);
    if (maliciousHit.blocked) {
      results.set(item.version, maliciousResult(maliciousHit.reason, pkg));
      continue;
    }
    const published = item.versionMeta ? getPublishedTime(item.versionMeta)?.toISOString() : undefined;
    pending.push({
      item,
      ctx: {
        name: pkg,
        version: item.version,
        ecosystem,
        license: item.versionMeta ? getLicense(item.versionMeta) : undefined,
        publishedAt: published,
        packageLastReleaseAt,
      },
    });
  }

  const factMap = new Map<string, VersionFacts>();
  // Each round loads at least one missing fact type, and facts merge across rounds,
  // so four fact types settle within five rounds.
  let guard = 0;
  while (pending.length > 0 && guard < 6) {
    guard += 1;
    const need = noNeeds();
    const waiting: Pending[] = [];
    for (const entry of pending) {
      const facts = factMap.get(entry.item.version);
      let decided = false;
      let waits = false;
      let blocked = false;
      const incomplete: FactSlot[] = [];
      const noted: MonitorMatch[] = [];
      let skippedBy: Exception | undefined;
      for (const policy of inScope) {
        const monitoring = policy.mode === 'monitor';
        if (monitoring && !monitorOn) continue;
        if (scopedExceptions.size > 0) {
          const own = scopedExceptions.get(policy.id);
          const scoped = own ? matchingException(own, entry.item.version, ecosystem) : undefined;
          if (scoped) {
            if (!monitoring) skippedBy ??= scoped;
            continue;
          }
        }
        const outcome = matchCompiled(entry.ctx, policy, facts);
        if (outcome.need) {
          noteNeed(need, outcome.need, policy);
          waiting.push(entry);
          decided = true;
          waits = true;
          break;
        }
        // A monitoring policy never blocks, so its missing facts do not make the answer incomplete.
        if (outcome.unavailable && !monitoring && !incomplete.includes(outcome.unavailable)) {
          incomplete.push(outcome.unavailable);
        }
        if (outcome.match) {
          if (monitoring) {
            noted.push({
              policyId: policy.id,
              policyName: policy.name,
              reasons: outcome.reasons,
              reasonKey: outcome.reasonKey ?? 'match',
              modeEpoch: policy.modeEpoch,
            });
            continue;
          }
          results.set(entry.item.version, policyResult(policy, outcome.reasons));
          decided = true;
          blocked = policy.decision === 'BLOCK';
          break;
        }
      }
      if (!decided) results.set(entry.item.version, null);
      if (!waits && skippedBy && !results.get(entry.item.version)) {
        noteFacts(entry.item.version, { exception: { id: skippedBy.id, reason: skippedBy.reason ?? null } });
      }
      if (out.monitorAll && !waits && noted.length > 0) out.monitorAll.set(entry.item.version, noted);
      if (details && !waits) details.set(entry.item.version, { incomplete, facts });
      // Only new breakage: a version a lower enforced policy blocks anyway is not recorded.
      if (out.monitor && !waits && !blocked && noted.length > 0) out.monitor.set(entry.item.version, noted);
    }
    if (waiting.length === 0) break;
    if (!anyNeed(need)) {
      for (const entry of waiting) results.set(entry.item.version, null);
      break;
    }
    const seeded = new Map<string, SeededFacts>();
    for (const entry of waiting) {
      if (!entry.item.versionMeta) continue;
      // A version document always settles the license. Publish time counts only when the
      // document had one: an abbreviated npm document, for example, may not.
      const seed: SeededFacts = {
        license: entry.ctx.license,
        publishedAt: entry.ctx.publishedAt,
        licenseKnown: true,
        publishedKnown: entry.ctx.publishedAt !== undefined,
      };
      // An abbreviated npm document has no repository; the Scorecard lookup then reads the full one.
      const repository = ecosystem === 'npm' ? npmRepositorySeed(entry.item.versionMeta) : undefined;
      if (repository) seed.repository = repository;
      seeded.set(entry.item.version, seed);
    }
    const loaded = await loadVersionFacts(
      db,
      redis ?? null,
      ecosystem,
      pkg,
      waiting.map((entry) => entry.item.version),
      need,
      options?.repoKey || 'default',
      seeded,
      options?.route
    );
    let newest = packageLastReleaseAt;
    for (const fact of loaded.values()) {
      for (const candidate of [fact.packageLastReleaseAt, fact.publishedAt]) {
        if (!candidate) continue;
        if (!newest || Date.parse(candidate) > Date.parse(newest)) newest = candidate;
      }
    }
    for (const entry of waiting) {
      const fact = loaded.get(entry.item.version);
      if (fact) factMap.set(entry.item.version, mergeFacts(factMap.get(entry.item.version), fact));
      if (!entry.ctx.packageLastReleaseAt && newest) entry.ctx.packageLastReleaseAt = newest;
      if (fact?.license && !entry.ctx.license) entry.ctx.license = fact.license;
      if (fact?.publishedAt && !entry.ctx.publishedAt) entry.ctx.publishedAt = fact.publishedAt;
    }
    pending.length = 0;
    pending.push(...waiting);
  }
  for (const entry of pending) {
    if (!results.has(entry.item.version)) results.set(entry.item.version, null);
  }
  if (details) {
    for (const item of versions) {
      if (!details.has(item.version)) details.set(item.version, { incomplete: [], facts: factMap.get(item.version) });
    }
  }
  return results;
}

/**
 * The artifact download path: the decision, plus what monitoring policies would have blocked
 * when the decision is to allow. The caller records the matches; this function writes nothing.
 */
export async function evaluateDownloadVersion(
  db: DataSource,
  ecosystem: string,
  pkg: string,
  version: string,
  versionMeta?: PackumentVersion,
  redis?: Redis | null,
  packageLastReleaseAt?: string,
  options?: EvaluateOptions
): Promise<{
  result: PolicyResult | null;
  monitorMatches: MonitorMatch[];
  /** Every monitor match, including those of a version an enforced policy blocks. */
  allMonitorMatches: MonitorMatch[];
  facts: DownloadFacts;
}> {
  const monitor = new Map<string, MonitorMatch[]>();
  const monitorAll = new Map<string, MonitorMatch[]>();
  const facts = new Map<string, DownloadFacts>();
  const decided = await evaluateVersions(
    db,
    ecosystem,
    pkg,
    [{ version, versionMeta }],
    redis,
    packageLastReleaseAt,
    { ...options, monitor: true },
    { monitor, monitorAll, facts }
  );
  return {
    result: decided.get(version) ?? null,
    monitorMatches: monitor.get(version) ?? [],
    allMonitorMatches: monitorAll.get(version) ?? [],
    facts: facts.get(version) ?? {},
  };
}

/** Whether one policy's rule matches a version, or `unknown` when a fact it needs could not be read. */
export type PolicyVersionMatch = { match: true; reasons: string[]; reasonKey: string } | { match: false } | { match: 'unknown' };

/**
 * One policy against stored versions, ignoring every other policy and exception. Facts come
 * from the same caches as a download. Used to recheck monitor rows after the rule changed.
 */
export async function matchPolicyVersions(
  db: DataSource,
  redis: Redis | null | undefined,
  policy: CompiledPolicy,
  ecosystem: string,
  pkg: string,
  versions: string[],
  repoKey = 'default'
): Promise<Map<string, PolicyVersionMatch>> {
  const out = new Map<string, PolicyVersionMatch>();
  if (policy.namespace) {
    // Rows were recorded when a public remote served the name; the new rule decides only whether the name is still reserved.
    const canonical = canonicalName(ecosystem, pkg);
    const pattern = policy.namespace.publicPackages.some((matches) => matches(canonical))
      ? null
      : firstMatchingPattern(ecosystem, policy.namespace.patterns, pkg);
    for (const version of versions) {
      out.set(
        version,
        pattern
          ? {
              match: true,
              reasons: [
                `Served from ${policy.namespace.allowedRemoteIds ? 'a remote that is not allowed' : 'a public remote'}; enforcing would block it (reserved namespace "${pattern.raw}")`,
              ],
              reasonKey: `namespace:${pattern.raw}`,
            }
          : { match: false }
      );
    }
    return out;
  }
  const ctxs = new Map<string, PackageContext>(
    versions.map((version) => [version, { name: pkg, version, ecosystem }])
  );
  const factMap = new Map<string, VersionFacts>();
  let pending = [...versions];
  for (let round = 0; round < 6 && pending.length > 0; round += 1) {
    const need = noNeeds();
    const waiting: string[] = [];
    for (const version of pending) {
      const outcome = matchCompiled(ctxs.get(version)!, policy, factMap.get(version));
      if (outcome.need) {
        noteNeed(need, outcome.need, policy);
        waiting.push(version);
        continue;
      }
      if (outcome.match) {
        out.set(version, { match: true, reasons: outcome.reasons, reasonKey: outcome.reasonKey ?? 'match' });
      } else {
        out.set(version, outcome.unavailable ? { match: 'unknown' } : { match: false });
      }
    }
    if (waiting.length === 0) break;
    const loaded = await loadVersionFacts(db, redis ?? null, ecosystem, pkg, waiting, need, repoKey);
    let newest: string | undefined;
    for (const fact of loaded.values()) {
      for (const candidate of [fact.packageLastReleaseAt, fact.publishedAt]) {
        if (candidate && (!newest || Date.parse(candidate) > Date.parse(newest))) newest = candidate;
      }
    }
    for (const version of waiting) {
      const fact = loaded.get(version);
      if (fact) factMap.set(version, mergeFacts(factMap.get(version), fact));
      const ctx = ctxs.get(version)!;
      if (!ctx.packageLastReleaseAt && newest) ctx.packageLastReleaseAt = newest;
      if (fact?.license && !ctx.license) ctx.license = fact.license;
      if (fact?.publishedAt && !ctx.publishedAt) ctx.publishedAt = fact.publishedAt;
    }
    pending = waiting;
  }
  for (const version of pending) if (!out.has(version)) out.set(version, { match: 'unknown' });
  return out;
}

export async function evaluatePackageVersion(
  db: DataSource,
  ecosystem: string,
  pkg: string,
  version: string,
  versionMeta?: PackumentVersion,
  redis?: Redis | null,
  packageLastReleaseAt?: string,
  options?: EvaluateOptions
): Promise<PolicyResult | null> {
  const decided = await evaluatePackageVersions(
    db,
    ecosystem,
    pkg,
    [{ version, versionMeta }],
    redis,
    packageLastReleaseAt,
    options
  );
  return decided.get(version) ?? null;
}

function getPackageLastReleaseAt(versions: Record<string, PackumentVersion>): string | undefined {
  let latest: Date | undefined;
  for (const meta of Object.values(versions)) {
    const t = getPublishedTime(meta);
    if (t && (!latest || t > latest)) latest = t;
  }
  return latest?.toISOString();
}

export async function filterPackumentVersions(
  db: DataSource,
  ecosystem: string,
  packument: { name?: string; time?: unknown; versions?: Record<string, PackumentVersion> },
  redis?: Redis | null,
  options?: EvaluateOptions
): Promise<{
  filtered: Record<string, PackumentVersion>;
  blockedVersions: Record<string, PolicyResult>;
}> {
  const versions = packument.versions ?? {};
  const filtered: Record<string, PackumentVersion> = {};
  const blockedVersions: Record<string, PolicyResult> = {};
  const name = packument.name ?? '';
  const timeMap = packumentTimeMap(packument);
  const packageLastReleaseAt = latestVersionPublishTime(timeMap) ?? getPackageLastReleaseAt(versions);
  const inputs = Object.entries(versions).map(([ver, rawMeta]) => ({
    version: ver,
    versionMeta: withVersionPublishTime(rawMeta, ver, timeMap) ?? rawMeta,
  }));
  const decided = await evaluatePackageVersions(
    db,
    ecosystem,
    name,
    inputs,
    redis,
    packageLastReleaseAt,
    options
  );

  for (const [ver, rawMeta] of Object.entries(versions)) {
    const result = decided.get(ver) ?? null;
    if (result?.decision === 'BLOCK') {
      blockedVersions[ver] = result;
    } else {
      filtered[ver] = rawMeta;
    }
  }
  return { filtered, blockedVersions };
}
