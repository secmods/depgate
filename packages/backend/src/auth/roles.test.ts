import { describe, expect, it } from 'vitest';
import { canonicalRole, isHumanRole, roleAllowed, userDeletionBlock } from './roles.js';

describe('canonicalRole', () => {
  it('maps legacy roles onto User and Security', () => {
    expect(canonicalRole('Admin')).toBe('Security');
    expect(canonicalRole('Security')).toBe('Security');
    expect(canonicalRole('Viewer')).toBe('User');
    expect(canonicalRole('User')).toBe('User');
    expect(canonicalRole('ServiceAccount')).toBe('ServiceAccount');
  });
});

describe('roleAllowed', () => {
  it('accepts a legacy admin token on a Security route', () => {
    expect(roleAllowed('Admin', ['Security'])).toBe(true);
  });

  it('rejects a user token on a Security route', () => {
    expect(roleAllowed('User', ['Security'])).toBe(false);
    expect(roleAllowed('Viewer', ['Security'])).toBe(false);
  });

  it('lets a service account mint CI tokens and nothing else', () => {
    expect(roleAllowed('ServiceAccount', ['ServiceAccount'])).toBe(true);
    expect(roleAllowed('Security', ['ServiceAccount'])).toBe(false);
    expect(roleAllowed('ServiceAccount', ['User', 'Security'])).toBe(false);
  });

  it('treats only User and Security as people who can sign in', () => {
    expect(isHumanRole('User')).toBe(true);
    expect(isHumanRole('Security')).toBe(true);
    expect(isHumanRole('ServiceAccount')).toBe(false);
    expect(isHumanRole('Admin')).toBe(false);
  });
});

describe('userDeletionBlock', () => {
  const security = { id: 'sec-1', role: 'Security' };
  const user = { id: 'user-1', role: 'User' };

  it('refuses a self-delete', () => {
    expect(userDeletionBlock('sec-1', security, 2)).toBe('You cannot delete your own account');
  });

  it('refuses to remove the last Security user', () => {
    expect(userDeletionBlock('other', security, 1)).toBe('At least one Security user is required');
    expect(userDeletionBlock('other', { id: 'sec-1', role: 'Admin' }, 1)).toBe('At least one Security user is required');
  });

  it('allows deleting a User, or a Security user when another remains', () => {
    expect(userDeletionBlock('sec-1', user, 1)).toBeNull();
    expect(userDeletionBlock('sec-1', { id: 'sec-2', role: 'Security' }, 2)).toBeNull();
  });
});
