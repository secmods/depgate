import http from 'k6/http';
import { packagesFor } from './catalog.js';
import {
  asGateway,
  authHeaders,
  baseUrl,
  batchGet,
  bodyJson,
  decodeEntities,
  finishPackage,
  joinUrl,
  missingVersionOutcome,
  recordArtifact,
  recordHttp,
  recordStoppedDownload,
  repo,
  series,
  skipDownload,
  timeout,
} from './client.js';

const AGENTS = {
  npm: 'npm/10.9.2 node/v22.14.0 darwin arm64 workspaces/false',
  pypi: 'pip/24.3.1',
  go: 'Go-http-client/1.1',
  maven: 'Apache-Maven/3.9.9 (Java 21)',
  nuget: 'NuGet .NET Core MSBuild Task/6.11.1',
  cargo: 'cargo/1.83.0',
  composer: 'Composer/2.8.4 (Linux; 8.3; PHP)',
  rubygems: 'Ruby, RubyGems/3.5.22',
};

function headers(eco, token, accept) {
  const extra = {};
  if (eco === 'npm') extra['npm-command'] = 'ci';
  return Object.assign(authHeaders(token, AGENTS[eco], accept), extra);
}

function begin(eco) {
  return Date.now();
}

function end(eco, started) {
  series[eco].install.add(Date.now() - started);
  series[eco].installs.add(1);
}

/**
 * npm ci: abbreviated packument, then the tarball.
 * A version removed by policy is still requested at its tarball URL so the 403 is timed.
 */
export function installNpm(data) {
  const eco = 'npm';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/vnd.npm.install-v1+json');
  const metas = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/npm/${repo}/${pkg.name}`) })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', metas[i], pkg.name);
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'packument');
      return;
    }
    const doc = bodyJson(metas[i]);
    const version = doc && doc.versions ? doc.versions[pkg.version] : null;
    const fromMeta = version ? asGateway(version.dist && version.dist.tarball) : null;
    downloads.push({ pkg, url: fromMeta || npmTarball(pkg), listed: Boolean(fromMeta) });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * pip: GET /simple/{name}/, pick the pinned wheel (any wheel, then the sdist), download it.
 */
export function installPypi(data) {
  const eco = 'pypi';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'text/html, application/vnd.pypi.simple.v1+html');
  const metas = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/pypi/${repo}/simple/${pkg.name}/`) })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', metas[i], pkg.name);
    if (kind === 'block') {
      recordStoppedDownload(eco, metas[i]);
      finishPackage(eco, data.scenario, pkg, 'block', 'simple index 403');
      return;
    }
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'simple index');
      return;
    }
    const href = pickPypiFile(String(metas[i].body || ''), pkg.name, pkg.version);
    const fileUrl = href ? asGateway(href) : null;
    if (!fileUrl) {
      if (!href) noteFiltered(eco, data, pkg, metas[i], 'file filtered');
      else finishPackage(eco, data.scenario, pkg, 'error', 'artifact URL was not rewritten to the gateway');
      return;
    }
    downloads.push({ pkg, url: fileUrl, listed: true });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * go mod download for a known version: .info, then .mod, then .zip.
 * A blocked .info still requests the zip so the 403 download is timed.
 */
