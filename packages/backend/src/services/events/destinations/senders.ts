import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { scrubError } from '../../jobs/ids.js';
import { parseRetryAfter } from '../../webhook-delivery.js';
import { depgateInfo } from '../envelope.js';
import { headerList, headerSecretKey, type ResolvedDestination } from './config.js';
import {
  datadogBody,
  elasticBody,
  elasticFailures,
  httpBody,
  octetFrame,
  splunkBody,
  sumoBodies,
  syslogMessage,
  type StreamEvent,
} from './formatters.js';

/**
 * Transports of the HTTP and Syslog destinations (requirements_event_streaming.md §9). Gzip at level 1 on
 * the libuv thread pool, keep-alive with at most 2 connections per destination, TLS verification always on
 * with an optional private CA, 10-second timeout.
 */

const gzip = promisify(zlib.gzip);
const TIMEOUT_MS = 10_000;
/** The first characters of a reply kept for the status and the test result. */
const REPLY_CHARS = 300;

/** What happened to a batch. `retry` lists events to send again (Elastic items that got 429). */
export type SendOutcome =
  | { kind: 'ok'; status: number | null; reply: string; rejected?: number; retry?: StreamEvent[]; error?: string }
  | { kind: 'retry'; status: number | null; error: string; reply?: string; retryAfterMs?: number }
  | { kind: 'auth'; status: number; error: string; reply?: string }
  | { kind: 'reject'; status: number; error: string; reply?: string };

export interface Sender {
  send(events: StreamEvent[]): Promise<SendOutcome>;
  close(): void;
}

type HttpReply = { status: number; headers: http.IncomingHttpHeaders; body: string };

const agents = new Map<string, http.Agent>();

function agentFor(url: URL, ca: string | undefined, key: string): http.Agent {
  const id = `${key}|${url.protocol}|${ca ? ca.length : 0}`;
  let agent = agents.get(id);
  if (!agent) {
    agent =
      url.protocol === 'https:'
        ? new https.Agent({ keepAlive: true, maxSockets: 2, ...(ca ? { ca } : {}) })
        : new http.Agent({ keepAlive: true, maxSockets: 2 });
    agents.set(id, agent);
  }
  return agent;
}

export function closeAgents(prefix: string): void {
  for (const [id, agent] of agents) {
    if (!id.startsWith(`${prefix}|`)) continue;
    agent.destroy();
    agents.delete(id);
  }
}

