import { describe, expect, it } from 'vitest';
import { filterGoVersionList, parseGoProxyPath } from './go-proxy.js';

describe('go-proxy service', () => {
  it('parses list path', () => {
    expect(parseGoProxyPath('rsc.io/quote/@v/list')).toEqual({
      modulePath: 'rsc.io/quote',
      type: 'list',
    });
  });

  it('parses info path', () => {
    expect(parseGoProxyPath('rsc.io/quote/@v/v1.5.2.info')).toEqual({
      modulePath: 'rsc.io/quote',
      type: 'info',
      version: 'v1.5.2',
    });
  });

  it('parses mod and zip paths', () => {
    expect(parseGoProxyPath('rsc.io/quote/@v/v1.5.2.mod')).toEqual({
      modulePath: 'rsc.io/quote',
      type: 'mod',
      version: 'v1.5.2',
    });
    expect(parseGoProxyPath('rsc.io/quote/@v/v1.5.2.zip')).toEqual({
      modulePath: 'rsc.io/quote',
      type: 'zip',
      version: 'v1.5.2',
    });
  });

  it('returns null for invalid paths', () => {
    expect(parseGoProxyPath('')).toBeNull();
    expect(parseGoProxyPath('rsc.io/quote')).toBeNull();
    expect(parseGoProxyPath('rsc.io/quote/@v')).toBeNull();
    expect(parseGoProxyPath('rsc.io/quote/@v/latest')).toBeNull();
  });

  it('filters blocked versions from list body', () => {
    const body = 'v1.0.0\nv1.1.0\nv1.2.0\n';
    const filtered = filterGoVersionList(body, new Set(['v1.1.0']));
    expect(filtered).toBe('v1.0.0\nv1.2.0\n');
  });
});
