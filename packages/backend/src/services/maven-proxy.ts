export type MavenParsedPath =
  | {
      type: 'metadata';
      groupId: string;
      artifactId: string;
      packageName: string;
      path: string;
    }
  | {
      type: 'artifact';
      groupId: string;
      artifactId: string;
      version: string;
      packageName: string;
      fileName: string;
      path: string;
    };

export function parseMavenPath(path: string): MavenParsedPath | null {
  const cleaned = (path ?? '').replace(/^\/+/, '');
  if (!cleaned) return null;
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 3) return null;

  if (parts[parts.length - 1] === 'maven-metadata.xml') {
    const artifactId = parts[parts.length - 2];
    const groupParts = parts.slice(0, -2);
    if (!artifactId || groupParts.length === 0) return null;
    const groupId = groupParts.join('.');
    return {
      type: 'metadata',
      groupId,
      artifactId,
      packageName: `${groupId}:${artifactId}`,
      path: cleaned,
    };
  }

  if (parts.length < 4) return null;
  const fileName = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const artifactId = parts[parts.length - 3];
  const groupParts = parts.slice(0, -3);
  if (!artifactId || !version || !fileName || groupParts.length === 0) return null;
  const groupId = groupParts.join('.');
  return {
    type: 'artifact',
    groupId,
    artifactId,
    version,
    packageName: `${groupId}:${artifactId}`,
    fileName,
    path: cleaned,
  };
}

export function extractMavenMetadataVersions(xml: string): string[] {
  const versions: string[] = [];
  const re = /<version>\s*([^<\s]+)\s*<\/version>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    versions.push(match[1]);
  }
  return versions;
}

function replaceTagValue(xml: string, tag: 'latest' | 'release', value: string | null): string {
  if (value == null) {
    return xml.replace(new RegExp(`<${tag}>[^<]*<\\/${tag}>`, 'gi'), '');
  }
  return xml.replace(new RegExp(`(<${tag}>)[^<]*(<\\/${tag}>)`, 'gi'), `$1${value}$2`);
}

export function filterMavenMetadataXml(xml: string, blockedVersions: Set<string>): string {
  if (blockedVersions.size === 0) return xml;
  let out = xml;
  for (const version of blockedVersions) {
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`<version>\\s*${escaped}\\s*<\\/version>`, 'gi'), '');
  }

  const remaining = extractMavenMetadataVersions(out);
  const latest = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  out = replaceTagValue(out, 'latest', latest);
  out = replaceTagValue(out, 'release', latest);
  return out;
}

/** Files next to an artifact that are not the artifact: checksums, signatures, POMs and Gradle module metadata. */
const MAVEN_SIDE_FILE = /\.(sha1|sha256|sha512|md5|asc|sig|pom|module)$/i;

/**
 * The package itself (jar, aar, war, ...), not a file a build reads alongside it. Monitoring
 * policies record only these, so one install counts once instead of once per side file.
 */
export function isMavenPrimaryArtifact(fileName: string): boolean {
  return !MAVEN_SIDE_FILE.test(fileName);
}
