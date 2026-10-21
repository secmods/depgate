import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeChanges, headerSecretKey, publicView, validateDestination, type ResolvedDestination } from './config.js';
import { createSender } from './senders.js';
import type { StreamEvent } from './formatters.js';
import type { StreamDestination } from '../../../db/entities/StreamDestination.js';

/** The HTTP destination (requirements_event_streaming.md §9.7): header rules H2–H3 and the request it sends. */


const base = { name: 'Cribl', type: 'http', settings: { url: 'https://cribl.acme.test/ingest' } };
const headers = (list: unknown) => JSON.stringify(list);

describe('HTTP destination: validation (§9.7)', () => {
  it('defaults to POST, NDJSON and gzip', () => {
    const valid = validateDestination(base);
    expect(typeof valid).toBe('object');
    if (typeof valid === 'string') return;
    expect(valid.settings).toEqual({ url: 'https://cribl.acme.test/ingest', method: 'POST', format: 'ndjson', gzip: 'on' });
  });

  it('refuses bad, reserved and duplicate header names, and line breaks in values', () => {
    const check = (list: unknown, secrets?: Record<string, string>) => validateDestination({ ...base, settings: { ...base.settings, headers: headers(list) }, secrets });
    expect(check([{ name: 'X Tenant', value: 'a' }])).toBe('X Tenant is not a valid header name');
    expect(check([{ name: 'Content-Type', value: 'text/plain' }])).toBe('DepGate sets Content-Type itself');
    expect(check([{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }])).toBe('Header x-a is listed twice');
    expect(check([{ name: 'X-A', value: '' }])).toBe('Enter the value of header X-A');
    expect(check([{ name: 'X-A', secret: true }], { 'header:x-a': 'one\ntwo' })).toBe('The value of header X-A cannot contain line breaks');
    expect(check(Array.from({ length: 21 }, (_, i) => ({ name: `X-${i}`, value: 'v' })))).toBe('At most 20 headers');
  });

  it('stores a secret header value in the secrets, keeps it on update and drops it with its header', () => {
    const list = [{ name: 'X-Tenant', value: 'acme' }, { name: 'Authorization', secret: true }];
    expect(validateDestination({ ...base, settings: { ...base.settings, headers: headers(list) } })).toBe('Enter the value of header Authorization');

    const created = validateDestination({ ...base, settings: { ...base.settings, headers: headers(list) }, secrets: { 'header:authorization': 'Bearer abc' } });
    if (typeof created === 'string') throw new Error(created);
    expect(created.secrets).toEqual({ 'header:authorization': 'Bearer abc' });
    expect(created.settings.headers).toBe(headers([{ name: 'X-Tenant', value: 'acme' }, { name: 'Authorization', secret: true }]));

    // Left empty on update: kept.
    const kept = validateDestination({ ...base, settings: { ...base.settings, headers: headers(list) } }, created);
    if (typeof kept === 'string') throw new Error(kept);
    expect(kept.secrets['header:authorization']).toBe('Bearer abc');

    // Header removed: its secret goes too.
    const dropped = validateDestination({ ...base, settings: { ...base.settings, headers: headers(list.slice(0, 1)) } }, created);
    if (typeof dropped === 'string') throw new Error(dropped);
    expect(dropped.secrets).toEqual({});
  });

  it('shows secret headers only as set, and audit changes without their values', () => {
    const valid = validateDestination({
      ...base,
      settings: { ...base.settings, headers: headers([{ name: 'Authorization', secret: true }]) },
      secrets: { 'header:authorization': 'Bearer abc' },
    });
    if (typeof valid === 'string') throw new Error(valid);
    const row = { id: 'd1', name: valid.name, type: 'http', enabled: true, settings: valid.settings, secretsEnc: null, selection: valid.selection } as unknown as StreamDestination;
    expect(publicView(row).secrets).toEqual({ [headerSecretKey('Authorization')]: { set: false } });

    const before: ResolvedDestination = { id: 'd1', ...valid, settings: { ...valid.settings, headers: '[]' }, secrets: {} };
    const after: ResolvedDestination = { id: 'd1', ...valid };
    const changes = describeChanges(before, after).join(' | ');
    expect(changes).toContain('headers: Authorization (secret)');
    expect(changes).toContain('header:authorization changed');
    expect(changes).not.toContain('Bearer abc');
  });
});

describe('HTTP destination: the request (§9.7)', () => {
  let server: http.Server;
  let url = '';
  let last: { method?: string; headers: http.IncomingHttpHeaders; body: string } = { headers: {}, body: '' };
  let status = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const body = req.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
        last = { method: req.method, headers: req.headers, body };
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(status === 200 ? 'ok' : 'nope');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ingest`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const events: StreamEvent[] = [
    { entryId: '1-0', key: 'BLOCK_ENFORCE', feature: 'decisions', json: '{"type":"BLOCK_ENFORCE","n":1}' },
    { entryId: '1-1', key: 'POLICY_UPDATED', feature: 'policies', json: '{"type":"POLICY_UPDATED","n":2}' },
  ];

  function dest(settings: Record<string, string>, secrets: Record<string, string> = {}): ResolvedDestination {
    return { id: `http-test-${Math.random()}`, name: 'Test', type: 'http', enabled: true, settings: { url, ...settings }, secrets, selection: { features: [], events: [] } };
  }

  it('POSTs gzipped NDJSON with the admin headers and secret values', async () => {
    const sender = createSender(
      dest({ method: 'POST', format: 'ndjson', gzip: 'on', headers: headers([{ name: 'X-Tenant', value: 'acme' }, { name: 'Authorization', secret: true }]) }, { 'header:authorization': 'Bearer abc' })
    )!;
    const outcome = await sender.send(events);
    sender.close();
    expect(outcome).toMatchObject({ kind: 'ok', status: 200 });
    expect(last.method).toBe('POST');
    expect(last.headers['content-type']).toBe('application/x-ndjson');
    expect(last.headers['content-encoding']).toBe('gzip');
    expect(last.headers['x-tenant']).toBe('acme');
    expect(last.headers['authorization']).toBe('Bearer abc');
    expect(last.body).toBe('{"type":"BLOCK_ENFORCE","n":1}\n{"type":"POLICY_UPDATED","n":2}\n');
  });

  it('PUTs an uncompressed JSON array when asked', async () => {
    const sender = createSender(dest({ method: 'PUT', format: 'array', gzip: 'off' }))!;
    await sender.send(events);
    sender.close();
    expect(last.method).toBe('PUT');
    expect(last.headers['content-type']).toBe('application/json');
    expect(last.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(last.body)).toEqual([{ type: 'BLOCK_ENFORCE', n: 1 }, { type: 'POLICY_UPDATED', n: 2 }]);
  });

  it('treats 401 as auth failed and 503 as retry', async () => {
    const sender = createSender(dest({}))!;
    status = 401;
    expect((await sender.send(events)).kind).toBe('auth');
    status = 503;
    expect((await sender.send(events)).kind).toBe('retry');
    status = 200;
    sender.close();
  });
});