export function installGo(data) {
  const eco = 'go';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/json');
  const infos = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/go/${repo}/${pkg.name}/@v/${pkg.version}.info`) })),
    hdrs,
    eco,
    'metadata'
  );
  const mods = [];
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', infos[i], pkg.name);
    if (kind === 'error') finishPackage(eco, data.scenario, pkg, 'error', '.info');
    else if (kind === 'block') downloads.push({ pkg, url: goZip(pkg), listed: false });
    else mods.push(pkg);
  });
  const modRes = batchGet(
    mods.map((pkg) => ({ url: joinUrl(baseUrl, `/go/${repo}/${pkg.name}/@v/${pkg.version}.mod`) })),
    hdrs,
    eco,
    'metadata'
  );
  mods.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', modRes[i], pkg.name);
    if (kind === 'error') finishPackage(eco, data.scenario, pkg, 'error', '.mod');
    else downloads.push({ pkg, url: goZip(pkg), listed: kind === 'ok' });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * Maven resolve of a pinned version: the POM, then the jar.
 * A blocked POM still requests the jar so the 403 download is timed.
 */
export function installMaven(data) {
  const eco = 'maven';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/xml, application/octet-stream');
  const poms = batchGet(
    pkgs.map((pkg) => ({ url: mavenFile(pkg, 'pom') })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', poms[i], pkg.name);
    if (kind === 'error') finishPackage(eco, data.scenario, pkg, 'error', 'pom');
    else downloads.push({ pkg, url: mavenFile(pkg, 'jar'), listed: kind === 'ok' });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * dotnet restore: service index, flat-container index, then the nupkg when the
 * pinned version is still listed.
 */
export function installNuget(data) {
  const eco = 'nuget';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/json');
  const indexUrl = joinUrl(baseUrl, `/nuget/${repo}/v3/index.json`);
  const indexRes = batchGet([{ url: indexUrl }], hdrs, eco, 'metadata')[0];
  recordHttp(eco, 'metadata', indexRes, 'v3/index.json');
  const container = nugetContainer(indexRes);
  const lists = batchGet(
    pkgs.map((pkg) => ({ url: `${container}${pkg.name}/index.json` })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', lists[i], pkg.name);
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'flat container index');
      return;
    }
    const doc = bodyJson(lists[i]);
    const versions = doc && Array.isArray(doc.versions) ? doc.versions : [];
    const present = versions.some((v) => String(v).toLowerCase() === pkg.version.toLowerCase());
    downloads.push({
      pkg,
      url: nugetNupkg(pkg, container),
      listed: kind === 'ok' && present,
    });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * Cargo through Depgate's crates.io API routes: crate metadata, then download.
 */
export function installCargo(data) {
  const eco = 'cargo';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/json');
  const metas = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/cargo/${repo}/api/v1/crates/${pkg.name}`) })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', metas[i], pkg.name);
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'crate metadata');
      return;
    }
    const row = cargoVersion(bodyJson(metas[i]), pkg.version);
    downloads.push({ pkg, url: cargoDownload(pkg, row || {}), listed: Boolean(row) });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * Composer 2: root packages.json, then p2 metadata, then the rewritten dist archive.
 */
