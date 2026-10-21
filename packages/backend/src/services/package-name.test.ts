import { describe, expect, it } from 'vitest';
import { malwareEcosystems, canonicalPackageName, PackagePattern } from './package-name.js';
import { evaluateConditions } from './policy-engine.js';

describe('canonicalPackageName', () => {
  it('matches a mixed-case NuGet feed name to the lowercased route name', () => {
    expect(canonicalPackageName('nuget', 'Newtonsoft.Json.Evil')).toBe(canonicalPackageName('nuget', 'newtonsoft.json.evil'));
  });

  it('decodes the Go module proxy case encoding', () => {
    expect(canonicalPackageName('go', 'github.com/!buffer!zone!corp/go-metrics-sdk')).toBe(
      'github.com/BufferZoneCorp/go-metrics-sdk'
    );
    expect(canonicalPackageName('go', 'github.com/BufferZoneCorp/go-metrics-sdk')).toBe(
      'github.com/BufferZoneCorp/go-metrics-sdk'
    );
    expect(canonicalPackageName('go', 'github.com/bufferzonecorp/x')).not.toBe(canonicalPackageName('go', 'github.com/BufferZoneCorp/x'));
  });

  it('normalizes PyPI names as PEP 503 does', () => {
    expect(canonicalPackageName('pypi', 'ProjZ.py')).toBe('projz-py');
    expect(canonicalPackageName('pypi', 'M-AT-STAR-Tools')).toBe('m-at-star-tools');
    expect(canonicalPackageName('pypi', 'my__evil...pkg')).toBe('my-evil-pkg');
  });

  it('folds case for RubyGems and Composer, and `_` for Cargo', () => {
    expect(canonicalPackageName('rubygems', 'lambQ4340')).toBe('lambq4340');
    expect(canonicalPackageName('composer', 'Vendor/Pkg')).toBe('vendor/pkg');
    expect(canonicalPackageName('cargo', 'Evil_Crate')).toBe(canonicalPackageName('crates.io', 'evil-crate'));
  });

  it('keeps npm and Maven names exact', () => {
    expect(canonicalPackageName('npm', 'JSONStream')).toBe('JSONStream');
    expect(canonicalPackageName('maven', 'com.Example:Lib')).toBe('com.Example:Lib');
  });
});

describe('malwareEcosystems', () => {
  it('reads Cargo entries stored under the feed name crates.io', () => {
    expect(malwareEcosystems('cargo')).toEqual(['cargo', 'crates.io']);
    expect(malwareEcosystems('npm')).toEqual(['npm']);
  });
});

describe('PackagePattern', () => {
  it('matches a Go request with the !x case encoding to a pattern typed with capitals', () => {
    const pattern = new PackagePattern('github.com/BufferZoneCorp/*');
    expect(pattern.match('go', 'github.com/!buffer!zone!corp/config-loader')).toBe(true);
    expect(pattern.match('go', 'github.com/BufferZoneCorp/config-loader')).toBe(true);
    expect(pattern.match('go', 'github.com/other/config-loader')).toBe(false);
  });

  it('matches a pattern typed in the escaped Go form too', () => {
    expect(new PackagePattern('github.com/!buffer!zone!corp/*').match('go', 'github.com/!buffer!zone!corp/x')).toBe(true);
  });

  it('treats PyPI separators as pip does', () => {
    const pattern = new PackagePattern('my_evil.pkg');
    expect(pattern.match('pypi', 'my-evil-pkg')).toBe(true);
    expect(new PackagePattern('evil_*').match('pypi', 'evil-tools')).toBe(true);
    expect(pattern.match('pypi', 'my-good-pkg')).toBe(false);
  });

  it('keeps npm and Maven exact apart from case, and a name without an ecosystem raw', () => {
    expect(new PackagePattern('my_pkg').match('npm', 'my-pkg')).toBe(false);
    expect(new PackagePattern('Lodash').match('npm', 'lodash')).toBe(true);
    expect(new PackagePattern('my_evil.pkg').match(undefined, 'my-evil-pkg')).toBe(false);
  });

  it('keeps a leading negation as typed', () => {
    const pattern = new PackagePattern('!github.com/BufferZoneCorp/*');
    expect(pattern.match('go', 'github.com/!buffer!zone!corp/x')).toBe(false);
    expect(pattern.match('go', 'github.com/other/x')).toBe(true);
  });
});

describe('evaluateConditions package list', () => {
  it('blocks the client spelling of a listed Go module and PyPI project', () => {
    const go = evaluateConditions(
      { name: 'github.com/!buffer!zone!corp/config-loader', version: 'v1.0.0', ecosystem: 'go' },
      { packageBlockList: ['github.com/BufferZoneCorp/config-loader'] }
    );
    expect(go.match).toBe(true);
    const pypi = evaluateConditions({ name: 'calc-box-lite', version: '1.0', ecosystem: 'pypi' }, { packageBlockList: ['Calc_Box.Lite'] });
    expect(pypi.match).toBe(true);
  });
});
