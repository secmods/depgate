import type { EventEnvelope } from '../envelope.js';

/**
 * Wire formats of the destination types (requirements_event_streaming.md §9). Pure functions, so each is
 * checked against golden files. Splunk, Sumo Logic, Elastic and JSON lines wrap the envelope's JSON string
 * as it was serialized once in `publish` (L2); only Datadog and CEF parse it.
 */

/** One event as read from the stream. */
export type StreamEvent = {
  /** Stream entry ID, for XACK. Empty for a test event. */
  entryId: string;
  /** The selection key: the type, or `JOB_*:<job>`. */
  key: string;
  feature: string;
  /** The envelope, serialized once. */
  json: string;
};

export function parseEnvelope(event: StreamEvent): EventEnvelope {
  return JSON.parse(event.json) as EventEnvelope;
}

/** `"time":"…"` without parsing the whole envelope. */
function timeOf(json: string): string {
  const match = json.match(/"time":"([^"]+)"/);
  return match ? match[1] : new Date().toISOString();
}

function categoryOf(json: string): string {
  return json.match(/"category":"([a-z]+)"/)?.[1] ?? 'audit';
}

/* ---------------- Splunk HEC (§9.1) ---------------- */

export type SplunkSettings = { index?: string; source?: string; sourcetype?: string };

export function splunkBody(events: StreamEvent[], settings: SplunkSettings, host: string): string {
  const source = settings.source || 'depgate';
  return events
    .map((event) => {
      const time = Date.parse(timeOf(event.json)) / 1000;
      const sourcetype = settings.sourcetype || `depgate:${categoryOf(event.json)}`;
      const index = settings.index ? `,"index":${JSON.stringify(settings.index)}` : '';
      return `{"time":${time.toFixed(3)},"host":${JSON.stringify(host)},"source":${JSON.stringify(source)},"sourcetype":${JSON.stringify(sourcetype)}${index},"event":${event.json}}`;
    })
    .join('\n');
}

/* ---------------- Datadog Logs intake (§9.2) ---------------- */

export type DatadogSettings = { service?: string; tags?: string };

export function datadogBody(events: StreamEvent[], settings: DatadogSettings, host: string): string {
  const service = settings.service || 'depgate';
  const extraTags = (settings.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const entries = events.map((event) => {
    const envelope = parseEnvelope(event);
    const tags = [`feature:${envelope.feature}`, `category:${envelope.category}`, `type:${envelope.type}`, `severity:${envelope.severity}`, ...extraTags];
    return {
      ddsource: 'depgate',
      service,
      hostname: host,
      ddtags: tags.join(','),
      message: envelope.summary,
      ...envelope,
    };
  });
  return JSON.stringify(entries);
}

/* ---------------- Elastic / OpenSearch _bulk (§9.3) ---------------- */

export function elasticBody(events: StreamEvent[]): string {
  return (
    events
      .map((event) => `{"create":{}}\n{"@timestamp":${JSON.stringify(timeOf(event.json))},${event.json.slice(1)}`)
      .join('\n') + '\n'
  );
}

export type BulkItemOutcome = { index: number; status: number; error?: string };

/**
 * `_bulk` answers 200 even when items fail. Returns, per failed item, its position and status:
 * 429 is retried, other 4xx rejected, the rest retried.
 */
export function elasticFailures(responseText: string): BulkItemOutcome[] {
  let parsed: { errors?: boolean; items?: Array<Record<string, { status?: number; error?: { type?: string; reason?: string } }>> };
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return [];
  }
  if (!parsed.errors || !Array.isArray(parsed.items)) return [];
  const failures: BulkItemOutcome[] = [];
  parsed.items.forEach((item, index) => {
    const result = item.create ?? item.index ?? Object.values(item)[0];
    const status = Number(result?.status ?? 0);
    if (status >= 200 && status < 300) return;
    const error = result?.error ? `${result.error.type ?? 'error'}: ${result.error.reason ?? ''}`.trim() : `HTTP ${status}`;
    failures.push({ index, status, error });
  });
  return failures;
}

/* ---------------- Sumo Logic HTTP Source (§9.4) ---------------- */

