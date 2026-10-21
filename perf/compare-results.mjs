#!/usr/bin/env node
/**
 * Merge perf/results/*.report.json into one comparison table.
 * Usage: node perf/compare-results.mjs [results-dir]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = process.argv[2] || 'perf/results';
const order = ['mixed', 'scoped', 'namespace', 'allow', 'block-package', 'block-license', 'block-cve', 'allowlist'];

const names = (await readdir(dir)).filter((name) => name.endsWith('.report.json'));
const reports = [];
for (const name of names) {
  const raw = await readFile(path.join(dir, name), 'utf8');
  reports.push(JSON.parse(raw));
}
reports.sort((a, b) => order.indexOf(a.scenario) - order.indexOf(b.scenario));

if (reports.length === 0) {
  console.error(`No *.report.json files in ${dir}`);
  process.exit(1);
}

const header = [
  'scenario',
  'ecosystem',
  'installs',
  'allow p95 ms',
  'block p95 ms',
  'metadata p95 ms',
  'blocked',
  'errors',
];
const lines = [`# DepGate load comparison`, ''];
if (reports[0].baseUrl) lines.push(`Gateway: ${reports[0].baseUrl}`, '');
lines.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);

for (const report of reports) {
  for (const row of report.rows || []) {
    lines.push(
      `| ${[
        report.scenario,
        row.ecosystem,
        row.installs,
        fmt(row.allowed_p95_ms),
        fmt(row.blocked_p95_ms),
        fmt(row.metadata_p95_ms),
        pct(row.blocked_rate),
        pct(row.unexpected_rate),
      ].join(' | ')} |`
    );
  }
}

lines.push(
  '',
  'allow p95 is the file transfer for a package an ALLOW policy served.',
  'block p95 is the rejected download (HTTP 403). PyPI, Composer, and RubyGems time the index response that dropped the pin, because those registries do not hand out a file URL for a blocked version.',
  ''
);

const markdown = `${lines.join('\n')}\n`;
const out = path.join(dir, 'compare.md');
await writeFile(out, markdown);
process.stdout.write(markdown);
console.error(`wrote ${out}`);

function fmt(value) {
  return value === null || value === undefined ? '-' : Number(value).toFixed(0);
}

function pct(value) {
  return value === null || value === undefined ? '-' : `${(Number(value) * 100).toFixed(1)}%`;
}
