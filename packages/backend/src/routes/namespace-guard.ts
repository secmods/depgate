import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  isPrivateName,
  namespaceMonitorMatches,
  namespaceNotFoundResult,
  remoteLabel,
  resolvePackageTargets,
  shouldRecordNotFound,
  targetForUrl,
  type PackageRoute,
} from '../services/namespace-protection.js';
import type { RemoteTarget } from '../services/repository-resolve.js';
import { probeServingRemote, type UpstreamFetchOptions } from '../services/upstream-provider.js';
import { readUpstreamText } from '../services/package-facts.js';
import { repoKeyFromRaw } from '../services/repo-keys.js';
import { isMaliciousPackage } from '../services/malicious-sync.js';
import { maliciousResult, type PolicyResult } from '../services/policy-engine.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import { recordDownloadAllowed, recordDownloadBlocked, type DownloadSubject } from '../services/events/download-events.js';
import { recordMonitorMatches } from '../services/monitor-recorder.js';
import { noteServedSource } from '../services/request-context.js';

type App = Pick<FastifyInstance, 'db' | 'redis' | 'log'> & { metrics?: { recordDecision?: (d: string) => void } };

/** The route of a package request on the repository in its URL. */
export function packageRoute(app: App, request: FastifyRequest, ecosystem: string, name: string | null | undefined): Promise<PackageRoute> {
  return resolvePackageTargets(app.db, ecosystem, repoKeyFromRaw(request.raw), name);
}

function record(app: App, route: PackageRoute, result: PolicyResult, version: string | null): void {
  recordDownloadBlocked(app, { ecosystem: route.ecosystem, packageName: route.packageName ?? '', version }, result, {
    webhookPayload: {
      event: 'package_blocked',
      timestamp: new Date().toISOString(),
      ecosystem: route.ecosystem,
      packageName: route.packageName,
      version,
      decision: 'BLOCK',
      policyId: result.policyId,
      policyName: result.policyName,
      reasons: result.reasons,
    },
  });
}

/**
 * 403 for a metadata request whose name no internal remote of the repository can serve (§6.2 step 2),
 * with a ledger row and a `package_blocked` webhook. A whole-package malware entry is named first (D8).
 */
export async function denyNamespace(
  app: App,
  request: FastifyRequest,
  reply: FastifyReply,
  route: PackageRoute,
  version: string | null = null
): Promise<FastifyReply> {
  let result = route.block!;
  const malware = await isMaliciousPackage(app.db, route.ecosystem, route.packageName ?? '', version ?? undefined).catch(() => null);
  if (malware?.blocked) result = maliciousResult(malware.reason, route.packageName ?? '');
  record(app, route, result, version);
  return sendPolicyDenial(reply, result, {
    statusMessage: route.ecosystem === 'npm' ? 'Forbidden' : undefined,
    check: { ecosystem: route.ecosystem, packageName: route.packageName ?? '', version: version ?? '', repository: route.repoKey },
  });
}

/**
 * Whether an upstream 404 is the D6 case: a reserved name no internal remote has. Then the client
 * gets a plain 404, and the ledger gets a BLOCK row saying public remotes were not consulted.
 */
export async function notFoundInternally(
  app: App,
  request: FastifyRequest,
  reply: FastifyReply,
  route: PackageRoute,
  version: string | null,
  body: Record<string, unknown> = { error: 'Package not found' }
): Promise<FastifyReply | null> {
  const result = namespaceNotFoundResult(route);
  if (!result) return null;
  if (await shouldRecordNotFound(app.redis, route, version)) {
    recordDownloadBlocked(app, { ecosystem: route.ecosystem, packageName: route.packageName ?? '', version }, result);
  }
  return reply.status(404).send({ ...body, reasons: result.reasons });
}

/**
 * After an artifact was fetched: record the serving remote for the ledger row (`sourceRepository`),
 * and the hit of each monitor-mode namespace policy when a public remote served a reserved name.
 */
