/**
 * Records the two-minute demo for the README (.github/assets/demo.mp4 and demo.gif).
 *
 * Runs against the seeded screenshot instance (docker-compose.yml and seed.mjs in this folder), started
 * with GATEWAY_URL=http://localhost:3060 so that npm can fetch tarballs from it:
 *
 *   GATEWAY_URL=http://localhost:3060 docker compose -f docs/scripts/docker-compose.yml up -d
 *   node docs/scripts/seed.mjs
 *   FFMPEG=/path/to/ffmpeg node docs/scripts/demo-video.mjs            # FFMPEG defaults to `ffmpeg` on PATH
 *   node docs/scripts/demo-video.mjs --only policy,terminal             # re-record some segments, reuse the rest
 *
 * Five segments, each a Playwright video of a 1440x900 browser (the terminal segment is a page that types the
 * real, captured npm output), stitched with ffmpeg. Needs an ffmpeg with libx264 and the gif encoder
 * (`brew install ffmpeg`, or the `ffmpeg-static` npm package); the one Playwright ships cannot encode H.264.
 *
 *   1. policy     Security creates the policy "Critical vulnerabilities" (CVSS >= 9.0, enforce).
 *   2. terminal   A developer's `npm install minimist@1.2.5` is refused with the 403; `npm install minimist` works.
 *                 Both commands really run against the instance right before the segment is recorded.
 *   3. ledger     The block in the Decision Ledger, with its detail.
 *   4. check      Package check for minimist 1.2.5: blocked, why, and the recommended version.
 *   5. waiver     The developer requests a waiver from Package check and Security approves it.
 *
 * Expects a freshly seeded instance: it deletes the starter "Critical vulnerabilities" policy so the video can
 * create it, and the developer's seeded minimist waiver request so she can request a new one. The approved
 * waiver it leaves behind cannot be deleted, so re-seed (`docker compose ... down -v`) before recording again.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { TERMINAL_CSS, cleanNpmOutput, highlightNpmLine, terminalWindow } from './terminal-theme.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../package.json'));
const { chromium } = require('@playwright/test');

const BASE = process.env.DOCS_BASE_URL ?? 'http://localhost:3060';
const SECURITY = { email: process.env.DOCS_ADMIN_EMAIL ?? 'security@example.com', password: process.env.DOCS_ADMIN_PASSWORD ?? 'docs-demo-admin' };
const DEV = { email: 'alice.chen@example.com', password: 'docs-demo-user' };
const OUT = join(here, '../../.github/assets');
const WORK = process.env.DEMO_WORK_DIR ?? join(tmpdir(), 'depgate-demo');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const SIZE = { width: 1440, height: 900 };
const POLICY_NAME = 'Critical vulnerabilities';
const PKG = 'minimist';
const BAD_VERSION = '1.2.5';

const onlyFlag = process.argv.indexOf('--only');
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? (onlyFlag > 0 ? process.argv[onlyFlag + 1] : '') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const wants = (name) => !only.length || only.includes(name);

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

// ── API helpers ─────────────────────────────────────────────────────────────

async function login(user) {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
  if (!res.ok) throw new Error(`Login failed for ${user.email}: ${res.status}`);
  return res.json();
}

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

/** Puts the instance in the state the storyboard starts from. */
async function prepare(admin, dev) {
  const policies = (await api(admin.token, 'GET', '/api/admin/policies?limit=100')).body.items ?? [];
  for (const p of policies.filter((p) => p.name === POLICY_NAME)) {
    if (!wants('policy')) break;
    const r = await api(admin.token, 'DELETE', `/api/admin/policies/${p.id}`);
    console.log(`  deleted policy "${p.name}" -> ${r.status}`);
  }
  if (!wants('waiver') && !wants('check')) return;
  const waivers = (await api(dev.token, 'GET', '/api/waiver-requests')).body.items ?? [];
  for (const w of waivers.filter((w) => w.packageName === PKG && w.status !== 'approved')) {
    const r = await api(dev.token, 'DELETE', `/api/waiver-requests/${w.id}`);
    console.log(`  deleted waiver request ${w.packageName}@${w.version} (${w.status}) -> ${r.status}`);
  }
  const exceptions = (await api(admin.token, 'GET', '/api/admin/exceptions?limit=100')).body.items ?? [];
  for (const e of exceptions.filter((e) => e.packageName === PKG)) {
    const r = await api(admin.token, 'DELETE', `/api/admin/exceptions/${e.id}`);
    console.log(`  deleted exception ${e.packageName}@${e.version ?? e.versionRange} -> ${r.status}`);
  }
}

