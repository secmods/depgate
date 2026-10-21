import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import {
  evaluateDownloadVersion,
  evaluatePackageVersion,
  type MonitorMatch,
  type PolicyResult,
} from './policy-engine.js';
import type { PackumentVersion } from './npm-packument.js';
import type { PackageRoute } from './namespace-protection.js';
import { monitorMatchesTotal, monitorRecordErrorsTotal, monitorRowsCappedTotal } from './monitor-metrics.js';
import { currentActor, currentServedSource, noteDownloadFacts } from './request-context.js';
import { recordEvent } from './events/record.js';

type WarnLog = { warn: (obj: unknown, msg?: string) => void };

/** Counts not yet folded into a row survive this long without another download. */
const COUNTER_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Longest version the monitor_hits.version column holds. */
const MAX_VERSION_LENGTH = 256;
/** A Redis or database outage would otherwise log once per download. */
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt = 0;

function usable(redis: Redis | null | undefined): redis is Redis {
  return !!redis && typeof redis.multi === 'function' && typeof redis.decrby === 'function';
}

/** TypeORM's Postgres driver returns [rows, rowCount] for UPDATE ... RETURNING and rows for INSERT. */
function returnedRows(raw: unknown): unknown[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number') return raw[0];
  return Array.isArray(raw) ? raw : [];
}

export type MonitorHitInput = {
  policyId: string;
  ecosystem: string;
  packageName: string;
  version: string;
  reasonKey: string;
  reasons: string[];
  /** Repository key the download went through. */
  repository?: string;
};

/** Most repository keys kept on one monitor row. */
const MAX_ROW_REPOSITORIES = 20;

/**
 * Adds `count` downloads to a version's row, creating it when it is new. Writes only while the
 * policy is still monitoring, and creates no row once the policy holds the row limit.
 * Returns false when the row was not stored because of the limit.
 */
export async function writeMonitorHit(db: DataSource, hit: MonitorHitInput, count: number): Promise<boolean> {
  const reasons = JSON.stringify(hit.reasons);
  const reasonKey = hit.reasonKey.slice(0, 512);
  const repository = JSON.stringify(hit.repository ? [hit.repository.slice(0, 128)] : []);
  const updated = await db.query(
    `UPDATE monitor_hits h
        SET hit_count = h.hit_count + $5, last_seen_at = now(), reason_key = $6, reasons = $7::jsonb,
            repositories = CASE
              WHEN h.repositories @> $8::jsonb OR jsonb_array_length(h.repositories) >= ${MAX_ROW_REPOSITORIES}
                THEN h.repositories
              ELSE h.repositories || $8::jsonb END
       FROM policies p
      WHERE p.id = h.policy_id AND p.mode = 'monitor'
        AND h.policy_id = $1 AND h.ecosystem = $2 AND h.package_name = $3 AND h.version = $4
      RETURNING h.id`,
    [hit.policyId, hit.ecosystem, hit.packageName, hit.version, count, reasonKey, reasons, repository]
  );
  if (returnedRows(updated).length > 0) return true;
  const cap = config.monitor.maxRowsPerPolicy;
  const inserted = await db.query(
    `INSERT INTO monitor_hits
       (id, policy_id, ecosystem, package_name, version, reason_key, reasons, first_seen_at, last_seen_at, hit_count,
        repositories)
     SELECT gen_random_uuid(), $1, $2, $3, $4, $6, $7::jsonb, now(), now(), $5, $9::jsonb
      WHERE EXISTS (SELECT 1 FROM policies WHERE id = $1 AND mode = 'monitor')
        AND (SELECT count(*) FROM (SELECT 1 FROM monitor_hits WHERE policy_id = $1 LIMIT $8) capped) < $8
     ON CONFLICT (policy_id, ecosystem, package_name, version)
     DO UPDATE SET hit_count = monitor_hits.hit_count + EXCLUDED.hit_count, last_seen_at = now()
     RETURNING id`,
    [hit.policyId, hit.ecosystem, hit.packageName, hit.version, count, reasonKey, reasons, cap, repository]
  );
  if (returnedRows(inserted).length > 0) return true;
  const monitoring: unknown[] = await db.query(`SELECT 1 FROM policies WHERE id = $1 AND mode = 'monitor'`, [
    hit.policyId,
  ]);
  if (monitoring.length === 0) return true;
  monitorRowsCappedTotal.inc({ policy: hit.policyId });
  return false;
}

/**
 * The first download of a version in a window writes its row; later ones in the same window
 * only INCR a Redis counter, and the next writer folds the counter in. One Redis round trip
 * per match, and the row write happens after the download was already decided.
 */
async function recordOne(
  db: DataSource,
  redis: Redis | null | undefined,
  hit: MonitorHitInput,
  modeEpoch: number
): Promise<void> {
  let count = 1;
  let counterKey: string | null = null;
  if (usable(redis)) {
    const base = `${hit.policyId}:${modeEpoch}:${hit.ecosystem}:${hit.packageName}:${hit.version}`;
    counterKey = `monitor:count:${base}`;
    const replies = await redis
      .multi()
      .set(`monitor:gate:${base}`, '1', 'EX', config.monitor.writeWindowSeconds, 'NX')
      .incr(counterKey)
      .expire(counterKey, COUNTER_TTL_SECONDS)
      .exec();
    if (!replies) throw new Error('Redis transaction was aborted');
    const [gateErr, gate] = replies[0] ?? [];
    const [countErr, pending] = replies[1] ?? [];
    if (gateErr) throw gateErr;
    if (countErr) throw countErr;
    if (gate !== 'OK') return;
    count = Math.max(Number(pending) || 1, 1);
  }
  await writeMonitorHit(db, hit, count);
  // Downloads counted while this write ran stay in the counter for the next writer.
  if (counterKey && usable(redis)) await redis.decrby(counterKey, count);
}