/** One request per category, so each carries its own `X-Sumo-Category`. */
export function sumoBodies(events: StreamEvent[], settings: { category?: string }): Array<{ category: string; body: string; events: StreamEvent[] }> {
  const groups = new Map<string, StreamEvent[]>();
  for (const event of events) {
    const category = settings.category || `depgate/${categoryOf(event.json)}`;
    const list = groups.get(category) ?? [];
    list.push(event);
    groups.set(category, list);
  }
  return [...groups.entries()].map(([category, list]) => ({ category, body: list.map((event) => event.json).join('\n'), events: list }));
}

/* ---------------- Syslog RFC 5424, JSON or CEF (§9.5) ---------------- */

const SYSLOG_SEVERITY: Record<string, number> = { info: 6, notice: 5, warning: 4, error: 3 };
const CEF_SEVERITY: Record<string, number> = { info: 3, notice: 5, warning: 7, error: 9 };

export const SYSLOG_FACILITIES: Record<string, number> = {
  kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
};

export type SyslogSettings = { facility?: string; appName?: string; format?: 'json' | 'cef' };

/** PRINTUSASCII without spaces, at most `max` characters (RFC 5424 header fields). */
function headerField(value: string, max: number): string {
  const clean = value.replace(/[^\x21-\x7e]/g, '');
  return (clean || '-').slice(0, max);
}

function cefHeader(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function cefExtension(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r\n|\r|\n/g, '\\n');
}

/** `CEF:0|DepGate|DepGate|{version}|{type}|{summary}|{severity}|{extensions}` */
export function cefLine(envelope: EventEnvelope): string {
  const pairs: Array<[string, string | number | undefined | null]> = [
    ['rt', Date.parse(envelope.time)],
    ['externalId', envelope.id],
    ['cat', envelope.category],
    ['act', envelope.type],
    ['suser', envelope.actor?.name],
    ['src', envelope.actor?.ip],
    ['requestClientApplication', envelope.actor?.userAgent],
    ['cs1Label', envelope.policy?.name ? 'Policy' : null],
    ['cs1', envelope.policy?.name],
    ['cs2Label', envelope.target?.ecosystem ? 'Ecosystem' : null],
    ['cs2', envelope.target?.ecosystem],
    ['cs3Label', envelope.target?.name ? 'Target' : null],
    ['cs3', envelope.target?.name],
    ['cs4Label', envelope.target?.version ? 'Version' : null],
    ['cs4', envelope.target?.version],
    ['cs5Label', envelope.target?.repository ? 'Repository' : null],
    ['cs5', envelope.target?.repository],
    ['cs6Label', envelope.reasons?.length ? 'Reasons' : null],
    ['cs6', envelope.reasons?.join('; ')],
    ['msg', envelope.summary],
  ];
  const extensions = pairs
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${cefExtension(String(value))}`)
    .join(' ');
  const severity = CEF_SEVERITY[envelope.severity] ?? 5;
  return `CEF:0|DepGate|DepGate|${cefHeader(envelope.depgate.version)}|${cefHeader(envelope.type)}|${cefHeader(envelope.summary)}|${severity}|${extensions}`;
}

/** `<PRI>1 {time} {instance} {app} - {type} - {payload}` */
export function syslogMessage(event: StreamEvent, settings: SyslogSettings, instance: string): string {
  const envelope = parseEnvelope(event);
  const facility = SYSLOG_FACILITIES[settings.facility ?? 'local0'] ?? 16;
  const pri = facility * 8 + (SYSLOG_SEVERITY[envelope.severity] ?? 5);
  const payload = settings.format === 'cef' ? cefLine(envelope) : event.json;
  return `<${pri}>1 ${envelope.time} ${headerField(instance, 255)} ${headerField(settings.appName || 'depgate', 48)} - ${headerField(envelope.type, 32)} - ${payload}`;
}

/** RFC 6587 / RFC 5425 octet counting: `LEN SP MSG`. */
export function octetFrame(message: string): Buffer {
  const body = Buffer.from(message, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'ascii'), body]);
}

/* ---------------- HTTP, any endpoint (§9.7) ---------------- */

/** The envelopes as serialized in `publish`, no wrapper (H1): one per line, or a JSON array. */
export function httpBody(events: StreamEvent[], format: 'ndjson' | 'array'): string {
  if (format === 'array') return `[${events.map((event) => event.json).join(',')}]`;
  return events.map((event) => `${event.json}\n`).join('');
}

/* ---------------- Container output, type jsonl (§9.6) ---------------- */

export function jsonLine(json: string): string {
  return `{"log":"depgate.event",${json.slice(1)}\n`;
}
