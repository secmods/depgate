import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { safeReturnUrl } from '../../guards/auth.guard';
import { LoginProvider, SsoService, ssoErrorMessage } from '../../services/sso.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterLink],
  styles: [`
    :host { display: block; }
    .login-brand {
      background: radial-gradient(120% 80% at 100% 0%, rgba(99, 102, 241, 0.38) 0%, transparent 60%),
                  linear-gradient(165deg, #0b1220 0%, #0f172a 60%, #0b1220 100%);
      color: #e2e8f0;
    }
    .login-brand h1 {
      font-family: 'Manrope', sans-serif;
      font-weight: 800;
      font-size: 2.125rem;
      line-height: 1.15;
      letter-spacing: -0.03em;
      color: #f8fafc;
      margin: 0 0 14px;
    }
    /* Request-flow illustration: inline SVG, CSS motion only, static under reduced motion. */
    .login-flow { display: block; width: 100%; max-width: 360px; margin: 32px 0 0; }
    .login-flow text { font-size: 10px; font-weight: 600; text-anchor: middle; fill: #94a3b8; letter-spacing: 0.02em; }
    .lf-link { fill: none; stroke: #334155; stroke-width: 1.5; stroke-dasharray: 3 4; }
    .lf-node rect { fill: #1e293b; stroke: #334155; }
    .lf-gate rect { fill: rgba(99, 102, 241, 0.16); stroke: #6366f1; stroke-width: 1.25; }
    .lf-gate path { fill: #a5b4fc; }
    .lf-gate text { fill: #e0e7ff; }
    .lf-req { fill: #cbd5e1; opacity: 0; }
    .lf-allow { fill: #34d399; transform: translateX(22px); }
    .lf-block { transform-box: fill-box; transform-origin: center; }
    .lf-block circle { fill: #0f172a; stroke: #f87171; stroke-width: 1.5; }
    .lf-block path { fill: none; stroke: #f87171; stroke-width: 1.75; stroke-linecap: round; }
    @media (prefers-reduced-motion: no-preference) {
      .lf-req, .lf-allow, .lf-block, .lf-gate rect {
        animation-duration: 8s; animation-iteration-count: infinite; animation-timing-function: ease-in-out;
      }
      .lf-req-a { animation-name: lf-req-a; }
      .lf-allow { animation-name: lf-allow; }
      .lf-req-b { animation-name: lf-req-b; }
      .lf-block { animation-name: lf-block; }
      .lf-gate rect { animation-name: lf-gate; }
      @keyframes lf-req-a {
        0% { transform: translateX(0); opacity: 0; } 3% { opacity: 1; }
        17% { transform: translateX(44px); opacity: 1; } 20%, 100% { transform: translateX(44px); opacity: 0; }
      }
      @keyframes lf-allow {
        0%, 26% { transform: translateX(0); opacity: 0; } 29% { opacity: 1; }
        43% { transform: translateX(44px); opacity: 1; } 46%, 100% { transform: translateX(44px); opacity: 0; }
      }
      @keyframes lf-req-b {
        0%, 52% { transform: translateX(0); opacity: 0; } 55% { opacity: 1; }
        69% { transform: translateX(44px); opacity: 1; } 72%, 100% { transform: translateX(44px); opacity: 0; }
      }
      @keyframes lf-block {
        0%, 71% { transform: scale(0.5); opacity: 0; } 75% { transform: scale(1); opacity: 1; }
        88% { transform: scale(1); opacity: 1; } 93%, 100% { transform: scale(0.8); opacity: 0; }
      }
      @keyframes lf-gate {
        0%, 16% { stroke: #6366f1; fill: rgba(99, 102, 241, 0.16); }
        21% { stroke: #a5b4fc; fill: rgba(99, 102, 241, 0.34); }
        28%, 68% { stroke: #6366f1; fill: rgba(99, 102, 241, 0.16); }
        74%, 88% { stroke: #f87171; fill: rgba(248, 113, 113, 0.14); }
        94%, 100% { stroke: #6366f1; fill: rgba(99, 102, 241, 0.16); }
      }
    }
    .login-feature { display: flex; gap: 12px; align-items: flex-start; }
    .login-feature-icon {
      width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0;
      display: grid; place-items: center;
      background: rgba(99, 102, 241, 0.18); color: #c7d2fe;
    }
    .login-feature-icon .material-symbols-outlined { font-size: 18px; }
    .login-feature-title { font-size: 0.875rem; font-weight: 600; color: #e2e8f0; }
    .login-feature-copy { font-size: 0.8125rem; color: #94a3b8; margin-top: 2px; }
    .login-field { position: relative; }
    .login-field .material-symbols-outlined {
      position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
      font-size: 18px; color: var(--color-hint); pointer-events: none;
    }
    .login-field .dg-input { width: 100%; height: 44px; padding-left: 40px; font-size: 0.875rem; }
    .login-divider { display: flex; align-items: center; gap: 12px; margin: 24px 0 16px; color: var(--color-hint); font-size: 0.8125rem; }
    .login-divider::before, .login-divider::after { content: ''; flex: 1; height: 1px; background: var(--color-border); }
    .sso-buttons { display: flex; flex-direction: column; gap: 10px; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="min-h-screen flex">

      <section class="login-brand hidden lg:flex flex-col justify-between w-[44%] xl:w-[40%] p-12 flex-shrink-0">
        <img src="depgate-logo.png" alt="DepGate" class="h-11 w-auto self-start" />

        <div>
          <h1>Dependency security<br />for every package manager</h1>
          <p class="text-[15px] leading-relaxed" style="color: #94a3b8; max-width: 44ch">
            DepGate sits between your builds and public registries. It blocks known malware,
            enforces your policies, and records every decision.
          </p>

          <svg class="login-flow" viewBox="0 0 320 88" aria-hidden="true" focusable="false">
            <path class="lf-link" d="M78 44H122M198 44H242" />
            <g class="lf-node">
              <rect x="6" y="26" width="72" height="36" rx="8" />
              <text x="42" y="48">build</text>
            </g>
            <g class="lf-gate">
              <rect x="122" y="18" width="76" height="52" rx="10" />
              <path d="M160 26l9 3.4v6.4c0 5.3-3.7 9.3-9 11.2-5.3-1.9-9-5.9-9-11.2v-6.4z" />
              <text x="160" y="63">DepGate</text>
            </g>
            <g class="lf-node">
              <rect x="242" y="26" width="72" height="36" rx="8" />
              <text x="278" y="48">registry</text>
            </g>
            <circle class="lf-req lf-req-a" cx="78" cy="44" r="4" />
            <circle class="lf-allow" cx="198" cy="44" r="4" />
            <circle class="lf-req lf-req-b" cx="78" cy="44" r="4" />
            <g class="lf-block">
              <circle cx="100" cy="44" r="7" />
              <path d="M97 41l6 6M103 41l-6 6" />
            </g>
          </svg>

          <div class="mt-10 flex flex-col gap-5">
            <div class="login-feature">
              <span class="login-feature-icon"><span class="material-symbols-outlined">shield</span></span>
              <div>
                <div class="login-feature-title">Malware blocking</div>
                <div class="login-feature-copy">Synced from the OpenSSF malicious-packages feed.</div>
              </div>
            </div>
            <div class="login-feature">
              <span class="login-feature-icon"><span class="material-symbols-outlined">policy</span></span>
              <div>
                <div class="login-feature-title">Policy engine</div>
                <div class="login-feature-copy">Version ranges, CVE severity, licenses and release age.</div>
              </div>
            </div>
            <div class="login-feature">
              <span class="login-feature-icon"><span class="material-symbols-outlined">receipt_long</span></span>
              <div>
                <div class="login-feature-title">Decision ledger</div>
                <div class="login-feature-copy">Every allow, block and override is recorded for review.</div>
              </div>
            </div>
          </div>
        </div>

        <p class="text-xs" style="color: #64748b">
          npm · PyPI · Go · Maven · NuGet · Cargo · Composer · RubyGems
        </p>
      </section>

      <section class="flex-1 flex items-center justify-center p-6 sm:p-10">
        <div class="w-full max-w-[380px]">
          <img src="depgate-logo-light.png" alt="DepGate" class="lg:hidden h-11 w-auto mb-10" />

          <h2 class="dg-page-title" style="font-size: 1.625rem">Sign in</h2>
          <p class="dg-page-subtitle">Use your DepGate account.</p>

          <form class="mt-8" (ngSubmit)="onLogin()" novalidate>
            <div class="dg-field">
              <label class="form-label" for="email">Email</label>
              <div class="login-field">
                <span class="material-symbols-outlined" aria-hidden="true">mail</span>
                <input id="email" name="email" type="email" class="dg-input"
                  [(ngModel)]="email" autocomplete="email" autofocus required />
              </div>
            </div>

            <div class="dg-field">
              <label class="form-label" for="password">Password</label>
              <div class="login-field">
                <span class="material-symbols-outlined" aria-hidden="true">lock</span>
                <input id="password" name="password" type="password" class="dg-input"
                  [(ngModel)]="password" autocomplete="current-password" required />
              </div>
            </div>

            <div class="mb-4 -mt-2 text-right">
              <a routerLink="/forgot-password" class="text-sm" style="color: var(--color-primary, #6366f1)">Forgot password?</a>
            </div>

            @if (ssoError) {
              <div class="dg-callout is-danger mb-4" role="alert" data-testid="sso-error">
                <span class="material-symbols-outlined">error</span>
                <span>{{ ssoError }}</span>
              </div>
            }

            @if (error) {
              <div class="dg-callout is-danger mb-4" role="alert">
                <span class="material-symbols-outlined">error</span>
                <span>{{ error }}</span>
              </div>
            }

            <button type="submit" class="dg-btn dg-btn-primary dg-btn-lg dg-btn-block mt-2" [disabled]="loading">
              @if (loading) {
                <span class="dg-spinner is-sm on-brand" aria-hidden="true"></span>
                Signing in…
              } @else {
                Sign in
              }
            </button>
          </form>

          @if (providers.length) {
            <div class="login-divider">or</div>
            <div class="sso-buttons">
              @for (provider of providers; track provider.id) {
                <button type="button" class="dg-btn dg-btn-secondary dg-btn-lg dg-btn-block" (click)="startSso(provider)"
                  [disabled]="redirecting" [attr.data-testid]="'sso-' + provider.id">
                  <span class="material-symbols-outlined">key</span> {{ provider.buttonLabel }}
                </button>
              }
            </div>
          }
        </div>
      </section>
    </div>
  `,
})
export class LoginComponent implements OnInit {
  email = '';
  password = '';
  loading = false;
  error = '';
  ssoError = '';
  providers: LoginProvider[] = [];
  redirecting = false;

