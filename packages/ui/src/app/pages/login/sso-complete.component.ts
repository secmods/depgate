import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { safeReturnUrl } from '../../guards/auth.guard';
import { AuthService } from '../../services/auth.service';
import { SsoService } from '../../services/sso.service';
import { AuthShellComponent } from '../../shared/auth-shell.component';

/**
 * Where single sign-on lands. The one-time code in the URL is traded for the session tokens, so
 * the tokens themselves never appear in a URL (requirements_sso.md S2).
 */
@Component({
  selector: 'app-sso-complete',
  standalone: true,
  imports: [AuthShellComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <app-auth-shell title="Signing you in…">
      <div class="dg-loading"><span class="dg-spinner"></span></div>
    </app-auth-shell>
  `,
})
export class SsoCompleteComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);
  private auth = inject(AuthService);
  private sso = inject(SsoService);

  ngOnInit(): void {
    const code = this.route.snapshot.queryParamMap.get('code');
    // The code works once; keep it out of the history either way.
    this.location.replaceState('/login/sso');
    if (!code) {
      void this.router.navigate(['/login'], { queryParams: { sso_error: 'state_invalid' }, replaceUrl: true });
      return;
    }
    this.sso.exchange(code).subscribe({
      next: (session) => {
        this.auth.setSession(session.token, session.registryToken);
        const returnTo = safeReturnUrl(session.returnTo);
        void this.router.navigateByUrl(returnTo ?? this.auth.homeRoute(), { replaceUrl: true });
      },
      error: () => {
        void this.router.navigate(['/login'], { queryParams: { sso_error: 'state_invalid' }, replaceUrl: true });
      },
    });
  }
}
