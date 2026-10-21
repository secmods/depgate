// Fake npm upstream for Log Streaming tests. No dependencies.
//
//   siem-down-pkg        metadata and tarball answer 503 (DepGate passes it through; no UPSTREAM_UNAVAILABLE)
//   @sindresorhus/*      a well-formed package, so an internal repository serves a name that also exists on
//                        npmjs.org → NAMESPACE_COLLISION_FOUND once it is reserved
//   /epss/*              404, for a failing epss-sync job (JOB_FAILED)
//   anything else        404
import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const BASE = process.env.BASE_URL || `http://fake-npm:${PORT}`;
const TARBALL = Buffer.from('not really a tarball\n');
const INTEGRITY = `sha512-${crypto.createHash('sha512').update(TARBALL).digest('base64')}`;
const SHA1 = crypto.createHash('sha1').update(TARBALL).digest('hex');

function metadata(name) {
  const version = '1.0.0';
  return {
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist: { tarball: `${BASE}/${name}/-/${name.split('/').pop()}-${version}.tgz`, integrity: INTEGRITY, shasum: SHA1 },
      },
    },
    time: { [version]: '2026-01-01T00:00:00.000Z' },
  };
}

http
  .createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const name = path.split('/-/')[0];
    console.log(req.method, req.url);
    if (name === 'siem-down-pkg') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('upstream down on purpose\n');
    }
    if (!name.startsWith('@sindresorhus/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Not found"}');
    }
    if (path.includes('/-/')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': TARBALL.length });
      return res.end(TARBALL);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metadata(name)));
  })
  .listen(PORT, () => console.log(`fake-npm on :${PORT}`));