  private auth = inject(AuthService);
  private api = inject(ApiService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private sso = inject(SsoService);

  ngOnInit(): void {
    this.ssoError = ssoErrorMessage(this.route.snapshot.queryParamMap.get('sso_error'));
    if (this.ssoError) {
      // Keep the message, but not the code, so a reload shows a clean form.
      void this.router.navigate([], { relativeTo: this.route, queryParams: { sso_error: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    this.sso.loginProviders().subscribe({
      next: (list) => (this.providers = list.filter((provider) => provider.type === 'oidc' || provider.type === 'saml')),
      error: () => (this.providers = []),
    });
  }

  startSso(provider: LoginProvider): void {
    this.redirecting = true;
    const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
    this.leaveFor(this.sso.startUrl(provider.id, returnUrl));
  }

  /** Full page load: single sign-on leaves the app for the identity provider. */
  leaveFor(url: string): void {
    window.location.assign(url);
  }

  onLogin(): void {
    if (!this.email.trim() || !this.password) {
      this.error = 'Enter your email and password.';
      return;
    }
    this.loading = true;
    this.error = '';
    this.ssoError = '';
    this.api.login(this.email.trim(), this.password).subscribe({
      next: ({ token, registryToken }) => {
        this.auth.setSession(token, registryToken);
        this.loading = false;
        const returnUrl = safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
        if (returnUrl) void this.router.navigateByUrl(returnUrl);
        else void this.router.navigate([this.auth.homeRoute()]);
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.status === 401 || err?.status === 400
          ? 'Incorrect email or password.'
          : err?.status === 403 || err?.status === 429
            ? (err.error?.error ?? 'Sign-in refused.')
            : 'Sign-in failed. Check your connection and try again.';
      },
    });
  }
}
