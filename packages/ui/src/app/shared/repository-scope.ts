import type { PackageRepositoryRow } from '../services/repository.service';

/** A repository a policy, exception or waiver is limited to, as the API returns it. */
export interface RepositoryRef {
  id: string;
  ecosystem: string;
  key: string;
  type: string;
}

/** `npm/prod`. */
export function repositoryLabel(ref: Pick<RepositoryRef, 'ecosystem' | 'key'>): string {
  return `${ref.ecosystem}/${ref.key}`;
}

/** "all repositories", or `npm/prod and npm/staging`. */
export function scopeText(refs: ReadonlyArray<Pick<RepositoryRef, 'ecosystem' | 'key'>>): string {
  if (refs.length === 0) return 'all repositories';
  const labels = refs.map(repositoryLabel);
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Repositories that can be chosen for something limited to `ecosystems` (empty: every ecosystem).
 * Never `all`: a policy on a remote already covers its packages through `all`, and one limited
 * to `all` would be skipped by switching to another URL (R5).
 */
export function selectableRepositories(rows: PackageRepositoryRow[], ecosystems: readonly string[]): PackageRepositoryRow[] {
  return rows.filter(
    (row) => !(row.type === 'virtual' && row.key === 'all') && (ecosystems.length === 0 || ecosystems.includes(row.ecosystem))
  );
}

/** IDs that are no longer offered after the ecosystem changed, so the form can say what it dropped. */
export function droppedByEcosystem(
  rows: PackageRepositoryRow[],
  selectedIds: readonly string[],
  ecosystems: readonly string[]
): PackageRepositoryRow[] {
  const allowed = new Set(selectableRepositories(rows, ecosystems).map((row) => row.id));
  return rows.filter((row) => selectedIds.includes(row.id) && !allowed.has(row.id));
}

/** Scoped IDs whose repository was deleted: kept by the server so the scope never widens. */
export function missingIds(ids: readonly string[] | undefined, refs: readonly RepositoryRef[] | undefined): string[] {
  const known = new Set((refs ?? []).map((ref) => ref.id));
  return (ids ?? []).filter((id) => !known.has(id));
}

/** Whether two scopes share a repository; an empty scope covers every repository. */
export function scopesOverlap(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (!a?.length || !b?.length) return true;
  return a.some((id) => b.includes(id));
}

/** What deleting a repository does to the policies, exceptions and waivers scoped to it, in sentences. */
export function deletionImpact(usage: {
  policies: Array<{ name: string; onlyRepository: boolean }>;
  exceptions: Array<{ packageName: string; version: string; onlyRepository: boolean }>;
  waivers: Array<{ packageName: string; version: string; onlyRepository: boolean }>;
  namespacePolicies?: Array<{ name: string; onlyRemote: boolean }>;
}): string[] {
  const lines: string[] = [];
  const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(', ');
  const disabled = usage.policies.filter((p) => p.onlyRepository).map((p) => p.name);
  const narrowed = usage.policies.filter((p) => !p.onlyRepository).map((p) => p.name);
  if (disabled.length) {
    lines.push(`${disabled.length === 1 ? 'Policy' : 'Policies'} ${quoted(disabled)} will be disabled: this is the only repository ${disabled.length === 1 ? 'it applies' : 'they apply'} to.`);
  }
  if (narrowed.length) {
    lines.push(`${narrowed.length === 1 ? 'Policy' : 'Policies'} ${quoted(narrowed)} will no longer apply to it.`);
  }
  const deleted = usage.exceptions.filter((e) => e.onlyRepository).map((e) => `${e.packageName}@${e.version}`);
  if (deleted.length) lines.push(`${deleted.length === 1 ? 'Exception' : 'Exceptions'} ${deleted.join(', ')} will be deleted.`);
  const rejected = usage.waivers.filter((w) => w.onlyRepository).map((w) => `${w.packageName}@${w.version}`);
  if (rejected.length) {
    lines.push(`Pending waiver ${rejected.length === 1 ? 'request' : 'requests'} ${rejected.join(', ')} will be rejected.`);
  }
  const stranded = (usage.namespacePolicies ?? []).filter((p) => p.onlyRemote).map((p) => p.name);
  if (stranded.length) {
    lines.push(
      `Namespace protection ${stranded.length === 1 ? 'policy' : 'policies'} ${quoted(stranded)} ${stranded.length === 1 ? 'allows' : 'allow'} only this remote: ${stranded.length === 1 ? 'its' : 'their'} names will be blocked everywhere until another remote is allowed.`
    );
  }
  return lines;
}
