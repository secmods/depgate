import fs from 'node:fs';
import path from 'node:path';

/** The DepGate release this build is, from packages/backend/package.json. Present in src, dist and the image. */
export const APP_VERSION: string = readVersion();

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
