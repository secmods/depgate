import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { DashboardComponent } from './dashboard.component';
import { DashboardService } from '../../services/dashboard.service';
import { AuthService } from '../../services/auth.service';
import { WebhookService, WebhookTarget } from '../../services/webhook.service';
import { ToastService } from '../../services/toast.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

const hook = (url: string, extra: Partial<WebhookTarget> = {}): WebhookTarget => ({
  id: url, url, secretConfigured: false, events: ['package_blocked'], isEnabled: true, createdAt: '', ...extra,
});

describe('DashboardComponent webhook notice', () => {
  let fixture: ComponentFixture<DashboardComponent>;
  let list: ReturnType<typeof vi.fn>;

  async function setup(security: boolean, webhooks: WebhookTarget[]) {
    list = vi.fn().mockReturnValue(of(webhooks));
    await TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        {
          provide: DashboardService,
          useValue: {
            getStats: vi.fn().mockReturnValue(of({ total: 0, allow: 0, block: 0 })),
            getCharts: vi.fn().mockReturnValue(of({ topPackagesAllowed: [], topPackagesBlocked: [], byEcosystem: [] })),
          },
        },
        { provide: AuthService, useValue: { isSecurity: () => security } },
        { provide: WebhookService, useValue: { list } },
        { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
  }

  const notice = () => (fixture.nativeElement as HTMLElement).querySelector('[data-testid="dashboard-webhooks-disabled"]');

  it('tells Security a webhook was turned off automatically', async () => {
    await setup(true, [hook('https://a.example.com', { isEnabled: false, disabledAutomatically: true }), hook('https://b.example.com')]);
    expect(notice()!.textContent).toContain('https://a.example.com');
    expect(notice()!.querySelector('a')!.getAttribute('href')).toBe('/settings?tab=webhooks');
  });

  it('counts several turned-off webhooks', async () => {
    await setup(true, [
      hook('https://a.example.com', { isEnabled: false, disabledAutomatically: true }),
      hook('https://b.example.com', { isEnabled: false, disabledAutomatically: true }),
    ]);
    expect(notice()!.textContent).toContain('2 webhooks were turned off');
  });

  it('says nothing for webhooks turned off by hand, or to other roles', async () => {
    await setup(true, [hook('https://a.example.com', { isEnabled: false })]);
    expect(notice()).toBeNull();
    TestBed.resetTestingModule();
    await setup(false, [hook('https://a.example.com', { isEnabled: false, disabledAutomatically: true })]);
    expect(list).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });
});
