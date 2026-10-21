import 'zone.js';
import 'zone.js/testing';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { LoginComponent } from './login.component';
import { SsoCompleteComponent } from './sso-complete.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { SsoService, ssoErrorMessage, SSO_ERROR_MESSAGES } from '../../services/sso.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

@Component({ standalone: true, changeDetection: ChangeDetectionStrategy.Eager,
 template: 'page' })
class StubPage {}

describe('ssoErrorMessage', () => {
  it('has a plain message for every code the server sends, and a fallback', () => {
    for (const code of ['domain_not_allowed', 'email_unverified', 'email_missing', 'claim_mismatch', 'not_invited', 'subject_mismatch', 'user_disabled', 'invalid_response', 'state_invalid', 'provider_error', 'provider_unavailable', 'rate_limited']) {
      expect(SSO_ERROR_MESSAGES[code]).toBeTruthy();
    }
    expect(ssoErrorMessage('domain_not_allowed')).toContain('domain is not allowed');
    expect(ssoErrorMessage('something_new')).toBe('Single sign-on failed. Try again.');
    expect(ssoErrorMessage(null)).toBe('');
  });

  it('builds the start URL with an encoded return path', () => {
    const sso = new SsoService({} as never, { getToken: () => null } as never);
    expect(sso.startUrl('abc', '/policies?x=1')).toBe('/api/auth/sso/abc/start?returnTo=%2Fpolicies%3Fx%3D1');
    expect(sso.startUrl('abc', null)).toBe('/api/auth/sso/abc/start');
  });
});

describe('Login page with single sign-on', () => {
  let sso: { loginProviders: ReturnType<typeof vi.fn>; startUrl: ReturnType<typeof vi.fn>; exchange: ReturnType<typeof vi.fn> };

  async function open(url: string, providers: unknown[] = []) {
    sso = {
      loginProviders: vi.fn().mockReturnValue(of(providers)),
      startUrl: vi.fn((id: string, returnTo: string | null) => `/api/auth/sso/${id}/start${returnTo ? `?returnTo=${returnTo}` : ''}`),
      exchange: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: LoginComponent },
          { path: 'login/sso', component: SsoCompleteComponent },
          { path: 'policies/:id', component: StubPage },
          { path: 'dashboard', component: StubPage },
          { path: 'registry', component: StubPage },
        ]),
        { provide: SsoService, useValue: sso },
        { provide: ApiService, useValue: { login: vi.fn() } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.detectChanges();
    return harness;
  }

  afterEach(() => sessionStorage.clear());

  it('shows no single sign-on section when no provider is on', async () => {
    const harness = await open('/login');
    expect(harness.routeNativeElement!.querySelector('.login-divider')).toBeNull();
    expect(harness.routeNativeElement!.querySelector('[data-testid^="sso-"]')).toBeNull();
  });

  it('shows one button per enabled provider with its label, OIDC and SAML alike', async () => {
    const harness = await open('/login', [
      { id: 'p1', type: 'oidc', buttonLabel: 'Sign in with Company SSO' },
      { id: 'p2', type: 'saml', buttonLabel: 'Sign in with Partner SSO' },
    ]);
    const buttons = harness.routeNativeElement!.querySelectorAll('[data-testid^="sso-p"]');
    expect([...buttons].map((b) => b.textContent?.trim())).toEqual(['key Sign in with Company SSO', 'key Sign in with Partner SSO']);
  });

  it('starts single sign-on with the page the person came from', async () => {
    const harness = await open('/login?returnUrl=%2Fpolicies%2F7', [{ id: 'p1', type: 'oidc', buttonLabel: 'Sign in with SSO' }]);
    const login = harness.routeDebugElement!.componentInstance as LoginComponent;
    const leave = vi.spyOn(login, 'leaveFor').mockImplementation(() => undefined);
    (harness.routeNativeElement!.querySelector('[data-testid="sso-p1"]') as HTMLButtonElement).click();
    expect(sso.startUrl).toHaveBeenCalledWith('p1', '/policies/7');
    expect(leave).toHaveBeenCalledWith('/api/auth/sso/p1/start?returnTo=/policies/7');
  });

  it('explains a refused single sign-on in plain words', async () => {
    const harness = await open('/login?sso_error=domain_not_allowed');
    expect(harness.routeNativeElement!.querySelector('[data-testid="sso-error"]')!.textContent).toContain(
      "Your account's domain is not allowed to sign in"
    );
  });

  it('trades the one-time code for a session and opens the return path', async () => {
    const harness = await open('/login', []);
    sso.exchange.mockReturnValue(of({ token: 'h.eyJyb2xlIjoiU2VjdXJpdHkifQ.s', registryToken: 'r', user: { email: 'a@b.c', role: 'Security' }, returnTo: '/policies/9' }));
    await harness.navigateByUrl('/login/sso?code=abc123');
    await harness.fixture.whenStable();
    expect(sso.exchange).toHaveBeenCalledWith('abc123');
    expect(TestBed.inject(AuthService).getToken()).toBe('h.eyJyb2xlIjoiU2VjdXJpdHkifQ.s');
    expect(TestBed.inject(Router).url).toBe('/policies/9');
  });

  it('sends an expired code back to the login page', async () => {
    const harness = await open('/login', []);
    sso.exchange.mockReturnValue(throwError(() => ({ status: 400 })));
    await harness.navigateByUrl('/login/sso?code=used');
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/login?sso_error=state_invalid');
  });
});
