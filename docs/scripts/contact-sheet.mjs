/**
 * Puts screenshots side by side on a few sheet images, so many can be reviewed at once.
 *
 *   node docs/scripts/contact-sheet.mjs <out-dir> [name ...]   names without .png; default: all
 *
 * Writes <out-dir>/sheet-1.png, sheet-2.png, … with 4 screenshots each, labelled with their names.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../package.json'));
const { chromium } = require('@playwright/test');

const [out, ...names] = process.argv.slice(2);
if (!out) {
  console.error('Usage: node docs/scripts/contact-sheet.mjs <out-dir> [name ...]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const dir = join(here, '../public/screenshots');
const files = (names.length ? names.map((n) => `${n}.png`) : readdirSync(dir).filter((f) => f.endsWith('.png'))).sort();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1000 } });
for (let i = 0; i < files.length; i += 4) {
  const cells = files.slice(i, i + 4).map((f) =>
    `<figure><figcaption>${f.replace('.png', '')}</figcaption><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}"></figure>`).join('');
  await page.setContent(`<style>body{margin:0;font:600 18px sans-serif;display:grid;grid-template-columns:1fr 1fr;gap:12px;background:#fff}
    figure{margin:0}figcaption{color:#c00;padding:4px}img{width:100%;border:1px solid #ccc}</style>${cells}`);
  await page.waitForLoadState('load');
  const path = join(out, `sheet-${i / 4 + 1}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(path);
}
await browser.close();