// ── Browser helpers ─────────────────────────────────────────────────────────

const browser = await chromium.launch();

/** A caption bar at the bottom of every page and a visible mouse pointer, so a viewer can follow the clicks. */
const OVERLAY_SCRIPT = `(() => {
  const caption = ${JSON.stringify('')};
  function mount() {
    if (document.getElementById('demo-cursor')) return;
    const style = document.createElement('style');
    style.textContent = \`
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 30px; pointer-events: none; z-index: 2147483647;
        transform: translate(-3px, -2px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); transition: transform .08s; }
      #demo-cursor.down { transform: translate(-3px, -2px) scale(.85); }
      #demo-ring { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; pointer-events: none;
        z-index: 2147483646; border: 3px solid #6366f1; opacity: 0; transform: scale(.4); }
      #demo-ring.go { animation: demo-ring .5s ease-out; }
      @keyframes demo-ring { 0% { opacity: .9; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.4); } }
      #demo-caption { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 2147483645; pointer-events: none;
        background: rgba(15, 23, 42, .92); color: #f8fafc; font: 500 15px/1.3 -apple-system, "Segoe UI", Inter, sans-serif;
        padding: 10px 18px; border-radius: 999px; box-shadow: 0 8px 24px rgba(2, 6, 23, .35); white-space: nowrap; display: none; }
      #demo-caption b { color: #a5b4fc; font-weight: 600; margin-right: 10px; }
    \`;
    document.head.appendChild(style);
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z" fill="#fff" stroke="#111827" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const ring = document.createElement('div');
    ring.id = 'demo-ring';
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    document.documentElement.append(cursor, ring, cap);
    let x = -100, y = -100;
    const place = () => { cursor.style.left = x + 'px'; cursor.style.top = y + 'px'; };
    place();
    window.addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; place(); }, true);
    window.addEventListener('mousedown', () => {
      cursor.classList.add('down');
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
    }, true);
    window.addEventListener('mouseup', () => cursor.classList.remove('down'), true);
    window.__demoCaption = (step, text) => {
      if (!text) { cap.style.display = 'none'; return; }
      cap.innerHTML = '<b>' + step + '</b>' + text;
      cap.style.display = 'block';
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();`;

/**
 * A recording context signed in as `who` (the session token is placed in sessionStorage, where the UI keeps it,
 * so the video starts on the first page instead of the login form).
 */
