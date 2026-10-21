import { describe, expect, it } from 'vitest';
import { tokenFromAuthorization } from './request-auth.js';

describe('tokenFromAuthorization', () => {
  it('reads a bearer token', () => {
    expect(tokenFromAuthorization('Bearer eyJ.payload.sig')).toBe('eyJ.payload.sig');
  });

  it('reads the password from basic auth', () => {
    const header = `Basic ${Buffer.from('_:eyJ.payload.sig', 'utf8').toString('base64')}`;
    expect(tokenFromAuthorization(header)).toBe('eyJ.payload.sig');
  });

  it('rejects a header without a scheme', () => {
    expect(tokenFromAuthorization('Token abc')).toBeNull();
    expect(tokenFromAuthorization(undefined)).toBeNull();
  });

  it('reads a bare token, which is how cargo sends registries.<name>.token', () => {
    expect(tokenFromAuthorization('eyJ.payload.sig')).toBe('eyJ.payload.sig');
  });
});
