import { Component, OnInit, inject, input, output, ChangeDetectionStrategy } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgbTooltip } from '@ng-bootstrap/ng-bootstrap';
import { AuthService } from '../services/auth.service';
import { MonitorService } from '../services/monitor.service';
import { UiConfigService } from '../services/ui-config.service';
import { NavGroup, NavItem, SECURITY_NAV, USER_NAV, helpNav } from '../navigation';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, NgbTooltip, NgTemplateOutlet],
  host: { '[class.is-rail]': 'collapsed()' },
  template: `
    <nav aria-label="Main">
      <ng-container *ngTemplateOutlet="groups; context: { $implicit: navGroups }" />
    </nav>
    <nav aria-label="Help" class="dg-nav-help">
      <ng-container *ngTemplateOutlet="groups; context: { $implicit: [help] }" />
    </nav>

    <ng-template #groups let-groups>
      @for (group of asGroups(groups); track group.label) {
        <div class="dg-nav-group">{{ group.label }}</div>
        @for (item of group.items; track item.route) {
          @if (item.external) {
            <a
              [href]="item.route"
              target="_blank"
              rel="noopener"
              class="dg-nav-item"
              [ngbTooltip]="item.label"
              [disableTooltip]="!collapsed()"
              placement="end"
              container="body"
              (click)="navClick.emit()">
              <span class="material-symbols-outlined nav-icon" aria-hidden="true">{{ item.icon }}</span>
              <span class="dg-nav-label">{{ item.label }}</span>
            </a>
          } @else {
            <a
              [routerLink]="item.route"
              routerLinkActive="dg-nav-active"
              [routerLinkActiveOptions]="{ exact: !!item.exact }"
              ariaCurrentWhenActive="page"
              class="dg-nav-item"
              [ngbTooltip]="item.label"
              [disableTooltip]="!collapsed()"
              placement="end"
              container="body"
              (click)="navClick.emit()">
              <span class="material-symbols-outlined nav-icon" aria-hidden="true">{{ item.icon }}</span>
              <span class="dg-nav-label">{{ item.label }}</span>
              @if (badgeCount(item); as count) {
                <span class="dg-nav-badge" [attr.aria-label]="count + ' monitoring'" data-testid="nav-monitoring-badge">{{ count }}</span>
              }
            </a>
          }
        }
      }
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    /* Help sits at the bottom of the sidebar, and scrolls with the rest when the list is taller than the screen. */
    :host { display: flex; flex-direction: column; }
    .dg-nav-help { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--dg-sidebar-divider); }
    :host(.is-rail) .dg-nav-help { border-top: 0; }
    .dg-nav-badge {
      margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
      display: inline-grid; place-items: center; background: var(--brand); color: #fff; font-size: 0.625rem; font-weight: 700;
    }
    /* In the icon rail the count sits on the icon's corner, ringed in the sidebar colour. */
    :host(.is-rail) .dg-nav-badge {
      position: absolute; top: 2px; right: 3px; min-width: 16px; height: 16px; padding: 0 4px; font-size: 0.5625rem;
      box-shadow: 0 0 0 2px var(--dg-sidebar-bg);
    }
  `],
})
export class SidebarComponent implements OnInit {
  /** Desktop icon rail: labels are hidden and shown as tooltips instead. */
  collapsed = input(false);
  navClick = output<void>();
  private auth = inject(AuthService);
  private monitor = inject(MonitorService);
  private uiConfig = inject(UiConfigService);

  readonly help = helpNav(this.uiConfig.docsUrl);

  ngOnInit(): void {
    this.monitor.refreshCount();
  }

  badgeCount(item: NavItem): number {
    return item.badge === 'monitoring' ? this.monitor.monitoringCount() : 0;
  }

  asGroups(groups: NavGroup[]): NavGroup[] {
    return groups;
  }

  get navGroups(): NavGroup[] {
    return this.auth.isUser() ? USER_NAV : SECURITY_NAV;
  }
}
