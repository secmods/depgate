import 'zone.js';
import 'zone.js/testing';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { SidebarComponent } from './sidebar.component';
import { AuthService } from '../services/auth.service';
import { MonitorService } from '../services/monitor.service';
import { UiConfigService } from '../services/ui-config.service';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('SidebarComponent', () => {
  let isUser: ReturnType<typeof vi.fn>;
  const monitoringCount = signal(0);
  const uiConfig = { docsUrl: 'https://docs.example.com/' };

  beforeEach(async () => {
    isUser = vi.fn().mockReturnValue(false);
    monitoringCount.set(0);
    uiConfig.docsUrl = 'https://docs.example.com/';
    await TestBed.configureTestingModule({
      imports: [SidebarComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { isUser } },
        { provide: MonitorService, useValue: { monitoringCount, refreshCount: vi.fn() } },
        { provide: UiConfigService, useValue: uiConfig },
      ],
    }).compileComponents();
  });

  function text(): string {
    const fixture: ComponentFixture<SidebarComponent> = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    return fixture.nativeElement.textContent as string;
  }

  it('shows Registry and Waiver requests to a User', () => {
    isUser.mockReturnValue(true);
    const nav = text();
    expect(nav).toContain('Registry');
    expect(nav).toContain('Waiver requests');
    expect(nav).not.toContain('Dashboard');
    expect(nav).not.toContain('Policies');
    expect(nav).not.toContain('Settings');
  });

  it('shows the gateway pages to Security', () => {
    isUser.mockReturnValue(false);
    const nav = text();
    expect(nav).toContain('Dashboard');
    expect(nav).toContain('Policies');
    expect(nav).toContain('Exceptions');
    expect(nav).toContain('Decision Ledger');
    expect(nav).toContain('Registry');
    expect(nav).toContain('Settings');
    expect(nav).not.toContain('Waiver requests');
  });

  function helpLinks(): HTMLAnchorElement[] {
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    const help = (fixture.nativeElement as HTMLElement).querySelector('nav[aria-label="Help"]');
    return Array.from(help?.querySelectorAll('a') ?? []);
  }

  it.each([false, true])('ends with a Help section of Documentation and API docs (User: %s)', (user) => {
    isUser.mockReturnValue(user);
    const links = helpLinks();
    expect(links.map((a) => a.querySelector('.dg-nav-label')?.textContent)).toEqual(['Documentation', 'API docs']);
    expect(links.map((a) => a.querySelector('.nav-icon')?.textContent)).toEqual(['menu_book', 'api']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://docs.example.com/', '/api/docs']);
    expect(links.every((a) => a.target === '_blank')).toBe(true);
  });

  it('leaves out Documentation when no documentation URL is configured', () => {
    uiConfig.docsUrl = '';
    expect(helpLinks().map((a) => a.getAttribute('href'))).toEqual(['/api/docs']);
  });

  it('puts Monitoring between Package check and Exceptions, with a badge only when policies monitor', () => {
    const nav = text();
    expect(nav.indexOf('Package check')).toBeLessThan(nav.indexOf('Monitoring'));
    expect(nav.indexOf('Monitoring')).toBeLessThan(nav.indexOf('Exceptions'));
    let fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="nav-monitoring-badge"]')).toBeNull();

    monitoringCount.set(3);
    fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="nav-monitoring-badge"]')?.textContent?.trim()).toBe('3');
  });

  it('keeps labels as accessible names and the badge in the collapsed icon rail', () => {
    monitoringCount.set(2);
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.componentRef.setInput('collapsed', true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.classList).toContain('is-rail');
    const monitoring = Array.from(host.querySelectorAll('a.dg-nav-item')).find((a) => a.textContent?.includes('Monitoring'));
    expect(monitoring?.querySelector('.dg-nav-label')?.textContent).toBe('Monitoring');
    expect(monitoring?.querySelector('[data-testid="nav-monitoring-badge"]')?.textContent?.trim()).toBe('2');

    fixture.componentRef.setInput('collapsed', false);
    fixture.detectChanges();
    expect(host.classList).not.toContain('is-rail');
  });
});
