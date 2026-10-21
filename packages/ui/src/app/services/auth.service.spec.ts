import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { AuthService } from './auth.service';

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

describe('AuthService', () => {
  let auth: AuthService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({});
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => sessionStorage.clear());

  it('maps a legacy Admin token to Security and sends them to the dashboard', () => {
    auth.setToken(token({ role: 'Admin', username: 'ada', type: 'user' }));
    expect(auth.getRole()).toBe('Security');
    expect(auth.getUsername()).toBe('ada');
    expect(auth.isSecurity()).toBe(true);
    expect(auth.isUser()).toBe(false);
    expect(auth.homeRoute()).toBe('/dashboard');
  });

  it('maps a legacy Viewer token to User and sends them to the registry', () => {
    auth.setToken(token({ role: 'Viewer', username: 'dev', type: 'user' }));
    expect(auth.getRole()).toBe('User');
    expect(auth.isUser()).toBe(true);
    expect(auth.isSecurity()).toBe(false);
    expect(auth.homeRoute()).toBe('/registry');
  });

  it('does not treat a service-account key as a signed-in person', () => {
    auth.setToken('dgk_service_account_key');
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getRole()).toBeNull();
    expect(auth.getUsername()).toBeNull();
    expect(auth.isUser()).toBe(false);
    expect(auth.isSecurity()).toBe(false);
  });

  it('keeps the browser session and the registry token apart', () => {
    auth.setSession(token({ role: 'User', type: 'user' }), token({ role: 'User', type: 'registry' }));
    expect(auth.getToken()).not.toBe(auth.getRegistryToken());
    expect(auth.getRole()).toBe('User');
    auth.clearToken();
    expect(auth.getToken()).toBeNull();
    expect(auth.getRegistryToken()).toBeNull();
  });

  it('drops an expired browser session', () => {
    auth.setSession(
      token({ role: 'Security', type: 'user', exp: Math.floor(Date.now() / 1000) - 5 }),
      token({ role: 'Security', type: 'registry' }),
    );
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getToken()).toBeNull();
    expect(auth.getRegistryToken()).toBeNull();
    expect(auth.getRole()).toBeNull();
  });

  it('treats a missing token as signed out', () => {
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getRole()).toBeNull();
    expect(auth.homeRoute()).toBe('/dashboard');
  });
});
