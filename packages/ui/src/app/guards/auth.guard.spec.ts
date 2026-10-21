import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { vi } from 'vitest';
import { authGuard, homeGuard, roleGuard, safeReturnUrl } from './auth.guard';
import { AuthService } from '../services/auth.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

function token(claims: object): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_');
  return `header.${payload}.sig`;
}

describe('auth guards', () => {
  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter([])],
    });
  });

  afterEach(() => sessionStorage.clear());

  function url(result: true | false | UrlTree): string | boolean {
    if (result instanceof UrlTree) return TestBed.inject(Router).serializeUrl(result);
    return result;
  }

  it('sends a User to the registry and a Security user to the dashboard', () => {
    const auth = TestBed.inject(AuthService);
    auth.setToken(token({ role: 'User', type: 'user' }));
    expect(url(TestBed.runInInjectionContext(() => homeGuard()))).toBe('/registry');

    auth.setToken(token({ role: 'Security', type: 'user' }));
    expect(url(TestBed.runInInjectionContext(() => homeGuard()))).toBe('/dashboard');
  });

  it('sends an expired session to login', () => {
    const auth = TestBed.inject(AuthService);
    auth.setToken(token({ role: 'Security', type: 'user', exp: 1 }));
    expect(url(TestBed.runInInjectionContext(() => homeGuard()))).toBe('/login');
    expect(auth.getToken()).toBeNull();
  });

  it('sends an anonymous visitor to login', () => {
    expect(url(TestBed.runInInjectionContext(() => homeGuard()))).toBe('/login');
  });

  it('clears a service-account key and sends it to login', () => {
    const auth = TestBed.inject(AuthService);
    auth.setToken('dgk_not_a_person');
    expect(url(TestBed.runInInjectionContext(() => homeGuard()))).toBe('/login');
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('lets each role open only its own pages', () => {
    const auth = TestBed.inject(AuthService);
    const securityOnly = roleGuard(['Security']);
    const userOnly = roleGuard(['User']);

    auth.setToken(token({ role: 'User', type: 'user' }));
    expect(url(TestBed.runInInjectionContext(() => securityOnly()))).toBe('/registry');
    expect(url(TestBed.runInInjectionContext(() => userOnly()))).toBe(true);

    auth.setToken(token({ role: 'Admin', type: 'user' }));
    expect(url(TestBed.runInInjectionContext(() => securityOnly()))).toBe(true);
    expect(url(TestBed.runInInjectionContext(() => userOnly()))).toBe('/dashboard');
  });

  it('redirects an anonymous visitor away from a guarded page', () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(TestBed.runInInjectionContext(() => authGuard())).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('keeps a deep link through sign-in, but only a same-site path', () => {
    const guard = roleGuard(['User', 'Security']);
    const state = { url: '/package-check?ecosystem=npm&package=lodash&version=4.17.20' } as never;
    const tree = TestBed.runInInjectionContext(() => guard(undefined, state));
    expect(url(tree)).toBe('/login?returnUrl=%2Fpackage-check%3Fecosystem%3Dnpm%26package%3Dlodash%26version%3D4.17.20');
    expect(safeReturnUrl('/package-check?package=x')).toBe('/package-check?package=x');
    expect(safeReturnUrl('//evil.example.com')).toBeNull();
    expect(safeReturnUrl('/\\evil.example.com')).toBeNull();
    expect(safeReturnUrl('https://evil.example.com')).toBeNull();
    expect(safeReturnUrl('/login?returnUrl=/x')).toBeNull();
  });
});
