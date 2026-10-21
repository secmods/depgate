/**
 * Pinned dependency sets. Each install resolves these the way a lockfile does:
 * one metadata read, then the artifact for that version.
 *
 * `list` selects which k6 policy names the pin.
 * deny  → BLOCK policy for that ecosystem
 * approve → ALLOW policy for that ecosystem
 *
 * License and CVE scenarios ignore `list` and use the package's real metadata.
 * Order starts with one deny and one approve so PACKAGES=2 still covers both.
 */
export const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];

export const catalog = {
  npm: [
    { name: 'lodash', version: '4.17.21', list: 'deny' },
    { name: 'mime', version: '3.0.0', list: 'approve' },
    { name: 'ms', version: '2.1.3', list: 'deny' },
    { name: 'semver', version: '7.6.3', list: 'approve' },
    { name: 'qs', version: '6.13.0', list: 'approve' },
  ],
  pypi: [
    { name: 'requests', version: '2.32.3', list: 'deny' },
    { name: 'idna', version: '3.10', list: 'approve' },
    { name: 'flask', version: '3.0.3', list: 'deny' },
    { name: 'click', version: '8.1.7', list: 'approve' },
    { name: 'jinja2', version: '3.1.4', list: 'approve' },
  ],
  go: [
    { name: 'rsc.io/quote', version: 'v1.5.2', list: 'deny' },
    { name: 'github.com/google/uuid', version: 'v1.6.0', list: 'approve' },
    { name: 'github.com/pkg/errors', version: 'v0.9.1', list: 'deny' },
    { name: 'github.com/davecgh/go-spew', version: 'v1.1.1', list: 'approve' },
    { name: 'gopkg.in/yaml.v3', version: 'v3.0.1', list: 'approve' },
  ],
  maven: [
    { name: 'junit:junit', version: '4.13.2', path: 'junit/junit', list: 'deny' },
    { name: 'org.slf4j:slf4j-api', version: '2.0.16', path: 'org/slf4j/slf4j-api', list: 'approve' },
    { name: 'com.google.code.gson:gson', version: '2.11.0', path: 'com/google/code/gson/gson', list: 'deny' },
    { name: 'org.apache.commons:commons-lang3', version: '3.17.0', path: 'org/apache/commons/commons-lang3', list: 'approve' },
    { name: 'com.fasterxml.jackson.core:jackson-core', version: '2.18.2', path: 'com/fasterxml/jackson/core/jackson-core', list: 'approve' },
  ],
  nuget: [
    { name: 'newtonsoft.json', version: '13.0.3', list: 'deny' },
    { name: 'npgsql', version: '8.0.4', list: 'approve' },
    { name: 'serilog', version: '4.0.0', list: 'deny' },
    { name: 'microsoft.extensions.logging', version: '8.0.1', list: 'approve' },
    { name: 'system.text.json', version: '8.0.5', list: 'approve' },
  ],
  cargo: [
    { name: 'serde', version: '1.0.197', list: 'deny' },
    { name: 'log', version: '0.4.22', list: 'approve' },
    { name: 'anyhow', version: '1.0.86', list: 'deny' },
    { name: 'ryu', version: '1.0.18', list: 'approve' },
    { name: 'itoa', version: '1.0.11', list: 'approve' },
  ],
  composer: [
    { name: 'monolog/monolog', version: '3.7.0', list: 'deny' },
    { name: 'vlucas/phpdotenv', version: '5.6.1', list: 'approve' },
    { name: 'guzzlehttp/guzzle', version: '7.9.2', list: 'deny' },
    { name: 'ramsey/uuid', version: '4.7.6', list: 'approve' },
    { name: 'symfony/console', version: '7.1.5', list: 'approve' },
  ],
  rubygems: [
    { name: 'rake', version: '13.2.1', list: 'deny' },
    { name: 'rack', version: '3.1.7', list: 'approve' },
    { name: 'puma', version: '6.4.2', list: 'deny' },
    { name: 'minitest', version: '5.25.1', list: 'approve' },
    { name: 'json', version: '2.7.2', list: 'approve' },
  ],
};

export function packagesFor(ecosystem) {
  const list = catalog[ecosystem] || [];
  const n = parseInt(__ENV.PACKAGES || '', 10);
  if (!Number.isFinite(n) || n <= 0 || n >= list.length) return list;
  return list.slice(0, n);
}

export function namesFor(ecosystem, listName) {
  return (catalog[ecosystem] || []).filter((pkg) => pkg.list === listName).map((pkg) => pkg.name);
}

export function namesWhere(listName) {
  const names = [];
  for (const eco of ECOSYSTEMS) names.push(...namesFor(eco, listName));
  return names;
}
