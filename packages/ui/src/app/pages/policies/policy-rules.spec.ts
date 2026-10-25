import { describe, expect, it } from 'vitest';
import { sortedVersionParts, versionParts, versionRuns, versionText } from './policy-rules';

describe('versionParts', () => {
  it('is empty for any version', () => {
    expect(versionParts(null)).toEqual([]);
    expect(versionParts(' * ')).toEqual([]);
  });

  it('shows exact versions without the = sign', () => {
    expect(versionParts('=1.107.0||=1.82.7 || = 1.82.8')).toEqual(['1.107.0', '1.82.7', '1.82.8']);
  });

  it('keeps comparators and hyphen ranges', () => {
    expect(versionParts('>=2.0.0||1.0.0 - 1.4.0')).toEqual(['>=2.0.0', '1.0.0 - 1.4.0']);
  });
});

describe('sortedVersionParts', () => {
  it('orders versions numerically', () => {
    expect(sortedVersionParts('=0.1.10||=0.1.2||=0.1.0||=0.1.9')).toEqual(['0.1.0', '0.1.2', '0.1.9', '0.1.10']);
  });
});

describe('versionRuns', () => {
  it('shows three or more consecutive releases as one run', () => {
    const sitecard = sortedVersionParts(
      '=0.1.0||=0.1.1||=0.1.10||=0.1.11||=0.1.12||=0.1.13||=0.1.14||=0.1.2||=0.1.3||=0.1.6||=0.1.7||=0.1.8||=0.1.9'
    );
    expect(versionRuns(sitecard)).toEqual(['0.1.0 – 0.1.3', '0.1.6 – 0.1.14']);
  });

  it('keeps pairs, gaps and other minors apart', () => {
    expect(versionRuns(['1.0.0', '1.0.1', '1.0.3', '1.1.0', '1.1.1', '1.1.2'])).toEqual(['1.0.0', '1.0.1', '1.0.3', '1.1.0 – 1.1.2']);
  });

  it('leaves versions that are not plain numbers alone', () => {
    expect(versionRuns(['1.0.0', '1.0.1-rc.1', '1.0.1', '1.0.2', '>=2.0.0'])).toEqual(['1.0.0', '1.0.1-rc.1', '1.0.1', '1.0.2', '>=2.0.0']);
  });
});

describe('versionText', () => {
  it('joins the parts', () => {
    expect(versionText('=0.2.0||=0.3.0')).toBe('0.2.0, 0.3.0');
    expect(versionText('')).toBe('Any version');
  });
});