/** What actually happened to a download a Monitor-mode policy matched (BLOCK_MONITOR `details.finalDecision`). */
export type FinalDecision = { decision: 'ALLOW' } | { decision: 'BLOCK_ENFORCE'; policyId: string; policyName: string };

/**
 * One BLOCK_MONITOR event per matching Monitor-mode policy (requirements_event_streaming.md §6.3).
 * Not stored: monitor_hits and the Monitoring page stay the record. The actor is read before any await.
 */
export function publishMonitorMatches(
  db: DataSource | null | undefined,
  ecosystem: string,
  packageName: string,
  version: string,
  matches: MonitorMatch[],
  repository: string | undefined,
  final: FinalDecision = { decision: 'ALLOW' }
): void {
  if (matches.length === 0) return;
  const actor = currentActor() ?? { kind: 'system' as const, name: 'DepGate' };
  const served = currentServedSource();
  const finalDecision =
    final.decision === 'ALLOW'
      ? { decision: 'ALLOW' }
      : { decision: 'BLOCK_ENFORCE', policyId: final.policyId, policyName: final.policyName };
  for (const match of matches) {
    recordEvent(db, {
      type: 'BLOCK_MONITOR',
      actor,
      target: { kind: 'package', ecosystem, name: packageName, version, repository: repository ?? null },
      policy: { id: match.policyId, name: match.policyName },
      reasons: match.reasons,
      details: {
        finalDecision,
        ...(served ? { source: { repository: served.sourceRepository, type: served.sourceType } } : {}),
      },
    });
  }
}

/**
 * Fire-and-forget: a failure is logged and counted, never thrown, so the download goes on.
 * Returns the pending writes for tests.
 */
export function recordMonitorMatches(
  db: DataSource,
  redis: Redis | null | undefined,
  ecosystem: string,
  packageName: string,
  version: string,
  matches: MonitorMatch[],
  log?: WarnLog,
  repository?: string
): Promise<void> {
  if (matches.length === 0 || version.length > MAX_VERSION_LENGTH) return Promise.resolve();
  publishMonitorMatches(db, ecosystem, packageName, version, matches, repository);
  const writes = matches.map((match) => {
    monitorMatchesTotal.inc({ ecosystem });
    const hit: MonitorHitInput = {
      policyId: match.policyId,
      ecosystem,
      packageName,
      version,
      reasonKey: match.reasonKey,
      reasons: match.reasons,
      repository,
    };
    return recordOne(db, redis, hit, match.modeEpoch ?? 0).catch((err) => {
      monitorRecordErrorsTotal.inc();
      const now = Date.now();
      if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
        lastErrorLogAt = now;
        log?.warn({ err, policyId: match.policyId, ecosystem, packageName, version }, 'Monitor match not recorded');
      }
    });
  });
  return Promise.all(writes).then(() => undefined);
}

export type DownloadEvaluation = {
  versionMeta?: PackumentVersion;
  packageLastReleaseAt?: string;
  repoKey?: string;
  /**
   * False for requests that are not the package itself (Go .info/.mod, Maven POMs and checksums):
   * they are decided as before and monitoring policies neither load facts nor record for them.
   */
  monitor?: boolean;
  /** The request's route. Its namespace block decides before every policy except the malicious packages list. */
  route?: PackageRoute;
};

/**
 * The policy decision for an artifact download. When the gateway allows it and monitoring
 * policies would have blocked it, the matches are recorded in the background.
 */
export async function evaluateDownload(
  app: Pick<FastifyInstance, 'db' | 'redis' | 'log'>,
  ecosystem: string,
  packageName: string,
  version: string,
  options: DownloadEvaluation
): Promise<PolicyResult | null> {
  if (options.monitor === false) {
    return evaluatePackageVersion(
      app.db,
      ecosystem,
      packageName,
      version,
      options.versionMeta,
      app.redis,
      options.packageLastReleaseAt,
      { repoKey: options.repoKey, route: options.route }
    );
  }
  const { result, monitorMatches, allMonitorMatches, facts } = await evaluateDownloadVersion(
    app.db,
    ecosystem,
    packageName,
    version,
    options.versionMeta,
    app.redis,
    options.packageLastReleaseAt,
    { repoKey: options.repoKey, route: options.route }
  );
  noteDownloadFacts(facts);
  if (result?.decision === 'BLOCK' && allMonitorMatches.length > 0) {
    publishMonitorMatches(app.db, ecosystem, packageName, version, allMonitorMatches, options.repoKey || 'default', {
      decision: 'BLOCK_ENFORCE',
      policyId: result.policyId,
      policyName: result.policyName,
    });
  }
  if (monitorMatches.length > 0 && result?.decision !== 'BLOCK') {
    void recordMonitorMatches(
      app.db,
      app.redis,
      ecosystem,
      packageName,
      version,
      monitorMatches,
      app.log,
      options.repoKey || 'default'
    );
  }
  return result;
}
