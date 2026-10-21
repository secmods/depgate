import { Component, DestroyRef, OnInit, ViewChild, inject, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SigninSettingsComponent } from './signin-settings.component';
import { SsoSettingsComponent } from './sso-settings.component';
import { UsersTabComponent } from './users-tab.component';
import { ServiceAccountsTabComponent } from './service-accounts-tab.component';

export type AccessTab = 'users' | 'sso' | 'service-accounts';

interface TabDef { id: AccessTab; label: string; icon: string; }

export const ACCESS_TABS: TabDef[] = [
  { id: 'users', label: 'Users', icon: 'group' },
  { id: 'sso', label: 'Single sign-on', icon: 'key' },
  { id: 'service-accounts', label: 'Service accounts', icon: 'smart_toy' },
];

/** Who can use DepGate: people, how they sign in, and CI credentials. Security only. */
@Component({
  selector: 'app-access',
  standalone: true,
  imports: [UsersTabComponent, SigninSettingsComponent, SsoSettingsComponent, ServiceAccountsTabComponent],
  styles: [`
    :host { display: block; }
    .stack { display: flex; flex-direction: column; gap: 20px; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Access</h1>
          <p class="dg-page-subtitle">People and their roles, single sign-on, and service accounts for CI.</p>
        </div>
      </header>

      <nav class="dg-tabs" role="tablist">
        @for (tab of tabs; track tab.id) {
          <button type="button" class="dg-tab" role="tab" [class.is-active]="activeTab === tab.id" [attr.aria-selected]="activeTab === tab.id"
            (click)="select(tab.id)">
            <span class="material-symbols-outlined">{{ tab.icon }}</span> {{ tab.label }}
          </button>
        }
      </nav>

      @switch (activeTab) {
        @case ('users') {
          <app-users-tab (openSso)="select('sso')" />
        }
        @case ('sso') {
          <div class="stack">
            <app-signin-settings (saved)="providers?.load()" />
            <app-sso-settings #providers />
          </div>
        }
        @case ('service-accounts') {
          <app-service-accounts-tab />
        }
      }
    </div>
  `,
})
export class AccessComponent implements OnInit {
  readonly tabs = ACCESS_TABS;
  activeTab: AccessTab = 'users';

  @ViewChild('providers') providers?: SsoSettingsComponent;

  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    // Follows the address, so Back and links to another tab work while the page is open.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const requested = params.get('tab');
      this.activeTab = this.tabs.some((tab) => tab.id === requested) ? (requested as AccessTab) : 'users';
    });
  }

  /** The tab is kept in the address, so a reload or a shared link opens the same one. */
  select(tab: AccessTab): void {
    this.activeTab = tab;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { tab }, replaceUrl: true });
  }
}
