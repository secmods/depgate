/**
 * In-memory stand-in for the ioredis commands the caches use. Test-only; excluded from the build.
 * Expiry is tracked so TTL assertions work, but keys are not evicted on a timer.
 */
type Value = { kind: 'string'; value: string } | { kind: 'hash'; value: Map<string, Buffer> };

export type MemoryRedis = ReturnType<typeof createMemoryRedis>;

const RELEASE_HINT = "redis.call('del'";
const RENEW_HINT = "redis.call('pexpire'";

export function createMemoryRedis() {
  const data = new Map<string, Value>();
  const expiresAt = new Map<string, number>();
  const calls: string[] = [];

  const alive = (key: string): Value | undefined => {
    const at = expiresAt.get(key);
    if (at !== undefined && at <= Date.now()) {
      data.delete(key);
      expiresAt.delete(key);
      return undefined;
    }
    return data.get(key);
  };

  const wrongType = () => Object.assign(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'), { code: 'WRONGTYPE' });

  const asString = (key: string): string | null => {
    const v = alive(key);
    if (!v) return null;
    if (v.kind !== 'string') throw wrongType();
    return v.value;
  };

  const hash = (key: string, create: boolean): Map<string, Buffer> | undefined => {
    const v = alive(key);
    if (v && v.kind !== 'hash') throw wrongType();
    if (v) return v.value;
    if (!create) return undefined;
    const map = new Map<string, Buffer>();
    data.set(key, { kind: 'hash', value: map });
    return map;
  };

  const toBuffer = (value: unknown): Buffer => (Buffer.isBuffer(value) ? value : Buffer.from(String(value)));

  const commands = {
    async get(key: string) {
      calls.push(`get ${key}`);
      return asString(key);
    },
    async set(key: string, value: string, ...args: Array<string | number>) {
      calls.push(`set ${key}`);
      const nx = args.includes('NX');
      if (nx && alive(key)) return null;
      data.set(key, { kind: 'string', value: String(value) });
      expiresAt.delete(key);
      const ex = args.indexOf('EX');
      if (ex >= 0) expiresAt.set(key, Date.now() + Number(args[ex + 1]) * 1000);
      return 'OK';
    },
    async setex(key: string, ttl: number, value: string) {
      calls.push(`setex ${key}`);
      data.set(key, { kind: 'string', value: String(value) });
      expiresAt.set(key, Date.now() + ttl * 1000);
      return 'OK';
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const key of keys) {
        if (alive(key)) n += 1;
        data.delete(key);
        expiresAt.delete(key);
      }
      return n;
    },
    async exists(...keys: string[]) {
      return keys.filter((key) => alive(key)).length;
    },
    async mget(...keys: string[]) {
      calls.push(`mget ${keys.length}`);
      return keys.map((key) => {
        const v = alive(key);
        return v && v.kind === 'string' ? v.value : null;
      });
    },
    async incr(key: string) {
      const next = Number(asString(key) ?? '0') + 1;
      data.set(key, { kind: 'string', value: String(next) });
      return next;
    },
    async decrby(key: string, by: number) {
      const next = Number(asString(key) ?? '0') - Number(by);
      data.set(key, { kind: 'string', value: String(next) });
      return next;
    },
    async publish() {
      return 0;
    },
    async hget(key: string, field: string) {
      calls.push(`hget ${key}`);
      return hash(key, false)?.get(field)?.toString('utf8') ?? null;
    },
    async hmget(key: string, ...fields: string[]) {
      calls.push(`hmget ${key}`);
      const h = hash(key, false);
      return fields.map((field) => h?.get(field)?.toString('utf8') ?? null);
    },
    async hmgetBuffer(key: string, ...fields: string[]) {
      calls.push(`hmgetBuffer ${key}`);
      const h = hash(key, false);
      return fields.map((field) => h?.get(field) ?? null);
    },
    async hset(key: string, fields: Record<string, unknown>) {
      const h = hash(key, true)!;
      for (const [field, value] of Object.entries(fields)) h.set(field, toBuffer(value));
      return Object.keys(fields).length;
    },
    async expire(key: string, ttl: number) {
      if (!alive(key)) return 0;
      expiresAt.set(key, Date.now() + ttl * 1000);
      return 1;
    },
    async pexpire(key: string, ms: number) {
      if (!alive(key)) return 0;
      expiresAt.set(key, Date.now() + ms);
      return 1;
    },
    async ttl(key: string) {
      if (!alive(key)) return -2;
      const at = expiresAt.get(key);
      return at === undefined ? -1 : Math.ceil((at - Date.now()) / 1000);
    },
    async pttl(key: string) {
      if (!alive(key)) return -2;
      const at = expiresAt.get(key);
      return at === undefined ? -1 : at - Date.now();
    },
    /** Supports only the lock release and renew scripts in cache-coalesce. */
    async eval(script: string, _numKeys: number, key: string, token: string, ms?: number) {
      const current = alive(key);
      if (!current || current.kind !== 'string' || current.value !== token) return 0;
      if (script.includes(RELEASE_HINT)) return commands.del(key);
      if (script.includes(RENEW_HINT)) return commands.pexpire(key, Number(ms));
      return 0;
    },
  };

  type Queued = () => Promise<unknown>;
  const chain = () => {
    const queue: Queued[] = [];
    const proxy: Record<string, unknown> = {
      exec: async () => {
        const out: Array<[null, unknown]> = [];
        for (const run of queue) out.push([null, await run()]);
        return out;
      },
    };
    for (const [name, fn] of Object.entries(commands)) {
      proxy[name] = (...args: unknown[]) => {
        queue.push(() => (fn as (...a: unknown[]) => Promise<unknown>)(...args));
        return proxy;
      };
    }
    return proxy;
  };

  return {
    ...commands,
    multi: chain,
    pipeline: chain,
    /** Test helpers, not Redis commands. */
    data,
    calls,
    hashField(key: string, field: string): Buffer | undefined {
      return hash(key, false)?.get(field);
    },
  };
}
