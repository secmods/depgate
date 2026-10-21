/**
 * Renders an SVG diagram to a PNG with the site's Inter font, at 2× for sharp text.
 *
 *   node docs/scripts/svg-to-png.mjs docs/public/diagrams/request-flow.svg [out.png] [scale]
 *
 * Default output: the same path with .png. Default scale: 2.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../package.json'));
const { chromium } = require('@playwright/test');

const [input, output, scaleArg] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node docs/scripts/svg-to-png.mjs <file.svg> [out.png] [scale]');
  process.exit(2);
}
const svg = readFileSync(resolve(input), 'utf8');
const out = resolve(output ?? input.replace(/\.svg$/, '.png'));
const scale = Number(scaleArg ?? 2);
const [, , , vbWidth, vbHeight] = /viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/.exec(svg) ?? [];
if (!vbWidth) throw new Error('The SVG needs a viewBox');

const fonts = join(here, '../node_modules/vitepress/dist/client/theme-default/fonts');
const font = (file) => `data:font/woff2;base64,${readFileSync(join(fonts, file)).toString('base64')}`;
const html = `<!doctype html><style>
  @font-face { font-family: Inter; font-weight: 100 900; src: url(${font('inter-roman-latin.woff2')}) format('woff2'); }
  html, body { margin: 0; background: transparent; }
  svg { display: block; width: ${vbWidth}px; height: ${vbHeight}px; }
</style>${svg}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(vbWidth), height: Number(vbHeight) }, deviceScaleFactor: scale });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await page.locator('svg').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`${out} (${Number(vbWidth) * scale}×${Number(vbHeight) * scale})`);
