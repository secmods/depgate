import 'zone.js';
import 'zone.js/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  BrowserDynamicTestingModule,
  platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';
import { AppComponent } from './app.component';
import { AuthService } from './services/auth.service';
import { MonitorService } from './services/monitor.service';
import { signal } from '@angular/core';

type AuthMock = {
  isAuthenticated: ReturnType<typeof vi.fn>;
  clearToken: ReturnType<typeof vi.fn>;
  getRole: ReturnType<typeof vi.fn>;
  getUsername: ReturnType<typeof vi.fn>;
  isUser: ReturnType<typeof vi.fn>;
};

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

describe('AppComponent', () => {
  let authService: AuthMock;

  beforeEach(async () => {
    const authMock: AuthMock = {
      isAuthenticated: vi.fn().mockReturnValue(false),
      clearToken: vi.fn(),
      getRole: vi.fn().mockReturnValue('Security'),
      getUsername: vi.fn().mockReturnValue('ada'),
      isUser: vi.fn().mockReturnValue(false),
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: authMock },
        { provide: MonitorService, useValue: { monitoringCount: signal(0), refreshCount: vi.fn() } },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as unknown as AuthMock;
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it(`should have the 'DepGate' title`, () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.title).toEqual('DepGate');
  });

  it('should show router-outlet when not authenticated', () => {
    authService.isAuthenticated.mockReturnValue(false);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('router-outlet')).toBeTruthy();
    expect(compiled.querySelector('header')).toBeFalsy();
    expect(compiled.querySelector('aside')).toBeFalsy();
  });

  it('should show top bar and sidebar when authenticated', () => {
    authService.isAuthenticated.mockReturnValue(true);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('header')).toBeTruthy();
    expect(compiled.querySelector('aside')).toBeTruthy();
    expect(compiled.querySelector('aside img')?.getAttribute('alt')).toBe('DepGate');
    expect(compiled.querySelector('aside')?.textContent).toContain('ada');
    expect(compiled.querySelector('aside')?.textContent).toContain('Security');
    expect(compiled.querySelector('aside')?.textContent).not.toContain('admin@depgate.local');
  });

  describe('collapsible sidebar', () => {
    const originalMatchMedia = window.matchMedia;

    function viewport(desktop: boolean): void {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: desktop,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }

    function render() {
      authService.isAuthenticated.mockReturnValue(true);
      const fixture = TestBed.createComponent(AppComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      return {
        fixture,
        aside: el.querySelector('aside') as HTMLElement,
        main: el.querySelector('.app-main') as HTMLElement,
        toggle: el.querySelector('[data-testid="sidebar-toggle"]') as HTMLButtonElement,
      };
    }

    beforeEach(() => {
      localStorage.removeItem('dg_sidebar');
      viewport(true);
    });

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
      localStorage.removeItem('dg_sidebar');
      vi.restoreAllMocks();
    });

    it('starts expanded, then collapses to an icon rail and back', () => {
      const { fixture, aside, main, toggle } = render();
      expect(aside.classList).not.toContain('is-rail');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');
      expect(toggle.getAttribute('aria-controls')).toBe(aside.id);

      toggle.click();
      fixture.detectChanges();
      expect(aside.classList).toContain('is-rail');
      expect(main.classList).toContain('is-rail');
      expect(fixture.nativeElement.querySelector('app-sidebar').classList).toContain('is-rail');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar');
      expect(localStorage.getItem('dg_sidebar')).toBe('collapsed');

      toggle.click();
      fixture.detectChanges();
      expect(aside.classList).not.toContain('is-rail');
      expect(main.classList).not.toContain('is-rail');
      expect(localStorage.getItem('dg_sidebar')).toBe('expanded');
    });

    it('restores the collapsed choice on reload', () => {
      localStorage.setItem('dg_sidebar', 'collapsed');
      const { aside, toggle } = render();
      expect(aside.classList).toContain('is-rail');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the full overlay sidebar below the desktop breakpoint', () => {
      localStorage.setItem('dg_sidebar', 'collapsed');
      viewport(false);
      const { fixture, aside } = render();
      expect(aside.classList).not.toContain('is-rail');
      fixture.componentInstance.toggleSidebar();
      fixture.detectChanges();
      expect(aside.classList).toContain('sidebar-open');
      expect(aside.classList).not.toContain('is-rail');
    });

    it('still toggles when storage is unavailable', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const { fixture, aside, toggle } = render();
      expect(aside.classList).not.toContain('is-rail');
      toggle.click();
      fixture.detectChanges();
      expect(aside.classList).toContain('is-rail');
    });
  });
});