async function recorder(name, who) {
  const dir = join(WORK, 'video', name);
  rmSync(dir, { recursive: true, force: true });
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'light', recordVideo: { dir, size: SIZE } });
  if (who) {
    await context.addInitScript(({ token, registryToken }) => {
      sessionStorage.setItem('depgate_token', token);
      if (registryToken) sessionStorage.setItem('depgate_registry_token', registryToken);
    }, { token: who.token, registryToken: who.registryToken });
  }
  await context.addInitScript(OVERLAY_SCRIPT);
  const page = await context.newPage();
  const started = Date.now();
  return {
    page,
    async finish() {
      const seconds = (Date.now() - started) / 1000;
      const video = page.video();
      await context.close();
      const out = join(WORK, `${name}.webm`);
      await video.saveAs(out);
      console.log(`  ${name}: ${seconds.toFixed(1)}s -> ${out}`);
      return out;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const caption = (page, step, text) => page.evaluate(([s, t]) => window.__demoCaption?.(s, t), [step, text]);

/** Moves the pointer to the element in visible steps, then clicks it. */
async function click(page, locator, { pause = 700 } = {}) {
  await locator.first().scrollIntoViewIfNeeded();
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`No box for ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await sleep(250);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(pause);
}

async function type(page, locator, text, { delay = 55, pause = 500 } = {}) {
  await click(page, locator, { pause: 200 });
  await locator.first().pressSequentially(text, { delay });
  await sleep(pause);
}

async function open(page, path, step, text) {
  await page.goto(BASE + path);
  await page.waitForLoadState('networkidle');
  await caption(page, step, text);
  await sleep(900);
}

// ── Segments ────────────────────────────────────────────────────────────────

async function segmentPolicy(admin) {
  const { page, finish } = await recorder('1-policy', admin);
  await open(page, '/policies', 'Step 1 of 5', 'Security creates a policy');
  await sleep(1500);
  await click(page, page.getByRole('button', { name: 'New policy' }));
  await page.waitForURL(/\/policies\/new/);
  await page.waitForLoadState('networkidle');
  await caption(page, 'Step 1 of 5', 'Security creates a policy');
  await sleep(800);
  await type(page, page.locator('#policy-name'), POLICY_NAME);
  await type(page, page.locator('#policy-description'), 'Any vulnerability rated Critical (CVSS 9.0 or higher).', { delay: 28 });
  await click(page, page.getByTestId('policy-rule-vulnerability'), { pause: 900 });
  await type(page, page.getByTestId('cvss-min'), '9.0', { delay: 120, pause: 600 });
  await click(page, page.getByTestId('policy-mode-enforce'), { pause: 600 });
  // Let the Summary panel's sentence sink in.
  const summary = page.getByTestId('policy-summary-panel');
  await summary.scrollIntoViewIfNeeded();
  const box = await summary.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 20 });
  await sleep(3500);
  await click(page, page.getByTestId('policy-save'), { pause: 300 });
  await page.waitForURL((url) => url.pathname === '/policies');
  await page.waitForLoadState('networkidle');
  await caption(page, 'Step 1 of 5', 'The policy applies to every download, within seconds');
  await sleep(1200);
  await centre(page, page.getByRole('row', { name: new RegExp(POLICY_NAME) }).last());
  await sleep(3000);
  return finish();
}

/** Smooth-scrolls the element to the middle of the viewport, clear of the caption bar. */
async function centre(page, locator) {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' })).catch(() => {});
  await sleep(900);
}

/** Really installs through the gateway as the developer and returns npm's output, verbatim. */
function runNpm(registryToken) {
  const project = join(WORK, 'payments-service');
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'payments-service', version: '1.0.0', private: true }, null, 2) + '\n');
  const host = BASE.replace(/^https?:/, '');
  writeFileSync(join(project, '.npmrc'), `registry=${BASE}/npm/default/\n${host}/npm/default/:_authToken=${registryToken}\n`);
  const run = (args) => {
    const r = spawnSync('npm', [...args, '--no-fund', '--no-audit', '--no-update-notifier'], { cwd: project, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const blocked = run(['install', `${PKG}@${BAD_VERSION}`]);
  if (blocked.status === 0 || !/403/.test(blocked.output)) throw new Error(`Expected npm to be refused with 403:\n${blocked.output}`);
  const allowed = run(['install', PKG]);
  if (allowed.status !== 0) throw new Error(`Expected npm install ${PKG} to succeed:\n${allowed.output}`);
  writeFileSync(join(WORK, 'npm-blocked.txt'), blocked.output);
  writeFileSync(join(WORK, 'npm-allowed.txt'), allowed.output);
  const installed = JSON.parse(readFileSync(join(project, 'node_modules', PKG, 'package.json'), 'utf8')).version;
  console.log(`  npm install ${PKG}@${BAD_VERSION}: refused (403); npm install ${PKG}: ${installed}`);
  return { blocked: cleanNpmOutput(blocked.output), allowed: cleanNpmOutput(allowed.output) };
}

async function segmentTerminal(npm) {
  const { page, finish } = await recorder('2-terminal', null);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body { display: flex; align-items: center; justify-content: center;
           background: radial-gradient(1200px 700px at 50% 40%, #e0e7ff 0%, #eef2ff 45%, #f8fafc 100%); }
    ${TERMINAL_CSS}
    .win { width: 1100px; min-height: 480px; }
    .body { font-size: 17px; line-height: 1.6; padding: 22px 28px 28px; }
    .bar { height: 42px; }
  </style></head><body>${terminalWindow('payments-service — npm', '<div id="lines"></div>')}</body></html>`;
  await page.setContent(html);
  await page.evaluate(OVERLAY_SCRIPT);
  await caption(page, 'Step 2 of 5', 'A developer installs through DepGate');
  await sleep(1200);

  const lines = page.locator('#lines');
  const add = (html) => lines.evaluate((el, h) => { el.insertAdjacentHTML('beforeend', h); }, html);
  const prompt = '<span class="prompt">~/payments-service $</span> ';
  async function command(cmd) {
    await add(`<div class="line" id="cmd">${prompt}<span class="cmd"></span><span class="cursor"></span></div>`);
    await sleep(600);
    for (const ch of cmd) {
      await page.evaluate((c) => { const el = document.querySelector('#cmd .cmd'); el.textContent += c; }, ch);
      await sleep(ch === ' ' ? 140 : 70);
    }
    await sleep(700);
    await page.evaluate(() => { const el = document.getElementById('cmd'); el.querySelector('.cursor')?.remove(); el.removeAttribute('id'); });
  }
  async function output(outLines, delay) {
    for (const l of outLines) {
      await add(`<div class="line">${highlightNpmLine(l)}</div>`);
      await sleep(delay);
    }
  }

  await command(`npm install ${PKG}@${BAD_VERSION}`);
  await sleep(900);
  await output(npm.blocked, 260);
  await add(`<div class="line">${prompt}<span class="cursor"></span></div>`);
  await caption(page, 'Step 2 of 5', 'Refused: HTTP 403 names the policy and the CVE');
  await sleep(6000);

  await page.evaluate(() => document.querySelector('#lines > .line:last-child')?.remove());
  await command(`npm install ${PKG}`);
  await sleep(700);
  await output(npm.allowed, 200);
  await add(`<div class="line">${prompt}<span class="cursor"></span></div>`);
  await caption(page, 'Step 2 of 5', 'The newest version is allowed and installs normally');
  await sleep(4500);
  return finish();
}

async function segmentLedger(admin) {
  const { page, finish } = await recorder('3-ledger', admin);
  await open(page, '/audit', 'Step 3 of 5', 'Every decision is in the Decision Ledger');
  await sleep(2000);
  const row = page.getByTestId('ledger-table').locator('tr.is-clickable').filter({ hasText: PKG }).filter({ hasText: BAD_VERSION }).first();
  await row.waitFor({ timeout: 15000 });
  await click(page, row, { pause: 1200 });
  await caption(page, 'Step 3 of 5', 'Who asked, which policy refused it, and why');
  await sleep(7000);
  return finish();
}

async function segmentCheck(dev) {
  const { page, finish } = await recorder('4-check', dev);
  await open(page, '/package-check', 'Step 4 of 5', 'Developers can check a package before installing');
  await sleep(800);
  await type(page, page.locator('input[name="package"]'), PKG, { delay: 70 });
  await type(page, page.locator('input[name="version"]'), BAD_VERSION, { delay: 110 });
  await click(page, page.getByRole('button', { name: 'Check' }), { pause: 300 });
  await page.getByTestId('requested-version').waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await sleep(600);
  // The Project health card comes first; bring the verdict panels into the middle of the screen.
  await centre(page, page.getByTestId('requested-version'));
  await caption(page, 'Step 4 of 5', '1.2.5 is blocked, with the reason and the version to use instead');
  await sleep(6500);
  await page.mouse.wheel(0, 360);
  await sleep(3500);
  return finish();
}

async function segmentWaiver(admin, dev) {
  // The developer asks for a waiver from Package check…
  const { page, finish } = await recorder('5a-waiver-request', dev);
  await open(page, `/package-check?ecosystem=npm&package=${PKG}&version=${BAD_VERSION}&repository=default`, 'Step 5 of 5', 'Need the blocked version anyway? Request a waiver');
  await page.getByTestId('requested-version').waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle');
  await centre(page, page.getByTestId('requested-version'));
  await sleep(800);
  await click(page, page.getByTestId('requested-version').getByRole('button', { name: 'Request waiver' }), { pause: 900 });
  await type(page, page.locator('#waiver-reason'), 'Pinned by a vendored CLI in the release branch; the upgrade to 1.2.8 ships next sprint (PAY-412).', { delay: 22 });
  await click(page, page.getByRole('button', { name: 'Submit request' }), { pause: 500 });
  await page.getByText('Waiver pending').first().waitFor({ timeout: 15000 }).catch(() => {});
  await centre(page, page.getByTestId('requested-version'));
  await caption(page, 'Step 5 of 5', 'Submitted. Security sees it in their queue');
  await sleep(3000);
  const first = await finish();

  // …and Security approves it.
  const sec = await recorder('5b-waiver-approve', admin);
  const p = sec.page;
  await open(p, '/exceptions', 'Step 5 of 5', 'Security reviews the request');
  await click(p, p.getByRole('tab', { name: /Waiver requests/ }), { pause: 1200 });
  const row = p.getByRole('row').filter({ hasText: PKG }).filter({ hasText: BAD_VERSION }).first();
  await row.waitFor({ timeout: 15000 });
  await click(p, row.getByRole('button', { name: 'Review' }), { pause: 1500 });
  await click(p, p.getByRole('button', { name: 'Approve', exact: true }), { pause: 800 });
  await type(p, p.locator('#review-note'), 'Approved for the release branch only. Please upgrade in PAY-412.', { delay: 22 });
  await click(p, p.getByRole('button', { name: 'Approve waiver' }), { pause: 800 });
  await caption(p, 'Step 5 of 5', 'An exception now allows minimist 1.2.5, until it expires');
  await sleep(4500);
  const second = await sec.finish();
  return [first, second];
}

// ── Assembly ────────────────────────────────────────────────────────────────

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

function duration(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...(r.stderr ?? '').matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop();
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/** Playwright's first frames are the blank page before navigation; drop them. */
const LEAD_IN = 0.6;

function assemble(clips) {
  const mp4 = join(OUT, 'demo.mp4');
  const gif = join(OUT, 'demo.gif');
  const inputs = clips.flatMap((c) => ['-ss', String(LEAD_IN), '-i', c]);
  const chain = clips.map((_, i) => `[${i}:v]fps=30,scale=${SIZE.width}:${SIZE.height}:flags=lanczos,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`).join(';');
  const concat = clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0,format=yuv420p[out]`;
  ffmpeg([...inputs, '-filter_complex', `${chain};${concat}`, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-tune', 'stillimage', '-movflags', '+faststart', mp4]);

  // GIF: palette per scene, bayer dither, only changed rectangles re-encoded. Shrink until it fits in 8 MB.
  for (const [width, fps, colors] of [[960, 12, 128], [900, 10, 96], [800, 10, 64], [720, 8, 64]]) {
    const filters = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    ffmpeg(['-i', mp4, '-filter_complex', filters, '-loop', '0', gif]);
    const bytes = statSize(gif);
    console.log(`  demo.gif ${width}px ${fps}fps ${colors} colours: ${(bytes / 1e6).toFixed(1)} MB`);
    if (bytes < 8e6) break;
  }
  return { mp4, gif };
}

function statSize(file) {
  return readFileSync(file).byteLength;
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log(`Recording against ${BASE} (work dir ${WORK})`);
const admin = await login(SECURITY);
const dev = await login(DEV);
await prepare(admin, dev);

const clips = {};
const keep = (name) => join(WORK, `${name}.webm`);
try {
  if (wants('policy')) clips.policy = await segmentPolicy(admin);
  if (wants('terminal')) clips.terminal = await segmentTerminal(runNpm(dev.registryToken));
  if (wants('ledger')) clips.ledger = await segmentLedger(admin);
  if (wants('check')) clips.check = await segmentCheck(dev);
  if (wants('waiver')) [clips.waiverRequest, clips.waiverApprove] = await segmentWaiver(admin, dev);
} finally {
  await browser.close();
}

const order = [
  ['policy', '1-policy'], ['terminal', '2-terminal'], ['ledger', '3-ledger'], ['check', '4-check'],
  ['waiverRequest', '5a-waiver-request'], ['waiverApprove', '5b-waiver-approve'],
].map(([key, file]) => clips[key] ?? keep(file)).filter((f) => existsSync(f));
if (!order.length) throw new Error('No clips recorded');
if (order.length < 6) console.warn(`  only ${order.length} of 6 clips present; assembling what is there`);

console.log('Assembling');
const { mp4, gif } = assemble(order);
copyFileSync(join(WORK, 'npm-blocked.txt'), join(WORK, 'npm-blocked.last.txt'));
const total = duration(mp4);
console.log(`\nSegments (after the ${LEAD_IN}s lead-in is trimmed):`);
for (const f of order) console.log(`  ${f.split('/').pop().padEnd(24)} ${Math.max(0, duration(f) - LEAD_IN).toFixed(1)}s`);
console.log(`\n${mp4}: ${(statSize(mp4) / 1e6).toFixed(1)} MB, ${total.toFixed(1)}s`);
console.log(`${gif}: ${(statSize(gif) / 1e6).toFixed(1)} MB`);
