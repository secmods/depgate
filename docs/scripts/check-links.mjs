/**
 * Checks the built site (docs/.vitepress/dist) for broken #anchors and for images that are
 * missing or unused. `vitepress build` already fails on dead page links; it does not check these.
 *
 *   npm --prefix docs run build && node docs/scripts/check-links.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(docs, '.vitepress/dist');
if (!existsSync(dist)) {
  console.error('No build found. Run: npm --prefix docs run build');
  process.exit(2);
}

const walk = (dir, ext, skip = []) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skip.includes(entry.name) ? [] : walk(path, ext, skip);
    return path.endsWith(ext) ? [path] : [];
  });

const ids = new Map(walk(dist, '.html').map((file) => [file, new Set([...readFileSync(file, 'utf8').matchAll(/id="([^"]+)"/g)].map((m) => m[1]))]));
const pages = walk(docs, '.md', ['node_modules', 'scripts', '.vitepress', 'public']);
const problems = [];
const usedImages = new Set();

for (const md of pages) {
  const text = readFileSync(md, 'utf8');
  const rel = relative(docs, md);
  for (const [, link, anchor] of text.matchAll(/\]\(([^)\s#]*)#([^)\s]+)\)/g)) {
    if (/^https?:/.test(link)) continue;
    let target;
    if (!link) target = rel;
    else if (link.startsWith('/')) target = link.slice(1);
    else target = normalize(join(dirname(rel), link));
    target = target.replace(/\.md$/, '');
    const html = join(dist, `${target}.html`);
    if (!ids.get(html)?.has(anchor)) problems.push(`${rel}: broken anchor ${link}#${anchor}`);
  }
  for (const [, image] of text.matchAll(/\]\(\/((?:screenshots|diagrams)\/[^)\s]+)\)/g)) {
    usedImages.add(image);
    if (!existsSync(join(docs, 'public', image))) problems.push(`${rel}: missing image /${image}`);
  }
}
for (const file of readdirSync(join(docs, 'public/screenshots'))) {
  if (!usedImages.has(`screenshots/${file}`)) problems.push(`unused screenshot: public/screenshots/${file}`);
}

if (problems.length) {
  console.log(problems.join('\n'));
  process.exit(1);
}
console.log(`OK: ${pages.length} pages, ${usedImages.size} images, every anchor resolves`);