export async function httpPost(
  target: string,
  opts: { headers: Record<string, string>; body: string; ca?: string; agentKey: string; gzipBody?: boolean; method?: 'POST' | 'PUT' }
): Promise<HttpReply> {
  const url = new URL(target);
  const raw = Buffer.from(opts.body, 'utf8');
  const body = opts.gzipBody === false ? raw : await gzip(raw, { level: 1 });
  const headers: Record<string, string> = {
    ...opts.headers,
    'Content-Length': String(body.length),
    'User-Agent': `DepGate/${depgateInfo().version}`,
  };
  if (opts.gzipBody !== false) headers['Content-Encoding'] = 'gzip';
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<HttpReply>((resolve, reject) => {
    const req = client.request(
      url,
      { method: opts.method ?? 'POST', headers, agent: agentFor(url, opts.ca, opts.agentKey), timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          // Enough for Elastic's per-item results of a 500-event batch; the rest is discarded.
          if (size < 4_000_000) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** 2xx ok; 401/403 auth; 408, 429, 5xx retried (Retry-After honoured); other 4xx rejected (R-D8 – R-D10). */
export function classify(reply: HttpReply, ok: (status: number) => boolean = (status) => status >= 200 && status < 300): SendOutcome {
  const text = reply.body.slice(0, REPLY_CHARS);
  if (ok(reply.status)) return { kind: 'ok', status: reply.status, reply: text };
  const error = `HTTP ${reply.status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
  if (reply.status === 401 || reply.status === 403) return { kind: 'auth', status: reply.status, error, reply: text };
  if (reply.status === 408 || reply.status === 429 || reply.status >= 500) {
    const retryAfter = reply.headers['retry-after'];
    return { kind: 'retry', status: reply.status, error, reply: text, retryAfterMs: parseRetryAfter(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter) };
  }
  return { kind: 'reject', status: reply.status, error, reply: text };
}

function networkError(err: unknown): SendOutcome {
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'retry', status: null, error: scrubError(message) };
}

async function post(
  dest: ResolvedDestination,
  url: string,
  headers: Record<string, string>,
  body: string,
  ok?: (status: number) => boolean,
  extra: { method?: 'POST' | 'PUT'; gzipBody?: boolean } = {}
): Promise<SendOutcome> {
  try {
    return classify(await httpPost(url, { headers, body, ca: dest.settings.caCert, agentKey: dest.id, ...extra }), ok);
  } catch (err) {
    return networkError(err);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function splunkSender(dest: ResolvedDestination): Sender {
  const url = `${trimSlash(dest.settings.url)}/services/collector/event`;
  return {
    async send(events) {
      const outcome = await post(dest, url, { Authorization: `Splunk ${dest.secrets.token}`, 'Content-Type': 'application/json' }, splunkBody(events, dest.settings, depgateInfo().instance));
      if (outcome.kind === 'ok') {
        // HEC answers {"text":"Success","code":0}; any other code is a failure even with 200.
        try {
          const code = JSON.parse(outcome.reply || '{}').code;
          if (code !== undefined && code !== 0) return { kind: 'reject', status: outcome.status ?? 200, error: `Splunk code ${code}: ${outcome.reply}` };
        } catch {
          /* a proxy in front may answer with text */
        }
      }
      return outcome;
    },
    close: () => closeAgents(dest.id),
  };
}

function datadogSender(dest: ResolvedDestination): Sender {
  const url = `https://http-intake.logs.${dest.settings.site || 'datadoghq.com'}/api/v2/logs`;
  return {
    send: (events) =>
      post(dest, url, { 'DD-API-KEY': dest.secrets.apiKey, 'Content-Type': 'application/json' }, datadogBody(events, dest.settings, depgateInfo().instance)),
    close: () => closeAgents(dest.id),
  };
}

function elasticSender(dest: ResolvedDestination): Sender {
  const index = dest.settings.index || 'logs-depgate.events-default';
  const url = `${trimSlash(dest.settings.url)}/${encodeURIComponent(index)}/_bulk`;
  const auth =
    dest.settings.authType === 'basic'
      ? `Basic ${Buffer.from(`${dest.settings.username}:${dest.secrets.password ?? ''}`).toString('base64')}`
      : `ApiKey ${dest.secrets.apiKey}`;
  return {
    async send(events) {
      let reply: HttpReply;
      try {
        reply = await httpPost(url, { headers: { Authorization: auth, 'Content-Type': 'application/x-ndjson' }, body: elasticBody(events), ca: dest.settings.caCert, agentKey: dest.id });
      } catch (err) {
        return networkError(err);
      }
      const outcome = classify(reply);
      if (outcome.kind !== 'ok') return outcome;
      const failures = elasticFailures(reply.body);
      if (failures.length === 0) return outcome;
      const retry: StreamEvent[] = [];
      let rejected = 0;
      let error: string | undefined;
      for (const failure of failures) {
        if (failure.status === 429 || failure.status >= 500 || failure.status === 0) retry.push(events[failure.index]);
        else {
          rejected += 1;
          error ??= failure.error;
        }
      }
      return { ...outcome, retry: retry.filter(Boolean), rejected, error };
    },
    close: () => closeAgents(dest.id),
  };
}

function sumoSender(dest: ResolvedDestination): Sender {
  return {
    async send(events) {
      let last: SendOutcome = { kind: 'ok', status: null, reply: '' };
      for (const group of sumoBodies(events, dest.settings)) {
        last = await post(
          dest,
          dest.secrets.url,
          { 'Content-Type': 'application/x-ndjson', 'X-Sumo-Name': 'depgate', 'X-Sumo-Host': depgateInfo().instance, 'X-Sumo-Category': group.category },
          group.body
        );
        if (last.kind !== 'ok') return last;
      }
      return last;
    },
    close: () => closeAgents(dest.id),
  };
}

/** Any HTTP endpoint (§9.7): the admin's headers, secret values from the secrets, the envelopes unwrapped. */
function httpSender(dest: ResolvedDestination): Sender {
  const format = dest.settings.format === 'array' ? 'array' : 'ndjson';
  const headers: Record<string, string> = {};
  for (const header of headerList(dest.settings)) {
    const value = header.secret ? dest.secrets[headerSecretKey(header.name)] : header.value;
    if (value) headers[header.name] = value;
  }
  headers['Content-Type'] = format === 'array' ? 'application/json' : 'application/x-ndjson';
  const extra = { method: dest.settings.method === 'PUT' ? ('PUT' as const) : ('POST' as const), gzipBody: dest.settings.gzip !== 'off' };
  return {
    send: (events) => post(dest, dest.settings.url, headers, httpBody(events, format), undefined, extra),
    close: () => closeAgents(dest.id),
  };
}

/** One connection per sender, reopened with backoff. A batch counts as sent once fully written to the socket. */
function syslogSender(dest: ResolvedDestination): Sender {
  let socket: net.Socket | null = null;
  let connecting: Promise<net.Socket> | null = null;
  const port = Number(dest.settings.port) || (dest.settings.transport === 'tcp' ? 514 : 6514);

  const connect = () =>
    (connecting ??= new Promise<net.Socket>((resolve, reject) => {
      const onError = (err: Error) => {
        connecting = null;
        reject(err);
      };
      const opened =
        dest.settings.transport === 'tcp'
          ? net.connect({ host: dest.settings.host, port }, () => resolve(opened))
          : tls.connect({ host: dest.settings.host, port, servername: net.isIP(dest.settings.host) ? undefined : dest.settings.host, ...(dest.settings.caCert ? { ca: dest.settings.caCert } : {}) }, () => resolve(opened));
      opened.setTimeout(TIMEOUT_MS, () => opened.destroy(new Error('Timed out')));
      opened.once('error', onError);
      opened.on('close', () => {
        if (socket === opened) socket = null;
        connecting = null;
      });
    }).then((opened) => {
      opened.setTimeout(0);
      opened.removeAllListeners('error');
      opened.on('error', () => opened.destroy());
      socket = opened;
      return opened;
    }));

  return {
    async send(events) {
      try {
        const conn = socket ?? (await connect());
        const frames = Buffer.concat(events.map((event) => octetFrame(syslogMessage(event, dest.settings as never, depgateInfo().instance))));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timed out')), TIMEOUT_MS);
          conn.write(frames, (err) => {
            clearTimeout(timer);
            if (err) reject(err);
            else resolve();
          });
        });
        return { kind: 'ok', status: null, reply: `Wrote ${events.length} message${events.length === 1 ? '' : 's'}` };
      } catch (err) {
        socket?.destroy();
        socket = null;
        connecting = null;
        return networkError(err);
      }
    },
    close: () => {
      socket?.destroy();
      socket = null;
    },
  };
}

export function createSender(dest: ResolvedDestination): Sender | null {
  switch (dest.type) {
    case 'splunk':
      return splunkSender(dest);
    case 'datadog':
      return datadogSender(dest);
    case 'elastic':
      return elasticSender(dest);
    case 'sumo':
      return sumoSender(dest);
    case 'syslog':
      return syslogSender(dest);
    case 'http':
      return httpSender(dest);
    default:
      return null;
  }
}
