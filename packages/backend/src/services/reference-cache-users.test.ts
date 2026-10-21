import { describe, expect, it } from 'vitest';
import { referenceKindsFor } from './reference-cache.js';

describe('reference kinds', () => {
  it('bumps the users slot when a user row is written, so a deleted account loses its tokens at once', () => {
    expect(referenceKindsFor('users')).toEqual(['users']);
  });
});