export function installComposer(data) {
  const eco = 'composer';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/json');
  const root = batchGet([{ url: joinUrl(baseUrl, `/composer/${repo}/packages.json`) }], hdrs, eco, 'metadata')[0];
  recordHttp(eco, 'metadata', root, 'packages.json');
  const metas = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/composer/${repo}/p2/${pkg.name}.json`) })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', metas[i], pkg.name);
    if (kind === 'block') {
      recordStoppedDownload(eco, metas[i]);
      finishPackage(eco, data.scenario, pkg, 'block', 'metadata 403');
      return;
    }
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'p2 metadata');
      return;
    }
    const dist = composerDist(bodyJson(metas[i]), pkg);
    const fileUrl = dist ? asGateway(dist) : null;
    if (!fileUrl) {
      if (!dist) noteFiltered(eco, data, pkg, metas[i], 'version filtered');
      else finishPackage(eco, data.scenario, pkg, 'error', 'dist URL was not rewritten to the gateway');
      return;
    }
    downloads.push({ pkg, url: fileUrl, listed: true });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

/**
 * RubyGems dependency API: version list, then the gem_uri Depgate rewrote.
 */
export function installRubygems(data) {
  const eco = 'rubygems';
  const started = begin(eco);
  const pkgs = packagesFor(eco);
  const hdrs = headers(eco, data.token, 'application/json');
  const metas = batchGet(
    pkgs.map((pkg) => ({ url: joinUrl(baseUrl, `/rubygems/${repo}/api/v1/versions/${pkg.name}.json`) })),
    hdrs,
    eco,
    'metadata'
  );
  const downloads = [];
  pkgs.forEach((pkg, i) => {
    const kind = recordHttp(eco, 'metadata', metas[i], pkg.name);
    if (kind === 'block') {
      recordStoppedDownload(eco, metas[i]);
      finishPackage(eco, data.scenario, pkg, 'block', 'metadata 403');
      return;
    }
    if (kind === 'error') {
      finishPackage(eco, data.scenario, pkg, 'error', 'version list');
      return;
    }
    const gemUri = rubyGemUri(bodyJson(metas[i]), pkg.version);
    const fileUrl = gemUri ? asGateway(gemUri) : null;
    if (!fileUrl) {
      if (!gemUri) noteFiltered(eco, data, pkg, metas[i], 'version filtered');
      else finishPackage(eco, data.scenario, pkg, 'error', 'gem URI was not rewritten to the gateway');
      return;
    }
    downloads.push({ pkg, url: fileUrl, listed: true });
  });
  fetchArtifacts(eco, data, hdrs, downloads);
  end(eco, started);
}

function noteFiltered(eco, data, pkg, res, detail) {
  const outcome = missingVersionOutcome(data.scenario);
  if (outcome === 'block') recordStoppedDownload(eco, res);
  finishPackage(eco, data.scenario, pkg, outcome, detail);
}

function fetchArtifacts(eco, data, hdrs, downloads) {
  if (skipDownload) {
    downloads.forEach((item) => {
      const outcome = item.listed === false ? missingVersionOutcome(data.scenario) : 'allow';
      finishPackage(eco, data.scenario, item.pkg, outcome, item.listed === false ? 'version filtered' : 'skip download');
    });
    return;
  }
  const responses = batchGet(downloads, hdrs, eco, 'artifact');
  downloads.forEach((item, i) => {
    const outcome = recordArtifact(eco, responses[i], item.pkg.name);
    finishPackage(eco, data.scenario, item.pkg, outcome, outcome === 'allow' ? '' : 'artifact');
  });
}

/**
 * One request that proves a pin is blocked (403) or served (200).
 * Direct artifact URLs are used where the client can build them. Signed-URL
 * registries are judged by whether the index still contains the pin.
 */
export function observePin(eco, pkg, token) {
  const hdrs = headers(eco, token, '*/*');
  const params = { headers: hdrs, timeout, tags: { phase: 'admin' } };
  const direct = directArtifactUrl(eco, pkg);
  if (direct) {
    return http.get(direct, Object.assign({ responseType: 'none' }, params)).status;
  }
  const url = metadataUrl(eco, pkg);
  const res = http.get(url, Object.assign({ responseType: 'text' }, params));
  if (res.status !== 200) return res.status;
  const file = downloadFromMetadata(eco, pkg, res);
  if (!file) return 403;
  return http.get(file, Object.assign({ responseType: 'none' }, params)).status;
}

function npmTarball(pkg) {
  const baseName = String(pkg.name).split('/').pop();
  return joinUrl(baseUrl, `/npm/${repo}/${pkg.name}/-/${baseName}-${pkg.version}.tgz`);
}

function goZip(pkg) {
  return joinUrl(baseUrl, `/go/${repo}/${pkg.name}/@v/${pkg.version}.zip`);
}

function nugetNupkg(pkg, container) {
  const root = container || `${baseUrl}/nuget/${repo}/v3-flatcontainer/`;
  const base = root.endsWith('/') ? root : `${root}/`;
  return `${base}${pkg.name}/${pkg.version}/${pkg.name}.${pkg.version}.nupkg`;
}

export function directArtifactUrl(eco, pkg) {
  if (eco === 'npm') return npmTarball(pkg);
  if (eco === 'go') return goZip(pkg);
  if (eco === 'maven') return mavenFile(pkg, 'jar');
  if (eco === 'nuget') return nugetNupkg(pkg);
  if (eco === 'cargo') return joinUrl(baseUrl, `/cargo/${repo}/api/v1/crates/${pkg.name}/${pkg.version}/download`);
  return null;
}

function metadataUrl(eco, pkg) {
  if (eco === 'pypi') return joinUrl(baseUrl, `/pypi/${repo}/simple/${pkg.name}/`);
  if (eco === 'composer') return joinUrl(baseUrl, `/composer/${repo}/p2/${pkg.name}.json`);
  if (eco === 'rubygems') return joinUrl(baseUrl, `/rubygems/${repo}/api/v1/versions/${pkg.name}.json`);
  return null;
}

function downloadFromMetadata(eco, pkg, res) {
  if (eco === 'pypi') {
    const href = pickPypiFile(String(res.body || ''), pkg.name, pkg.version);
    return href ? asGateway(href) : null;
  }
  if (eco === 'composer') {
    const dist = composerDist(bodyJson(res), pkg);
    return dist ? asGateway(dist) : null;
  }
  if (eco === 'rubygems') {
    const gemUri = rubyGemUri(bodyJson(res), pkg.version);
    return gemUri ? asGateway(gemUri) : null;
  }
  return null;
}

function pickPypiFile(html, name, version) {
  const wantName = name.toLowerCase().replace(/[-_.]+/g, '');
  // Depgate puts the token on the href and leaves the filename in the anchor text.
  const re = /<a\b([^>]*)>([^<]*)<\/a>/gi;
  const matches = [];
  let match;
  while ((match = re.exec(html))) {
    const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(match[1]);
    if (!hrefMatch) continue;
    const file = decodeEntities(match[2]).trim().toLowerCase();
    const flat = file.replace(/[-_.]+/g, '');
    const versionHit = file.includes(`-${version}-`) || file.includes(`-${version}.`);
    if (flat.includes(wantName) && versionHit) {
      matches.push({ href: decodeEntities(hrefMatch[1]), file });
    }
  }
  const wheels = matches.filter((item) => item.file.endsWith('.whl'));
  const best =
    wheels.find((item) => item.file.includes('py3-none-any') || item.file.includes('py2.py3-none-any')) ||
    wheels[0] ||
    matches[0];
  return best ? best.href : null;
}

function mavenFile(pkg, ext) {
  const artifact = pkg.path.split('/').pop();
  return joinUrl(baseUrl, `/maven/${repo}/${pkg.path}/${pkg.version}/${artifact}-${pkg.version}.${ext}`);
}

function nugetContainer(indexRes) {
  const fallback = `${baseUrl}/nuget/${repo}/v3-flatcontainer/`;
  const doc = bodyJson(indexRes);
  const resources = doc && Array.isArray(doc.resources) ? doc.resources : [];
  const hit = resources.find((row) => typeof row['@type'] === 'string' && row['@type'].indexOf('PackageBaseAddress') === 0);
  const rewritten = hit ? asGateway(hit['@id']) : null;
  if (!rewritten) return fallback;
  return rewritten.endsWith('/') ? rewritten : `${rewritten}/`;
}

function cargoVersion(doc, version) {
  const versions = doc && Array.isArray(doc.versions) ? doc.versions : [];
  return versions.find((row) => row && row.num === version) || null;
}

function cargoDownload(pkg, row) {
  const dl = row.dl_path || '';
  if (dl.startsWith('/api/') || dl.startsWith('api/')) {
    return joinUrl(baseUrl, `/cargo/${repo}/${dl.replace(/^\//, '')}`);
  }
  return asGateway(dl) || joinUrl(baseUrl, `/cargo/${repo}/api/v1/crates/${pkg.name}/${pkg.version}/download`);
}

function composerDist(doc, pkg) {
  const versions = composerVersions(doc, pkg.name);
  const want = pkg.version.replace(/^v/, '');
  const row = versions.find((entry) => {
    const raw = String(entry.version || entry.version_normalized || '').replace(/^v/, '');
    return raw === want;
  });
  return row && row.dist && row.dist.url ? row.dist.url : null;
}

function composerVersions(doc, name) {
  if (!doc || typeof doc !== 'object') return [];
  const packages = doc.packages;
  if (packages && typeof packages === 'object') {
    if (Array.isArray(packages[name])) return packages[name];
    const key = Object.keys(packages).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key && Array.isArray(packages[key])) return packages[key];
  }
  const pkg = doc.package;
  if (pkg && pkg.versions && typeof pkg.versions === 'object') return Object.values(pkg.versions);
  return [];
}

function rubyGemUri(doc, version) {
  const rows = Array.isArray(doc) ? doc : doc ? [doc] : [];
  const row = rows.find((entry) => entry && String(entry.number) === version);
  return row && (row.gem_uri || row.gemUri) ? row.gem_uri || row.gemUri : null;
}
