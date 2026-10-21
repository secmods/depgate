import type { PackageRepositoryRow } from '../services/repository.service';

/** The keys with the one at `index` moved by `delta` (-1 up, +1 down). Out of range: unchanged. */
export function moveKey(keys: readonly string[], index: number, delta: number): string[] {
  const target = index + delta;
  if (index < 0 || index >= keys.length || target < 0 || target >= keys.length) return [...keys];
  const out = [...keys];
  [out[index], out[target]] = [out[target], out[index]];
  return out;
}

/**
 * R4: a public remote searched before an internal one. A package published on the public registry
 * under one of the company's internal names would then be taken from it. Null when the order is safe.
 */
export function orderWarning(orderedKeys: readonly string[], rows: readonly PackageRepositoryRow[]): string | null {
  const byKey = new Map(rows.filter((row) => row.type === 'remote').map((row) => [row.key, row]));
  const ordered = orderedKeys.map((key) => byKey.get(key)).filter((row): row is PackageRepositoryRow => !!row);
  const lastInternal = ordered.map((row) => row.source).lastIndexOf('internal');
  if (lastInternal < 0) return null;
  const firstPublic = ordered.findIndex((row) => row.source !== 'internal');
  if (firstPublic < 0 || firstPublic > lastInternal) return null;
  const publicRow = ordered[firstPublic];
  const internalRow = ordered[lastInternal];
  return `Public registry ${publicRow.key} is searched before internal ${internalRow.key}. A package published on ${hostOf(publicRow.upstreamUrl)} under one of your internal names would be taken from it. Move internal remotes first.`;
}

function hostOf(url: string | null): string {
  try {
    return url ? new URL(url).hostname : 'the public registry';
  } catch {
    return 'the public registry';
  }
}
