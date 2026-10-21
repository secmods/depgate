// The terminal look shared by terminal-shot.mjs (README screenshot) and demo-video.mjs (demo recording):
// a dark macOS-style window with npm's output highlighted. Keep both renderings identical by changing it here.

/** Drops npm's log-file line and the policy ID, which npm masks anyway. */
export function cleanNpmOutput(raw) {
  return raw
    .split('\n')
    .filter((l) => l.trim() && !l.includes('A complete log of this run'))
    .map((l) => l.replace(/ \(ID: [^)]*\)/, '').replace(/\s+$/, ''));
}

export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One line of npm output as HTML, with the error code, the policy, the CVE and the CVSS score coloured. */
export function highlightNpmLine(line) {
  let html = esc(line);
  html = html.replace(/^npm error/, '<span class="err">npm error</span>');
  html = html.replace(/(code E403|403 403 Forbidden)/, '<span class="code">$1</span>');
  html = html.replace(/(Package blocked by policy &quot;[^&]*&quot;)/, '<span class="pol">$1</span>');
  html = html.replace(/(CVE-\d{4}-\d+|GHSA-[a-z0-9-]+)/g, '<span class="cve">$1</span>');
  html = html.replace(/(CVSS 3\.1 9\.8|CVSS [0-9.]+ [0-9.]+)/, '<span class="cvss">$1</span>');
  html = html.replace(/^(added \d+ packages? in [^<]*)/, '<span class="ok">$1</span>');
  return html;
}

export const TERMINAL_CSS = `
  .win { width: 880px; border-radius: 12px; overflow: hidden;
         background: #0f172a; box-shadow: 0 20px 50px rgba(2,6,23,.45); font-family: "SF Mono", Menlo, Consolas, monospace; }
  .bar { height: 38px; background: #1e293b; display: flex; align-items: center; padding: 0 14px; gap: 8px; position: relative; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { position: absolute; left: 0; right: 0; text-align: center; color: #94a3b8; font-size: 13px; font-family: -apple-system, "Segoe UI", sans-serif; }
  .body { padding: 18px 22px 22px; color: #e2e8f0; font-size: 14px; line-height: 1.55; }
  .prompt { color: #a5b4fc; }
  .cmd { color: #f8fafc; font-weight: 600; }
  .line { white-space: pre-wrap; word-break: break-word; }
  .err { color: #f87171; }
  .code { color: #fbbf24; }
  .pol { color: #c4b5fd; font-weight: 600; }
  .cve { color: #fda4af; }
  .cvss { color: #fb7185; font-weight: 600; }
  .ok { color: #86efac; }
  .dim { color: #64748b; }
  .cursor { display: inline-block; width: .6em; height: 1.1em; background: #cbd5e1; vertical-align: -0.2em; animation: blink 1s steps(1) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
`;

/** The window chrome. `title` is the tab title, `bodyHtml` the lines inside. */
export function terminalWindow(title, bodyHtml) {
  return `<div class="win">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div><div class="dot" style="background:#febc2e"></div><div class="dot" style="background:#28c840"></div>
    <div class="title">${esc(title)}</div>
  </div>
  <div class="body">${bodyHtml}</div>
</div>`;
}
