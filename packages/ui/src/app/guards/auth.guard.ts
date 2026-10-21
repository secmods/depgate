import { inject } from '@angular/core';
import { Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';

function session(auth: AuthService, router: Router): true | UrlTree {
  const role = auth.getRole();
  if (role === 'User' || role === 'Security') return true;
  auth.clearToken();
  return router.createUrlTree(['/login']);
}

export const authGuard = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated()) {
    router.navigate(['/login']);
    return false;
  }
  return session(auth, router);
};

export const homeGuard = (): UrlTree => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!auth.isAuthenticated()) return router.createUrlTree(['/login']);
  const role = auth.getRole();
  if (role === 'User') return router.createUrlTree(['/registry']);
  if (role === 'Security') return router.createUrlTree(['/dashboard']);
  auth.clearToken();
  return router.createUrlTree(['/login']);
};

/** A same-site path to come back to after sign-in, so a shared or deep link survives the login page. */
export function safeReturnUrl(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/login')) {
    return null;
  }
  return value;
}

export function roleGuard(allowed: Array<'User' | 'Security'>) {
  return (_route?: unknown, state?: RouterStateSnapshot) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.isAuthenticated()) {
      const returnUrl = safeReturnUrl(state?.url);
      return router.createUrlTree(['/login'], returnUrl ? { queryParams: { returnUrl } } : {});
    }
    const role = auth.getRole();
    if (role === 'User' || role === 'Security') {
      if (allowed.includes(role)) return true;
      return router.createUrlTree([auth.homeRoute()]);
    }
    auth.clearToken();
    return router.createUrlTree(['/login']);
  };
}
