import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { AccessComponent } from './access.component';
import { AccountService } from '../../services/account.service';
import { ApiKeyService } from '../../services/api-key.service';
import { AuthService } from '../../services/auth.service';
import { SsoService } from '../../services/sso.service';
import { ToastService } from '../../services/toast.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('Access page', () => {
  async function open(url: string, ssoEnabled = true) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'access', component: AccessComponent }]),
        {
          provide: AccountService,
          useValue: {
            listUsers: vi.fn().mockReturnValue(of({
              total: 1,
              items: [
                { id: 'u1', email: 'ravi@acme.test', role: 'Security', status: 'active', source: 'local', invitePending: false, hasPassword: true, signInMethods: ['Password', 'Corporate SSO'], lastLoginAt: null, lastLoginMethod: null, lastLoginProvider: null, createdAt: '' },
              ],
            })),
            listServiceAccounts: vi.fn().mockReturnValue(of({ total: 1, items: [{ id: 's1', name: 'github-actions', expiresAt: null, lastUsedAt: null, createdAt: '' }] })),
          },
        },
        { provide: ApiKeyService, useValue: { list: vi.fn().mockReturnValue(of([])) } },
        {
          provide: SsoService,
          useValue: {
            signinSettings: vi.fn().mockReturnValue(of({ allowedDomains: ['acme.test'], allowUnlistedSso: true, ssoEnabled })),
            list: vi.fn().mockReturnValue(of([])),
          },
        },
        { provide: AuthService, useValue: { getUsername: () => 'admin@acme.test', getToken: () => null } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    harness.detectChanges();
    return harness;
  }

  const tabs = (el: HTMLElement) => [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.replace(/\s+/g, ' ').trim());

  it('has the three tabs and opens Users by default', async () => {
    const harness = await open('/access');
    const el = harness.routeNativeElement!;
    expect(tabs(el)).toEqual(['group Users', 'key Single sign-on', 'smart_toy Service accounts']);
    expect(el.textContent).toContain('ravi@acme.test');
    expect(el.textContent).toContain('Password · Corporate SSO');
    expect(el.querySelector('[data-testid="users-sso-status"]')!.textContent).toContain('Single sign-on is on for acme.test');
    expect(el.querySelector('[data-testid="pagination-range"]')!.textContent).toContain('1–1');
    const accounts = TestBed.inject(AccountService) as unknown as { listUsers: ReturnType<typeof vi.fn> };
    expect(accounts.listUsers).toHaveBeenCalledWith({ limit: 20, offset: 0, search: '', source: '', role: '', status: '' });
  });

  it('opens the tab named in the address', async () => {
    const harness = await open('/access?tab=sso');
    const el = harness.routeNativeElement!;
    expect(el.textContent).toContain('Who may sign in');
    expect(el.textContent).toContain('Identity providers');
    expect(el.textContent).not.toContain('ravi@acme.test');

    await harness.navigateByUrl('/access?tab=service-accounts');
    harness.detectChanges();
    expect(harness.routeNativeElement!.textContent).toContain('github-actions');
  });

  it('switches to Single sign-on from the Users status line and keeps the tab in the address', async () => {
    const harness = await open('/access');
    (harness.routeNativeElement!.querySelector('[data-testid="users-sso-status"] button') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(TestBed.inject(Router).url).toBe('/access?tab=sso');
    expect(harness.routeNativeElement!.textContent).toContain('Who may sign in');
  });

  it('says when single sign-on is off', async () => {
    const harness = await open('/access', false);
    expect(harness.routeNativeElement!.querySelector('[data-testid="users-sso-status"]')!.textContent).toContain('Single sign-on is off');
  });
});
