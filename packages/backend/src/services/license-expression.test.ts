import { describe, expect, it } from 'vitest';
import {
  compileLicensePatterns,
  formatLicense,
  licenseApproved,
  licenseDenied,
  licenseFromClassifiers,
  parseLicense,
} from './license-expression.js';

const approved = (license: string, list: string[]) => {
  const tree = parseLicense(license);
  return tree ? licenseApproved(tree, compileLicensePatterns(list)) : null;
};
const denied = (license: string, list: string[]) => {
  const tree = parseLicense(license);
  return tree ? licenseDenied(tree, compileLicensePatterns(list)) : null;
};

describe('parseLicense', () => {
  it('reads SPDX expressions, Cargo slashes, WITH exceptions and lists', () => {
    expect(formatLicense(parseLicense('MIT OR Apache-2.0')!)).toBe('MIT OR Apache-2.0');
    expect(formatLicense(parseLicense('MIT/Apache-2.0')!)).toBe('MIT OR Apache-2.0');
    expect(formatLicense(parseLicense('(MIT OR Apache-2.0) AND Unicode-3.0')!)).toBe('(MIT OR Apache-2.0) AND Unicode-3.0');
    expect(formatLicense(parseLicense('GPL-2.0-only WITH Classpath-exception-2.0')!)).toBe(
      'GPL-2.0-only WITH Classpath-exception-2.0'
    );
    expect(formatLicense(parseLicense('MIT, BSD-3-Clause')!)).toBe('MIT AND BSD-3-Clause');
  });

  it('maps common names to SPDX ids', () => {
    expect(formatLicense(parseLicense('Apache License 2.0')!)).toBe('Apache-2.0');
    expect(formatLicense(parseLicense('The Apache License, Version 2.0')!)).toBe('Apache-2.0');
    expect(formatLicense(parseLicense('MIT License')!)).toBe('MIT');
    expect(formatLicense(parseLicense('ISC License (ISCL)')!)).toBe('ISC');
  });

  it('treats placeholders, pointers and pasted license texts as unknown', () => {
    for (const value of [undefined, '', 'UNKNOWN', 'NOASSERTION', 'SEE LICENSE IN LICENSE.md', 'Copyright (c) 2020\nPermission is hereby granted']) {
      expect(parseLicense(value)).toBeNull();
    }
    expect(parseLicense('Proprietary')).toEqual({ kind: 'id', text: 'Proprietary' });
  });

  it('reads PyPI license classifiers', () => {
    expect(licenseFromClassifiers(['License :: OSI Approved :: MIT License', 'Programming Language :: Python'])).toBe('MIT');
    expect(licenseFromClassifiers(['License :: OSI Approved :: Apache Software License'])).toBe('Apache-2.0');
    expect(licenseFromClassifiers(['License :: OSI Approved'])).toBeUndefined();
    expect(licenseFromClassifiers(['Programming Language :: Python'])).toBeUndefined();
  });
});

describe('allow only these licenses', () => {
  const list = ['MIT', 'Apache-2.0', 'BSD-3-Clause'];

  it('approves listed licenses and rejects the rest', () => {
    expect(approved('MIT', list)).toBe(true);
    expect(approved('mit', list)).toBe(true);
    expect(approved('GPL-3.0-only', list)).toBe(false);
  });

  it('needs one approved choice under OR and every license under AND', () => {
    expect(approved('MIT OR GPL-3.0', list)).toBe(true);
    expect(approved('MIT or Apache', ['MIT'])).toBe(true);
    expect(approved('Apache-2.0 or MIT', ['MIT'])).toBe(true);
    expect(approved('MIT and Apache', ['MIT'])).toBe(false);
    expect(approved('MIT AND GPL-3.0', list)).toBe(false);
    expect(approved('(MIT OR Apache-2.0) AND BSD-3-Clause', list)).toBe(true);
    expect(approved('MIT, GPL-3.0', list)).toBe(false);
  });

  it('accepts patterns and SPDX suffixes', () => {
    expect(approved('BSD-2-Clause', ['BSD-*'])).toBe(true);
    expect(approved('GPL-2.0-or-later', ['GPL-2.0'])).toBe(true);
    expect(approved('GPL-2.0-only WITH Classpath-exception-2.0', ['GPL-2.0 WITH Classpath-exception-2.0'])).toBe(true);
  });
});

describe('block these licenses', () => {
  it('blocks a license that cannot be avoided', () => {
    expect(denied('GPL-3.0', ['GPL-3.0'])).toBe(true);
    expect(denied('MIT AND GPL-3.0', ['GPL-3.0'])).toBe(true);
    expect(denied('MIT, GPL-3.0', ['GPL-3.0'])).toBe(true);
  });

  it('lets a package through when another choice is allowed', () => {
    expect(denied('MIT OR GPL-3.0', ['GPL-3.0'])).toBe(false);
  });

  it('blocks when every choice is banned', () => {
    expect(denied('AGPL-3.0 OR GPL-3.0', ['AGPL-*', 'GPL-3.0'])).toBe(true);
  });

  it('covers -only and -or-later under the plain id', () => {
    expect(denied('GPL-3.0-only', ['GPL-3.0'])).toBe(true);
    expect(denied('GPL-3.0-or-later', ['GPL-3.0'])).toBe(true);
    expect(denied('LGPL-3.0-only', ['GPL-3.0'])).toBe(false);
  });
});
