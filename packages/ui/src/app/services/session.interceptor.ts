import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { EMPTY, catchError, throwError } from 'rxjs';
import { safeReturnUrl } from '../guards/auth.guard';
import { AuthService } from './auth.service';

/** A rejected browser session leaves the app and returns to the login page. Login failures stay on the form. */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: unknown) => {
      const expired = err instanceof HttpErrorResponse && err.status === 401 && !req.url.includes('/api/auth/');
      if (!expired) return throwError(() => err);
      auth.clearToken();
      if (!router.url.startsWith('/login')) {
        // Come back to the page the user was on, not to whatever was visited earlier.
        const returnUrl = safeReturnUrl(router.url);
        void router.navigate(['/login'], returnUrl ? { queryParams: { returnUrl } } : {});
      }
      return EMPTY;
    }),
  );
};
