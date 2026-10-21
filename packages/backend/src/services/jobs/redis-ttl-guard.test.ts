import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * requirements_job_queue.md §9.1: caching and queues share one Redis that never evicts, so every
 * cache key DepGate writes must expire on its own. This reads the source and fails on a Redis write
 * without a TTL. BullMQ manages its own keys and trims them (§5.1).
 */

const SRC = join(__dirname, '..', '..');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'test-support') out.push(...files(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Writes allowed without a TTL: state, not cache. */
const ALLOWED: Array<{ file: string; call: RegExp; why: string }> = [
  { file: 'services/reference-cache.ts', call: /redis\.incr\(genKey\(kind\)\)/, why: 'reference generation counter (about ten keys)' },
];

const WRITE = /\b(?:redis|multi|pipe|pipeline)\??\.(set|setex|psetex|hset|hmset|incr|incrby|sadd|lpush|rpush|zadd)\(/g;

describe('every Redis write has a TTL (one Redis, noeviction)', () => {
  const sources = files(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

  it('finds the writers it guards', () => {
    const count = sources.reduce((n, file) => n + [...file.text.matchAll(WRITE)].length, 0);
    expect(count).toBeGreaterThan(10);
  });

  it('SET carries EX/PX; HSET, INCR and list/set writes are followed by an EXPIRE in the same unit', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const match of file.text.matchAll(WRITE)) {
        const at = match.index ?? 0;
        const line = file.text.slice(at, file.text.indexOf('\n', at));
        if (ALLOWED.some((allowed) => allowed.file === file.path && allowed.call.test(line))) continue;
        const op = match[1];
        if (op === 'setex' || op === 'psetex') continue;
        // The statement, up to the end of a chained call (multi().set(...).incr(...).exec()).
        const statement = file.text.slice(at, file.text.indexOf(';', at) + 1 || at + 400);
        if (op === 'set') {
          if (/'(EX|PX)'/.test(statement)) continue;
          offenders.push(`${file.path}: ${line.trim()}`);
          continue;
        }
        // INCR/HSET: a TTL is set in the same chain (SET … EX … NX before INCR) or by an EXPIRE nearby.
        const window = file.text.slice(Math.max(0, at - 400), at + 600);
        if (/'(EX|PX)'/.test(statement) || /\.(expire|pexpire)\(/.test(window)) continue;
        offenders.push(`${file.path}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Decision Ledger never writes to Redis', () => {
    const audit = sources.find((file) => file.path === 'services/audit-service.ts')!;
    expect(audit.text).not.toMatch(/redis/i);
  });

  it('invitations are sent inline and never queued for a retry', () => {
    const accounts = sources.find((file) => file.path === 'routes/accounts.ts')!;
    expect(accounts.text).not.toMatch(/enqueue\(|queueAuthLinkEmail/);
  });
});
