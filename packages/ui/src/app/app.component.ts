import { Component, DestroyRef, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { NgbModalConfig, NgbModalModule, NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import { filter } from 'rxjs';
import { AuthService } from './services/auth.service';
import { BreadcrumbService } from './services/breadcrumb.service';
import { ToastContainerComponent } from './components/toast-container.component';
import { SidebarComponent } from './components/sidebar.component';
import { locate, SECURITY_NAV, USER_NAV } from './navigation';

const THEME_KEY = 'dg_theme';
const SIDEBAR_KEY = 'dg_sidebar';
/** Matches Tailwind's `lg`: below it the sidebar is an overlay, so the icon rail does not apply. */
const DESKTOP_QUERY = '(min-width: 1024px)';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    RouterLink,
    NgbModalModule,
    NgbTooltipModule,
    ToastContainerComponent,
    SidebarComponent,
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit {
  title = 'DepGate';
  sidebarOpen = false;
  /** The user's choice to shrink the desktop sidebar to an icon rail, remembered per browser. */
  sidebarCollapsed = false;
  isDesktop = true;
  isDark = false;
  breadcrumb: { group: string; page: string; route: string } | null = null;
  readonly crumbs = inject(BreadcrumbService);
  private onLoginPage = false;

  private auth = inject(AuthService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  constructor() {
    // Long dialogs scroll inside the body so the header and actions stay visible.
    const modalConfig = inject(NgbModalConfig);
    modalConfig.scrollable = true;
  }

  ngOnInit(): void {
    const stored = readStored(THEME_KEY);
    this.isDark = stored ? stored === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
    this.applyTheme();

    this.sidebarCollapsed = readStored(SIDEBAR_KEY) === 'collapsed';
    const desktop = window.matchMedia?.(DESKTOP_QUERY);
    if (desktop) {
      this.isDesktop = desktop.matches;
      const onChange = (e: MediaQueryListEvent) => (this.isDesktop = e.matches);
      desktop.addEventListener?.('change', onChange);
      this.destroyRef.onDestroy(() => desktop.removeEventListener?.('change', onChange));
    }

    this.updateBreadcrumb(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe((e) => {
        this.updateBreadcrumb(e.urlAfterRedirects);
        this.sidebarOpen = false;
      });
  }

  get isAuthenticated(): boolean {
    return this.auth.isAuthenticated();
  }

  /** The sign-in page always renders full-screen, even with a session open. */
  get showShell(): boolean {
    return this.isAuthenticated && !this.onLoginPage;
  }

  get accountName(): string {
    return this.auth.getUsername() ?? 'Account';
  }

  get accountDetail(): string {
    const role = this.auth.getRole();
    return role === 'User' || role === 'Security' ? role : '';
  }

  get accountInitial(): string {
    const letter = this.accountName.trim().charAt(0);
    return letter ? letter.toUpperCase() : 'A';
  }

  toggleTheme(): void {
    this.isDark = !this.isDark;
    try {
      localStorage.setItem(THEME_KEY, this.isDark ? 'dark' : 'light');
    } catch {
      // Storage can be unavailable (private mode); the toggle still applies for this session.
    }
    this.applyTheme();
  }

  private applyTheme(): void {
    document.documentElement.classList.toggle('dark', this.isDark);
  }

  private updateBreadcrumb(url: string): void {
    this.onLoginPage = ['/login', '/login/sso', '/sso-test-done', '/forgot-password', '/set-password'].includes(url.split(/[?#]/)[0]);
    this.breadcrumb = locate(this.auth.isUser() ? USER_NAV : SECURITY_NAV, url);
  }

  /** The desktop sidebar shows as a narrow icon rail. Phones and tablets always get the full overlay. */
  get rail(): boolean {
    return this.sidebarCollapsed && this.isDesktop;
  }

  toggleCollapsed(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try {
      localStorage.setItem(SIDEBAR_KEY, this.sidebarCollapsed ? 'collapsed' : 'expanded');
    } catch {
      // Storage can be unavailable (private mode); the toggle still applies for this session.
    }
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  closeSidebar(): void {
    this.sidebarOpen = false;
  }

  logout(): void {
    this.auth.clearToken();
    this.router.navigate(['/login']);
  }
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
