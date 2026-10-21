// Renders the captured `npm install` output as a terminal screenshot (PNG, 2x).
// Usage: node docs/scripts/terminal-shot.mjs <npm-out.txt> <out.png>
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { TERMINAL_CSS, cleanNpmOutput, highlightNpmLine, terminalWindow } from './terminal-theme.mjs';

const [, , inFile, outFile] = process.argv;
const lines = cleanNpmOutput(readFileSync(inFile, 'utf8')).map((l) => `<div class="line">${highlightNpmLine(l)}</div>`);

const body = `
    <div class="line"><span class="prompt">~/payments-service $</span> <span class="cmd">npm install minimist@1.2.5</span></div>
    ${lines.join('\n')}
    <div class="line dim">&nbsp;</div>
    <div class="line"><span class="prompt">~/payments-service $</span> <span class="dim">█</span></div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: transparent; }
  .win { margin: 24px; }
  ${TERMINAL_CSS}
</style></head><body>${terminalWindow('payments-service — npm', body)}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 940, height: 600 }, deviceScaleFactor: 2 });
await page.setContent(html);
const win = page.locator('.win');
await win.screenshot({ path: outFile, omitBackground: true });
await browser.close();
console.log('wrote', outFile);
