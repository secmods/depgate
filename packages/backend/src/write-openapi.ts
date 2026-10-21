import 'dotenv/config';
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.js';

/** Repo-root copy of the OpenAPI document. The running app serves the same document at /api/swagger.yml. */
const out = path.resolve(__dirname, '../../../api/swagger.yml');

async function main(): Promise<void> {
  const app = await buildApp({ docsOnly: true });
  await app.ready();
  const spec = app.swagger({ yaml: true });
  const body = [
    '# Generated from the Fastify route schemas. Do not edit by hand.',
    '# Regenerate: npm run openapi --workspace=@depgate/backend',
    '',
    spec.trimEnd(),
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  await app.close();
  process.stdout.write(`Wrote ${out}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
