import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../envelope.js';
import {
  cefLine,
  datadogBody,
  elasticBody,
  elasticFailures,
  httpBody,
  jsonLine,
  octetFrame,
  splunkBody,
  sumoBodies,
  syslogMessage,
  type StreamEvent,
} from './formatters.js';

/** Each formatter against a golden file (requirements_event_streaming.md §15). UPDATE_GOLDEN=1 rewrites them. */

const GOLDEN = join(__dirname, '__golden__');

function golden(name: string, actual: string): void {
  const path = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, actual);
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

const BLOCK: EventEnvelope = {
  schema: 'depgate.event/1',
  id: '0192f6c2-8a1e-7b3c-9d4e-5f6a7b8c9d0e',
  time: '2026-10-14T10:21:07.512Z',
  category: 'decision',
  type: 'BLOCK_ENFORCE',
  feature: 'decisions',
  severity: 'warning',
  summary: 'Blocked npm event-stream@3.3.6: Malicious packages list',
  actor: {
    kind: 'ci_token',
    id: '5b0c',
    name: 'payments-api-build',
    ip: '192.168.97.1',
    userAgent: 'npm/10.9.2 node/v22.14.0 darwin arm64 workspaces/false',
    authMethod: 'ci_token',
    metadata: { buildId: '8812', repo: 'payments-api', commit: 'a1b2c3d' },
  },
  target: { kind: 'package', ecosystem: 'npm', name: 'event-stream', version: '3.3.6', repository: 'default' },
  policy: { id: 'malicious', name: 'Malicious packages list' },
  reasons: ['MAL-2025-46974'],
  details: { source: { repository: 'npm/default', type: 'public' }, advisories: ['MAL-2025-46974'] },
  depgate: { version: '1.8.0', instance: 'depgate-prod', host: 'depgate-7f9c' },
};

const AUDIT: EventEnvelope = {
  schema: 'depgate.event/1',
  id: '0192f6c3-0000-7000-8000-000000000001',
  time: '2026-10-14T10:22:00.000Z',
  category: 'audit',
  type: 'POLICY_UPDATED',
  feature: 'policies',
  severity: 'notice',
  summary: 'Changed priority from 10 to 5 | a=b \\ next',
  actor: { kind: 'user', name: 'sec@acme.test', ip: '10.0.0.5', userAgent: 'Mozilla/5.0', authMethod: 'oidc' },
  target: { kind: 'policy', id: 'p-1', name: 'Block GPL' },
  reasons: ['Changed priority from 10 to 5', 'line one\nline two = x'],
  depgate: { version: '1.8.0', instance: 'depgate-prod', host: 'depgate-7f9c' },
};

const events: StreamEvent[] = [BLOCK, AUDIT].map((envelope, i) => ({
  entryId: `1-${i}`,
  key: envelope.type,
  feature: envelope.feature,
  json: JSON.stringify(envelope),
}));

describe('destination formats (§9)', () => {
  it('Splunk HEC: one event object per line, sourcetype per category', () => {
    golden('splunk.txt', splunkBody(events, { index: 'security' }, 'depgate-prod'));
    expect(splunkBody(events.slice(0, 1), { sourcetype: 'custom' }, 'h')).toContain('"sourcetype":"custom"');
  });

  it('Datadog: a JSON array with ddsource, tags and the summary as message', () => {
    golden('datadog.json', datadogBody(events, { service: 'depgate', tags: 'env:prod, team:security' }, 'depgate-prod'));
  });

  it('Elastic: NDJSON create actions with @timestamp', () => {
    golden('elastic.ndjson', elasticBody(events));
  });

  it('Sumo Logic: one NDJSON request per category', () => {
    const bodies = sumoBodies(events, {});
    expect(bodies.map((body) => body.category)).toEqual(['depgate/decision', 'depgate/audit']);
    golden('sumo.ndjson', bodies.map((body) => body.body).join('\n'));
    expect(sumoBodies(events, { category: 'sec/depgate' }).map((body) => body.category)).toEqual(['sec/depgate']);
  });

  it('Syslog JSON: RFC 5424 header with PRI from facility and severity', () => {
    const json = syslogMessage(events[0], { facility: 'local0', appName: 'depgate', format: 'json' }, 'depgate-prod');
    expect(json.startsWith('<132>1 2026-10-14T10:21:07.512Z depgate-prod depgate - BLOCK_ENFORCE - {"schema"')).toBe(true);
    golden('syslog-json.txt', json);
  });

  it('Syslog CEF: header and extension escaping', () => {
    golden('syslog-cef.txt', events.map((event) => syslogMessage(event, { format: 'cef' }, 'depgate-prod')).join('\n'));
    const cef = cefLine(AUDIT);
    expect(cef).toContain('|Changed priority from 10 to 5 \\| a=b \\\\ next|5|');
    expect(cef).toContain('cs6=Changed priority from 10 to 5; line one\\nline two \\= x');
    expect(cef).not.toContain('metadata');
  });

  it('octet counting frames a message by its byte length', () => {
    expect(octetFrame('héllo').toString()).toBe('6 héllo');
  });

  it('HTTP: the envelopes unwrapped, as NDJSON or a JSON array', () => {
    golden('http.ndjson', httpBody(events, 'ndjson'));
    golden('http-array.json', httpBody(events, 'array'));
    expect(JSON.parse(httpBody(events, 'array'))).toEqual(events.map((event) => JSON.parse(event.json)));
    expect(httpBody(events, 'ndjson').split('\n')).toHaveLength(events.length + 1);
  });

  it('Container output (JSON lines) adds "log": "depgate.event" first', () => {
    golden('jsonl.txt', events.map((event) => jsonLine(event.json)).join(''));
  });

  it('Elastic partial failures: 429 is retried, 400 rejected, per item', () => {
    const reply = JSON.stringify({
      errors: true,
      items: [
        { create: { status: 201 } },
        { create: { status: 429, error: { type: 'es_rejected_execution_exception', reason: 'queue full' } } },
        { create: { status: 400, error: { type: 'mapper_parsing_exception', reason: 'bad field' } } },
      ],
    });
    expect(elasticFailures(reply)).toEqual([
      { index: 1, status: 429, error: 'es_rejected_execution_exception: queue full' },
      { index: 2, status: 400, error: 'mapper_parsing_exception: bad field' },
    ]);
    expect(elasticFailures(JSON.stringify({ errors: false, items: [] }))).toEqual([]);
  });
});
