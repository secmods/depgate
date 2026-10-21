// Test receiver for DepGate Log Streaming. No dependencies.
//
//   POST /ingest                     custom JSON (HTTP destination): Authorization: Bearer $TOKEN, NDJSON or a JSON array
//   POST /receiver/v1/http/$TOKEN    Sumo Logic HTTP Source stand-in: the token is in the URL, X-Sumo-* headers kept
//   POST /api/v2/logs                Datadog intake stand-in: DD-API-KEY must equal $TOKEN, answers 202;
//                                    with FORWARD_URL set, the body is also passed on (to Datadog's fakeintake)
//   GET  /events?kind=...            what was collected, newest last (Bearer $TOKEN)
//   DELETE /events                   clears it (Bearer $TOKEN)
//
// Env: PORT (8080), TOKEN (required), TLS_CERT / TLS_KEY (PEM paths, serve HTTPS), FORWARD_URL.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error('Set TOKEN');
const PORT = Number(process.env.PORT || 8080);
const FORWARD_URL = process.env.FORWARD_URL || '';

/** Every accepted request: kind, headers worth keeping, and the parsed events. */
const requests = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseEvents(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function forward(raw, headers) {
  const req = http.request(FORWARD_URL, { method: 'POST', headers: { ...headers, 'Content-Length': raw.length } }, (res) => res.resume());
  req.on('error', (err) => console.error('forward failed', err.message));
  req.end(raw);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://receiver');
  const bearer = req.headers.authorization === `Bearer ${TOKEN}`;

  if (url.pathname === '/events') {
    if (!bearer) return send(res, 401, { error: 'bad token' });
    if (req.method === 'DELETE') {
      requests.length = 0;
      return send(res, 200, { cleared: true });
    }
    const kind = url.searchParams.get('kind');
    const list = kind ? requests.filter((r) => r.kind === kind) : requests;
    return send(res, 200, { requests: list.length, events: list.reduce((n, r) => n + r.events.length, 0), list });
  }
  if (req.method !== 'POST' && req.method !== 'PUT') return send(res, 405, { error: 'POST or PUT' });

  let kind;
  if (url.pathname === '/ingest') {
    if (!bearer) return send(res, 401, { error: 'bad token' });
    kind = 'custom';
  } else if (url.pathname.startsWith('/receiver/v1/http/')) {
    if (url.pathname.slice('/receiver/v1/http/'.length) !== TOKEN) return send(res, 401, { error: 'bad source token' });
    kind = 'sumo';
  } else if (url.pathname === '/api/v2/logs') {
    if (req.headers['dd-api-key'] !== TOKEN) return send(res, 403, { errors: [{ status: '403', title: 'Forbidden' }] });
    kind = 'datadog';
  } else {
    return send(res, 404, { error: 'not found' });
  }

  const raw = await readBody(req);
  const gzipped = req.headers['content-encoding'] === 'gzip';
  let events;
  try {
    events = parseEvents((gzipped ? zlib.gunzipSync(raw) : raw).toString('utf8'));
  } catch (err) {
    return send(res, 400, { error: `unparseable body: ${err.message}` });
  }
  const keep = ['content-type', 'content-encoding', 'user-agent', 'x-sumo-category', 'x-sumo-name', 'x-sumo-host', 'x-custom'];
  requests.push({
    kind,
    method: req.method,
    receivedAt: new Date().toISOString(),
    headers: Object.fromEntries(keep.filter((h) => req.headers[h]).map((h) => [h, req.headers[h]])),
    bytesOnWire: raw.length,
    events,
  });
  console.log(`${kind}: ${events.length} event(s) ${events.map((e) => e.type ?? e.event?.type ?? '?').join(',')}`);
  if (kind === 'datadog') {
    if (FORWARD_URL) forward(raw, { 'Content-Type': req.headers['content-type'] ?? 'application/json', ...(gzipped ? { 'Content-Encoding': 'gzip' } : {}), 'DD-API-KEY': TOKEN });
    return send(res, 202, {});
  }
  return send(res, 200, { accepted: events.length });
}

const listener = (req, res) => handle(req, res).catch((err) => send(res, 500, { error: err.message }));
const server = process.env.TLS_CERT
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, listener)
  : http.createServer(listener);
server.listen(PORT, () => console.log(`log-receiver on ${process.env.TLS_CERT ? 'https' : 'http'}://0.0.0.0:${PORT}`));
