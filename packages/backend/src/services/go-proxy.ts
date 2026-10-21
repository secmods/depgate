export type GoProxyRequest =
  | { modulePath: string; type: 'list' }
  | { modulePath: string; type: 'info'; version: string }
  | { modulePath: string; type: 'mod'; version: string }
  | { modulePath: string; type: 'zip'; version: string };

export function parseGoProxyPath(path: string): GoProxyRequest | null {
  const cleaned = (path ?? '').replace(/^\/+/, '');
  if (!cleaned) return null;

  const listMatch = cleaned.match(/^(.*)\/@v\/list$/);
  if (listMatch && listMatch[1]) {
    return { modulePath: listMatch[1], type: 'list' };
  }

  const infoMatch = cleaned.match(/^(.*)\/@v\/([^/]+)\.info$/);
  if (infoMatch && infoMatch[1] && infoMatch[2]) {
    return { modulePath: infoMatch[1], type: 'info', version: infoMatch[2] };
  }

  const modMatch = cleaned.match(/^(.*)\/@v\/([^/]+)\.mod$/);
  if (modMatch && modMatch[1] && modMatch[2]) {
    return { modulePath: modMatch[1], type: 'mod', version: modMatch[2] };
  }

  const zipMatch = cleaned.match(/^(.*)\/@v\/([^/]+)\.zip$/);
  if (zipMatch && zipMatch[1] && zipMatch[2]) {
    return { modulePath: zipMatch[1], type: 'zip', version: zipMatch[2] };
  }

  return null;
}

export function filterGoVersionList(listBody: string, blockedVersions: Set<string>): string {
  const lines = listBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const kept = lines.filter((v) => !blockedVersions.has(v));
  return kept.join('\n') + (kept.length > 0 ? '\n' : '');
}