export function noteServed(
  app: App,
  route: PackageRoute,
  source: Pick<RemoteTarget, 'id' | 'key' | 'source'> | null | undefined,
  version: string | null,
  opts: { artifact?: boolean } = {}
): void {
  if (!source) return;
  noteServedSource({ sourceRepository: remoteLabel(route.ecosystem, source), sourceType: source.source });
  if (!opts.artifact || !version || !route.packageName || !isPrivateName(route)) return;
  const matches = namespaceMonitorMatches(route, source);
  if (matches.length === 0) return;
  void recordMonitorMatches(app.db, app.redis, route.ecosystem, route.packageName, version, matches, app.log, route.repoKey);
}

/**
 * What every served package file records, from the artifact cache or from upstream (requirements_artifact_cache.md F4):
 * the remote it came from, for the ledger and the namespace monitors (noteServed), and the download, for the dashboard
 * and the stream (recordDownloadAllowed). `artifact` false is a side file read alongside the package (a Maven POM,
 * Go `.info` and `.mod`): no monitor hit and, unless `download` says so, no download count.
 */
export function noteArtifactServed(
  app: App,
  route: PackageRoute,
  source: Pick<RemoteTarget, 'id' | 'key' | 'source'> | null | undefined,
  subject: DownloadSubject,
  policy: PolicyResult | null,
  opts: { artifact?: boolean; download?: boolean } = {}
): void {
  const artifact = opts.artifact ?? true;
  noteServed(app, route, source, subject.version, { artifact });
  if (opts.download ?? artifact) recordDownloadAllowed(app, subject, policy);
}

/**
 * The remote a file URL found in cached metadata belongs to, among the route's targets: the remote
 * whose metadata listed it, or the remote whose URL it starts with. Null when none of the targets is
 * it, which for an enforced reserved name means the URL came from a public remote.
 */
export function servingTarget(route: PackageRoute, listedBy: string | undefined, url: string): RemoteTarget | null {
  if (listedBy) {
    const listed = route.targets.find((target) => target.id === listedBy);
    if (listed) return listed;
    if (route.reserved) return null;
  }
  return targetForUrl(route.targets, url);
}

/** R5: the route's packages come from the remote that served this cached metadata document. */
export function trackDocumentSource(route: PackageRoute, fromUrl: string | null | undefined): void {
  const source = targetForUrl(route.targets, fromUrl);
  route.servingSource = async () => source;
}

/** R5: the route's package comes from this remote, e.g. the one whose metadata listed the file. */
export function trackKnownSource(route: PackageRoute, source: RemoteTarget | null): void {
  route.servingSource = async () => source;
}

/**
 * R5 for an artifact fetched by first hit (Go, Maven, NuGet, Cargo, RubyGems `gems/`, npm without a
 * packument record). Looked up only if a policy decision needs it: the remote that serves the
 * package's metadata document `metadataPath` (cached, shared by every version, and the remote a
 * client resolving the package would read), or without one a probe of the file. The returned
 * function gives fetch options pinned to that remote, so the remote judged is the remote that serves.
 */
export function trackArtifactSource(
  app: Pick<FastifyInstance, 'db' | 'redis'>,
  route: PackageRoute,
  path: string,
  metadataPath?: string,
  basePath = ''
): () => Promise<UpstreamFetchOptions> {
  let probed: Promise<RemoteTarget | null> | null = null;
  if (route.targets.length > 1) {
    const lookup = metadataPath
      ? () =>
          readUpstreamText(app.db, app.redis, route, metadataPath).then((doc) =>
            doc ? targetForUrl(route.targets, doc.fromUrl) : null
          )
      : () => probeServingRemote(app.db, route.ecosystem, path, route.targets, basePath);
    route.servingSource = () => (probed ??= lookup());
  }
  return async () => {
    const pinned = probed ? await probed : null;
    return pinned ? { targets: [pinned], basePath: basePath || undefined } : { route, basePath: basePath || undefined };
  };
}
