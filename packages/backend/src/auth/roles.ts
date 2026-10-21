/** Human roles. Service accounts are API keys, not users. */
export const ROLE_USER = 'User';
export const ROLE_SECURITY = 'Security';
export const ROLE_SERVICE = 'ServiceAccount';

export const HUMAN_ROLES = [ROLE_USER, ROLE_SECURITY] as const;
export const PACKAGE_ROLES = [ROLE_USER, ROLE_SECURITY] as const;
export const SECURITY_ROLES = [ROLE_SECURITY] as const;
export const SERVICE_ROLES = [ROLE_SERVICE] as const;

export type HumanRole = (typeof HUMAN_ROLES)[number];

/** Map roles issued before the User / Security split. */
export function canonicalRole(role: string | null | undefined): string {
  if (role === 'Admin' || role === ROLE_SECURITY) return ROLE_SECURITY;
  if (role === 'Viewer' || role === ROLE_USER) return ROLE_USER;
  if (role === ROLE_SERVICE) return ROLE_SERVICE;
  return role ?? '';
}

export function isHumanRole(role: string): role is HumanRole {
  return role === ROLE_USER || role === ROLE_SECURITY;
}

export function roleAllowed(tokenRole: string, allowed: readonly string[]): boolean {
  const role = canonicalRole(tokenRole);
  return allowed.map((entry) => canonicalRole(entry)).includes(role);
}

/** Why a Security actor may not delete this account, or null when deletion is allowed. */
export function userDeletionBlock(
  actorId: string | undefined,
  target: { id: string; role: string },
  securityCount: number,
): string | null {
  if (actorId && actorId === target.id) return 'You cannot delete your own account';
  if (canonicalRole(target.role) === ROLE_SECURITY && securityCount <= 1) {
    return 'At least one Security user is required';
  }
  return null;
}
