import { describe, it, expect } from 'vitest';
import { npmDeclaredLicense } from './npm-packument.js';

describe('npmDeclaredLicense', () => {
  it('reads the license string and the {type} object', () => {
    expect(npmDeclaredLicense({ license: 'MIT' } as never)).toBe('MIT');
    expect(npmDeclaredLicense({ license: { type: 'ISC' } } as never)).toBe('ISC');
  });
  it('falls back to the legacy licenses array (node-uuid 1.4.8)', () => {
    expect(npmDeclaredLicense({ licenses: [{ type: 'MIT', url: 'https://example.test' }] } as never)).toBe('MIT');
  });
  it('joins several legacy entries as alternatives', () => {
    expect(npmDeclaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] } as never)).toBe('MIT OR Apache-2.0');
  });
  it('returns nothing when no license is declared', () => {
    expect(npmDeclaredLicense({} as never)).toBeUndefined();
    expect(npmDeclaredLicense({ licenses: [] } as never)).toBeUndefined();
  });
});
