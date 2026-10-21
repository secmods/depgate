import { Component, OnInit, inject, Injector, ViewChild, ElementRef, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { RepositoryService, PackageRepositoryRow } from '../../services/repository.service';
import { WebhookService, WebhookTarget } from '../../services/webhook.service';
import { ConfigService } from '../../services/config.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { MailSettingsComponent } from './mail-settings.component';
import { JobsSettingsComponent } from './jobs-settings.component';
import { LogStreamingComponent } from './log-streaming.component';
import { ArtifactCacheSettingsComponent } from './artifact-cache-settings.component';
import { WebhookDeliveriesDialogComponent } from './webhook-deliveries-dialog.component';
import { WebhookFormDialogComponent } from './webhook-form-dialog.component';
import { deletionImpact } from '../../shared/repository-scope';
import { orderWarning } from '../../shared/repository-order';
import { clientPathFor } from '../../shared/client-path';
import { MODAL_DATA } from '../../tokens';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS, ecosystemLabel, isPackageEcosystem } from '../../shared/status';

type Tab = 'registry' | 'webhooks' | 'streaming' | 'email' | 'upstreams' | 'jobs' | 'cache';

/** Tabs only Security sees. */
const SECURITY_TABS: readonly Tab[] = ['jobs', 'streaming', 'cache'];

interface TabDef { id: Tab; label: string; icon: string; }

/** Tabs that moved to Access, by their old `?tab=` value. */
const MOVED_TABS: Record<string, string> = { users: 'users', sso: 'sso' };

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    EmptyStateComponent,
    StatusPillComponent,
    MailSettingsComponent,
    JobsSettingsComponent,
    LogStreamingComponent,
    ArtifactCacheSettingsComponent,
  ],
  styles: [`
    :host { display: block; }
    .split { display: grid; grid-template-columns: 1fr; gap: 24px; }
    @media (min-width: 1024px) { .split { grid-template-columns: 160px minmax(0, 1fr); } }
    .stack { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
    .config-steps { list-style: none; margin: 0; padding: 4px 20px 8px; }
    .config-steps li { display: flex; gap: 12px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid var(--color-border); }
    .config-steps li:last-child { border-bottom: none; }
    .step-num {
      width: 22px; height: 22px; border-radius: 999px; flex-shrink: 0; margin-top: 1px;
      display: grid; place-items: center; background: var(--brand-soft-strong); color: var(--brand-text);
      font-size: 0.75rem; font-weight: 700;
    }
    .step-body { flex: 1; min-width: 0; font-size: 0.8125rem; line-height: 1.5; }
    .step-cmd { margin-top: 8px; display: flex; align-items: flex-start; gap: 8px; }
    .step-cmd .dg-code { flex: 1; padding: 10px 12px; white-space: pre-wrap; word-break: break-all; }
    .setting-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 16px 20px; border-bottom: 1px solid var(--color-border); }
    .setting-row:last-child { border-bottom: none; }
    .setting-title { font-size: 0.875rem; font-weight: 600; color: var(--color-on-surface); margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
    .setting-desc { font-size: 0.8125rem; line-height: 1.5; color: var(--color-on-surface-variant); margin: 0; max-width: 64ch; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">{{ isRegistryPage ? 'Registry' : 'Settings' }}</h1>
          <p class="dg-page-subtitle">
            {{ isRegistryPage
              ? 'Point your package manager at DepGate.'
              : 'Repositories, alerts, email, jobs and caching.' }}
          </p>
        </div>
        @if (!isRegistryPage) {
          <div class="dg-page-actions">
            @switch (activeTab) {
              @case ('webhooks') {
                <button type="button" class="dg-btn dg-btn-primary" (click)="openAddWebhook()">
                  <span class="material-symbols-outlined">add</span> Add webhook
                </button>
              }
              @case ('streaming') {
                <button type="button" class="dg-btn dg-btn-primary" (click)="logStreaming?.openAdd()" data-testid="add-destination">
                  <span class="material-symbols-outlined">add</span> Add destination
                </button>
              }
              @case ('upstreams') {
                <a class="dg-btn dg-btn-secondary" routerLink="/registry" [queryParams]="{ eco: registryEco }" data-testid="client-setup-link">
                  <span class="material-symbols-outlined">terminal</span> Client setup
                </a>
                <button type="button" class="dg-btn dg-btn-primary" (click)="openAddRepository()">
                  <span class="material-symbols-outlined">add</span> Add repository
                </button>
              }
            }
          </div>
        }
      </header>

      @if (tabs.length > 1) {
        <nav class="dg-tabs" role="tablist">
          @for (tab of tabs; track tab.id) {
            <button type="button" class="dg-tab" role="tab" [class.is-active]="activeTab === tab.id" [attr.aria-selected]="activeTab === tab.id" (click)="activeTab = tab.id">
              <span class="material-symbols-outlined">{{ tab.icon }}</span> {{ tab.label }}
            </button>
          }
        </nav>
      }

      <!-- Registry -->
      @if (activeTab === 'registry') {
        <div class="split">
          <div>
            <p class="dg-subnav-label">Ecosystem</p>
            <div class="dg-subnav">
              @for (e of ecosystems; track e) {
                <button type="button" class="dg-subnav-item" [class.is-active]="registryEco === e" (click)="selectRegistryEco(e)">
                  <span class="dg-eco-mark">{{ e.substring(0, 2) }}</span> {{ label(e) }}
                </button>
              }
            </div>
          </div>

          <div class="stack">
            @if (gatewayLoading) {
              <div class="dg-card"><div class="dg-loading"><span class="dg-spinner"></span></div></div>
            } @else if (gatewayBaseUrl) {
              @if (registrySnippet; as cmd) {
                <section class="dg-card">
                  <div class="dg-card-header">
                    <h2 class="dg-card-title">{{ cmd.title }} configuration</h2>
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="copyUrl(cmd.content)">
                      <span class="material-symbols-outlined">content_copy</span> Copy snippet
                    </button>
                  </div>
                  <div class="dg-card-body">
                    <div class="dg-tabs mb-3" role="tablist" aria-label="Repository">
                      @for (row of repositoriesForEco(); track row.id) {
                        <button type="button" class="dg-tab is-mono" role="tab" [class.is-active]="registryKey === row.key" [attr.aria-selected]="registryKey === row.key" (click)="registryKey = row.key">
                          {{ row.key }}
                        </button>
                      } @empty {
                        <button type="button" class="dg-tab is-mono is-active" role="tab" aria-selected="true">default</button>
                      }
                    </div>
                    <div class="dg-callout mb-3">
                      <span class="material-symbols-outlined">key</span>
                      <span>The snippet includes your personal registry token, valid for {{ sessionTokenDays }} days. Keep it out of source control.</span>
                    </div>
                    <pre class="dg-code">{{ cmd.content }}</pre>
                  </div>
                </section>
              }

              @if (configureSteps.length) {
                <section class="dg-card">
                  <div class="dg-card-header"><h2 class="dg-card-title">How to configure</h2></div>
                  <ol class="config-steps">
                    @for (step of configureSteps; track $index) {
                      <li>
                        <span class="step-num">{{ $index + 1 }}</span>
                        <div class="step-body">
                          {{ step.text }}
                          @if (step.command) {
                            <div class="step-cmd">
                              <pre class="dg-code">{{ step.command }}</pre>
                              <button type="button" class="dg-icon-btn" (click)="copyUrl(step.command)" title="Copy command" aria-label="Copy command">
                                <span class="material-symbols-outlined">content_copy</span>
                              </button>
                            </div>
                          }
                        </div>
                      </li>
                    }
                  </ol>
                </section>
              }
            } @else {
              <section class="dg-card">
                <app-empty-state icon="cloud_off" title="Gateway configuration unavailable" description="DepGate could not load its public URL. Try again in a moment.">
                  <button type="button" class="dg-btn dg-btn-secondary" (click)="loadGateway()">Retry</button>
                </app-empty-state>
              </section>
            }
          </div>
        </div>
      }

      <!-- Webhooks -->
      @if (activeTab === 'webhooks') {
        <section class="dg-card">
          <div class="dg-card-header">
            <h2 class="dg-card-title">Webhooks</h2>
            <span class="dg-card-hint">Send alerts such as <code class="dg-inline-code">package_blocked</code> to your endpoints. Repeated alerts are grouped and failed deliveries retried. To send every event to a SIEM, use Log streaming.</span>
          </div>
          @if (showNewEventsHint) {
            <div class="dg-callout mx-3 mb-3" data-testid="webhook-new-events-hint">
              <span class="material-symbols-outlined" aria-hidden="true">new_releases</span>
              <div class="flex-grow-1">Two new webhook events: <code class="dg-inline-code">malware_requested</code> (any request for a known-malicious version) and <code class="dg-inline-code">dependency_confusion_blocked</code>. To subscribe an existing webhook, delete and re-add it.</div>
              <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm" (click)="dismissNewEventsHint()">Dismiss</button>
            </div>
          }
          @if (webhooksLoading) {
            <div class="dg-loading"><span class="dg-spinner"></span></div>
          } @else if (webhooks.length === 0) {
            <app-empty-state icon="webhook" title="No webhooks yet" description="Send security events to Slack or any HTTPS endpoint as they happen." />
          } @else {
            <div class="dg-table-wrap">
              <table class="dg-table">
                <thead>
                  <tr><th>Endpoint</th><th>Events</th><th>Status</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr>
                </thead>
                <tbody>
                  @for (row of webhooks; track row.id) {
                    <tr>
                      <td><span class="dg-cell-truncate font-mono text-xs" style="max-width: 360px" [title]="row.url">{{ row.url }}</span></td>
                      <td>
                        <div class="d-flex flex-wrap gap-1">
                          @for (e of row.events; track e) { <span class="dg-tag">{{ e }}</span> } @empty { @if (!row.deprecatedEvents?.length) { <span class="dg-text-muted">package_blocked</span> } }
                          @for (e of row.deprecatedEvents ?? []; track e) {
                            <span class="dg-tag" style="text-decoration: line-through" title="No longer sent. Saving the webhook removes it." [attr.data-testid]="'webhook-deprecated-' + e">{{ e }}</span>
                            <span class="dg-text-muted text-xs">no longer sent</span>
                          }
                        </div>
                      </td>
                      <td [attr.data-testid]="'webhook-status-' + row.id">
                        @if (row.disabledAutomatically) {
                          <app-status-pill value="DISABLED" label="Disabled automatically" tone="danger" />
                          <span class="dg-cell-sub">{{ row.disabledReason }}</span>
                          @if (row.disabledAt) { <span class="dg-cell-sub">{{ row.disabledAt | date: 'MMM d, HH:mm' }}</span> }
                        } @else {
                          <app-status-pill [value]="row.isEnabled ? 'ACTIVE' : 'DISABLED'" />
                          @if (row.isEnabled && (row.consecutiveFailures ?? 0) > 0) {
                            <span class="dg-cell-sub text-danger" data-testid="webhook-failing">
                              {{ row.consecutiveFailures }}{{ row.disableAfterFailures ? ' of ' + row.disableAfterFailures : '' }} failed in a row{{ row.lastError ? ' · ' + row.lastError : '' }}
                            </span>
                          }
                        }
                      </td>
                      <td class="col-actions">
                        <div class="dg-row-actions">
                          @if (!row.isEnabled) {
                            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="turnOnWebhook(row)" data-testid="webhook-turn-on">Turn on</button>
                          }
                          <button type="button" class="dg-icon-btn" (click)="testWebhook(row)" [disabled]="testingWebhookId === row.id" title="Send test event" aria-label="Send test event">
                            @if (testingWebhookId === row.id) { <span class="dg-spinner is-sm"></span> } @else { <span class="material-symbols-outlined">send</span> }
                          </button>
                          <button type="button" class="dg-icon-btn" (click)="openDeliveries(row)" title="Deliveries" aria-label="Deliveries">
                            <span class="material-symbols-outlined">history</span>
                          </button>
                          <button type="button" class="dg-icon-btn is-danger" (click)="deleteWebhook(row)" title="Delete webhook" aria-label="Delete webhook">
                            <span class="material-symbols-outlined">delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }

      <!-- Log streaming -->
      @if (activeTab === 'streaming' && isSecurity) {
        <app-log-streaming #logStreaming />
      }

      <!-- Email -->
      @if (activeTab === 'email') {
        <app-mail-settings />
      }

      <!-- Jobs -->
      @if (activeTab === 'jobs' && isSecurity) {
        <app-jobs-settings />
      }

      <!-- Artifact cache -->
      @if (activeTab === 'cache' && isSecurity) {
        <app-artifact-cache-settings />
      }

      <!-- Repositories -->
      @if (activeTab === 'upstreams' && isSecurity) {
        <div class="split">
          <div>
            <p class="dg-subnav-label">Ecosystem</p>
            <div class="dg-subnav">
              @for (e of ecosystems; track e) {
                <button type="button" class="dg-subnav-item" [class.is-active]="registryEco === e" (click)="selectRegistryEco(e)">
                  <span class="dg-eco-mark">{{ e.substring(0, 2) }}</span> {{ label(e) }}
                </button>
              }
            </div>
          </div>

          <div class="stack">
            <section class="dg-card">
              <div class="dg-card-header">
                <div>
                  <h2 class="dg-card-title">{{ label(registryEco) }} repositories</h2>
                  <span class="dg-card-hint">
                    A remote proxies one registry; a virtual combines several.
                    <code class="dg-inline-code">default</code> is the public registry; <code class="dg-inline-code">all</code> searches every enabled remote.
                  </span>
                </div>
              </div>
              @if (repositoriesLoading) {
                <div class="dg-loading"><span class="dg-spinner"></span></div>
              } @else {
                @let rows = repositoriesForEco();
                @if (rows.length === 0) {
                  <app-empty-state icon="storage" title="No repositories yet" description="Reserved repositories appear after the gateway starts." [compact]="true" />
                } @else {
                  <div class="dg-table-wrap">
                    <table class="dg-table">
                      <thead>
                        <tr><th>Repository</th><th>Target</th><th>Source</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr>
                      </thead>
                      <tbody>
                        @for (row of rows; track row.id) {
                          <tr>
                            <td>
                              <span class="dg-cell-primary font-mono">{{ row.key }}</span>
                              @if (!row.isEnabled) { <app-status-pill class="ms-2" value="DISABLED" /> }
                              <span class="dg-cell-sub dg-cell-truncate" style="max-width: 220px" [title]="row.description || ''">
                                <span class="text-capitalize">{{ row.type }}</span>@if (row.description) { · {{ row.description }} }
                              </span>
                            </td>
                            <td>
                              <span class="dg-cell-truncate" style="max-width: 200px" [title]="repositoryTarget(row)">{{ repositoryTarget(row) }}</span>
                              @if (orderWarningFor(row); as warning) {
                                <span class="material-symbols-outlined text-warning align-middle" style="font-size: 18px" [title]="warning"
                                  [attr.data-testid]="'repo-order-warning-' + row.key" aria-label="Public registry searched before an internal one">warning</span>
                              }
                            </td>
                            <td [attr.data-testid]="'repo-source-' + row.key">
                              @if (row.type !== 'remote') {
                                <span class="dg-text-muted">—</span>
                              } @else if (row.isReserved) {
                                <span class="dg-chip">Public (fixed)</span>
                              } @else if (row.source === 'internal') {
                                <span class="dg-chip dg-chip-accent">Internal</span>
                                @if (row.looksPublic) {
                                  <span class="material-symbols-outlined text-danger align-middle" style="font-size: 16px" title="This looks like a public registry">warning</span>
                                }
                              } @else {
                                <span class="dg-chip">Public</span>
                              }
                            </td>
                            <td class="col-actions">
                              <div class="dg-row-actions">
                                @if (row.type === 'remote') {
                                  <button type="button" class="dg-icon-btn" (click)="testRepository(row)" [disabled]="testingId === row.id" title="Test connection" aria-label="Test connection">
                                    @if (testingId === row.id) { <span class="dg-spinner is-sm"></span> } @else { <span class="material-symbols-outlined">network_check</span> }
                                  </button>
                                }
                                <button type="button" class="dg-icon-btn" (click)="editRepository(row)" title="Edit" aria-label="Edit">
                                  <span class="material-symbols-outlined">edit</span>
                                </button>
                                @if (!row.isReserved) {
                                  <button type="button" class="dg-icon-btn is-danger" (click)="deleteRepository(row)" title="Delete" aria-label="Delete">
                                    <span class="material-symbols-outlined">delete</span>
                                  </button>
                                }
                              </div>
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              }
            </section>

            <section class="dg-card">
              <div class="dg-card-header">
                <h2 class="dg-card-title">Gateway security</h2>
                @if (gatewaySaving) {
                  <span class="dg-card-hint d-flex align-items-center gap-2"><span class="dg-spinner is-sm"></span> Saving…</span>
                }
              </div>
              <div class="setting-row">
                <div>
                  <p class="setting-title">Registry token lifetime</p>
                  <p class="setting-desc">How long package-manager tokens stay valid. Default 30 days. Takes effect at the next sign-in.</p>
                </div>
                <div class="d-flex align-items-center gap-2 flex-shrink-0">
                  <input type="number" min="1" max="365" class="dg-input" style="width: 84px" [(ngModel)]="sessionTokenDays" [disabled]="gatewaySaving" aria-label="Token lifetime in days" />
                  <span class="text-xs dg-text-muted">days</span>
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" [disabled]="gatewaySaving" (click)="saveSessionTokenDays()">Save</button>
                </div>
              </div>
              <div class="setting-row">
                <div>
                  <p class="setting-title">Namespace collision check</p>
                  <p class="setting-desc">
                    Daily, check whether your internal package names also exist on public registries, and list any matches on the Namespace protection policy.
                    Off by default, because it sends those names to the public registries.
                  </p>
                </div>
                <button type="button" class="dg-switch" role="switch" [class.is-on]="gatewayNamespaceCollisionCheck" [attr.aria-checked]="gatewayNamespaceCollisionCheck"
                  aria-label="Namespace collision check" data-testid="namespace-collision-switch" [disabled]="gatewaySaving" (click)="toggleNamespaceCollisionCheck()"></button>
              </div>
            </section>
          </div>
        </div>
      }
    </div>
  `,
})
export class SettingsComponent implements OnInit {
  activeTab: Tab = 'upstreams';
  @ViewChild('logStreaming') logStreaming?: LogStreamingComponent;

  private allTabs: TabDef[] = [
    { id: 'registry',  label: 'Registry',     icon: 'tune' },
    { id: 'upstreams', label: 'Repositories', icon: 'storage' },
    { id: 'email',     label: 'Email',        icon: 'mail' },
    { id: 'jobs',      label: 'Jobs',         icon: 'schedule' },
    { id: 'webhooks',  label: 'Webhooks',     icon: 'webhook' },
    { id: 'streaming', label: 'Log streaming', icon: 'conversion_path' },
    { id: 'cache',     label: 'Artifact cache', icon: 'hard_drive' },
  ];

  get isSecurity(): boolean {
    return this.auth.isSecurity();
  }

  get isRegistryPage(): boolean {
    return this.router.url.split('?')[0].startsWith('/registry');
  }

  get tabs(): TabDef[] {
    if (this.isRegistryPage) return this.allTabs.filter((tab) => tab.id === 'registry');
    return this.allTabs.filter((tab) => tab.id !== 'registry' && (!SECURITY_TABS.includes(tab.id) || this.isSecurity));
  }

  webhooks: WebhookTarget[] = [];
  webhooksLoading = false;
  private newEventsHintDismissed = (() => {
    try {
      return localStorage.getItem('dg-webhook-new-events-hint') === 'dismissed';
    } catch {
      return false;
    }
  })();

  /** One-time hint (§8.5): shown while some webhook does not get the two new alert events. */
  get showNewEventsHint(): boolean {
    if (this.newEventsHintDismissed) return false;
    return this.webhooks.some((row) => !row.events.includes('malware_requested') || !row.events.includes('dependency_confusion_blocked'));
  }

  dismissNewEventsHint(): void {
    this.newEventsHintDismissed = true;
    try {
      localStorage.setItem('dg-webhook-new-events-hint', 'dismissed');
    } catch {
      /* private mode */
    }
  }
  testingWebhookId: string | null = null;
  repositories: PackageRepositoryRow[] = [];
  repositoriesLoading = false;
  registryEco = 'npm';
  registryKey = 'default';
  ecosystems = ECOSYSTEMS;
  testingId: string | null = null;

  gatewayBaseUrl = '';
  gatewayNamespaceCollisionCheck = false;
  sessionTokenDays = 30;
  gatewayLoading = false;
  gatewaySaving = false;

  private auth = inject(AuthService);
  private router = inject(Router);
  private repositoryService = inject(RepositoryService);
  private webhookService = inject(WebhookService);
  private configService = inject(ConfigService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private confirm = inject(ConfirmService);

  get authToken(): string | null { return this.auth.getRegistryToken(); }

  ngOnInit(): void {
    // `?eco=` (and on Registry `?key=`): "Client setup" and the repository page open on the ecosystem they were showing.
    const query = this.router.parseUrl(this.router.url).queryParams;
    if (isPackageEcosystem(query['eco'])) this.registryEco = query['eco'];
    if (this.isRegistryPage && typeof query['key'] === 'string') this.registryKey = query['key'];
    if (this.isRegistryPage) this.activeTab = 'registry';
    else {
      const requested = this.router.parseUrl(this.router.url).queryParams['tab'] as string | undefined;
      // People, single sign-on and service accounts moved to their own page; old links still land there.
      const moved = MOVED_TABS[requested ?? ''];
      if (moved) {
        void this.router.navigate(['/access'], { queryParams: { tab: moved }, replaceUrl: true });
        return;
      }
      if (requested && this.tabs.some((tab) => tab.id === requested)) this.activeTab = requested as Tab;
    }
    this.loadGateway();
    this.loadRepositories();
    if (this.isSecurity && !this.isRegistryPage) {
      this.loadWebhooks();
    }
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  loadGateway(): void {
    this.gatewayLoading = true;
    this.configService.getGateway().subscribe({
      next: cfg => {
        this.gatewayBaseUrl = cfg.baseUrl;
        this.gatewayNamespaceCollisionCheck = cfg.namespaceCollisionCheck ?? false;
        this.sessionTokenDays = cfg.sessionTokenDays ?? 30;
      },
      error: err => { this.gatewayLoading = false; this.toast.error(err.error?.error ?? 'Failed to load gateway config'); },
      complete: () => (this.gatewayLoading = false),
    });
  }


  toggleNamespaceCollisionCheck(): void {
    const checked = !this.gatewayNamespaceCollisionCheck;
    this.gatewaySaving = true;
    this.configService.updateGateway({ namespaceCollisionCheck: checked }).subscribe({
      next: (cfg) => {
        this.gatewayNamespaceCollisionCheck = cfg.namespaceCollisionCheck ?? false;
        this.toast.success(checked ? 'Namespace collision check on' : 'Namespace collision check off');
      },
      error: (err) => {
        this.gatewaySaving = false;
        this.toast.error(err.error?.error ?? 'Failed to update');
      },
      complete: () => (this.gatewaySaving = false),
    });
  }

  saveSessionTokenDays(): void {
    const days = Math.round(Number(this.sessionTokenDays));
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      this.toast.error('Enter a lifetime between 1 and 365 days');
      return;
    }
    this.gatewaySaving = true;
    this.configService.updateGateway({ sessionTokenDays: days }).subscribe({
      next: cfg => {
        this.sessionTokenDays = cfg.sessionTokenDays ?? days;
        this.toast.success(`Registry tokens last ${this.sessionTokenDays} days`);
      },
      error: err => { this.gatewaySaving = false; this.toast.error(err.error?.error ?? 'Failed to update'); },
      complete: () => (this.gatewaySaving = false),
    });
  }

  copyUrl(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => this.toast.success('Copied to clipboard'),
      () => this.toast.error('Could not copy. Select the text and copy it manually.')
    );
  }

  selectRegistryEco(ecosystem: string): void {
    this.registryEco = ecosystem;
    this.ensureRegistryKey();
  }

  ensureRegistryKey(): void {
    const rows = this.repositoriesForEco();
    if (rows.some((row) => row.key === this.registryKey)) return;
    this.registryKey = rows.some((row) => row.key === 'default') ? 'default' : (rows[0]?.key ?? 'default');
  }

  get registrySnippet(): { title: string; content: string } | null {
    const target = this.registryTarget();
    if (!target) return null;
    const titles: Record<string, string> = {
      npm: 'npm', pypi: 'pip', go: 'Go', maven: 'Maven', nuget: 'NuGet', cargo: 'Cargo', composer: 'Composer', rubygems: 'RubyGems',
    };
    return {
      title: `${titles[this.registryEco] ?? this.registryEco} · ${target.key}`,
      content: this.snippetFor(this.registryEco, target.url, target.host, target.token),
    };
  }

  get configureSteps(): { text: string; command?: string }[] {
    const target = this.registryTarget();
    if (!target) return [];
    const { url, host, token, basicUrl } = target;
    const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    switch (this.registryEco) {
      case 'npm':
        return [
          { text: 'Save the snippet as .npmrc in the project, or add its two lines to your existing .npmrc.' },
          { text: 'Install from that directory.', command: 'npm install' },
        ];
      case 'pypi':
        return [
          { text: 'Set the index for your user.', command: `pip config set global.index-url ${q(basicUrl)}` },
          { text: 'Or save the snippet above as your pip.conf.' },
          { text: 'Install a package through DepGate.', command: 'pip install <package>' },
        ];
      case 'go':
        return [
          { text: 'Point the Go module proxy at this repository.', command: `go env -w GOPROXY=${q(`${basicUrl},direct`)}` },
          { text: 'Fetch or build a module.', command: 'go build ./...' },
        ];
      case 'maven':
        return [
          { text: 'Save the snippet as ~/.m2/settings.xml, or merge its server and mirror into your settings.xml. Keep both ids set to depgate.' },
          { text: 'Build as usual.', command: 'mvn verify' },
        ];
      case 'nuget':
        return [
          { text: 'Add DepGate as a package source.', command: `dotnet nuget add source ${q(url)} --name depgate --username _ --password ${q(token)} --store-password-in-clear-text` },
          { text: 'Or save the snippet above as NuGet.Config next to the project.' },
          { text: 'Restore packages.', command: 'dotnet restore' },
        ];
      case 'cargo':
        return [
          { text: 'Save the snippet as ~/.cargo/config.toml, or as .cargo/config.toml in the project.' },
          { text: 'Fetch crates.', command: 'cargo fetch' },
        ];
      case 'composer':
        return [
          { text: 'Point Composer at this repository.', command: `composer config -g repos.packagist composer ${q(url)}` },
          { text: 'Store the token for this host.', command: `composer config -g http-basic.${host} _ ${q(token)}` },
          { text: 'Install dependencies.', command: 'composer install' },
        ];
      case 'rubygems':
        return [
          { text: 'Add DepGate and remove the public RubyGems source.', command: `gem sources --add ${q(basicUrl)} --remove https://rubygems.org/` },
          { text: 'Or save the snippet above as ~/.gemrc.' },
          { text: 'Install a gem.', command: 'gem install <gem>' },
        ];
      default:
        return [];
    }
  }

  private registryTarget(): { url: string; host: string; token: string; key: string; basicUrl: string } | null {
    if (!this.gatewayBaseUrl) return null;
    const base = this.gatewayBaseUrl.replace(/\/$/, '');
    const key = this.registryKey || 'default';
    const row = this.repositoriesForEco().find((item) => item.key === key);
    const clientPath = row?.clientPath ?? clientPathFor(this.registryEco, key);
    const path = clientPath.startsWith('/') ? clientPath : `/${clientPath}`;
    const url = `${base}${path}`;
    const token = this.authToken ?? '<TOKEN>';
    return { url, host: this.registryHost(base), token, key, basicUrl: this.withBasic(url, token) };
  }

  private registryHost(base: string): string {
    try {
      return new URL(base.startsWith('http') ? base : `http://${base}`).host;
    } catch {
      return base.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
  }

  private withBasic(url: string, token: string): string {
    const parsed = new URL(url);
    parsed.username = '_';
    parsed.password = token;
    return parsed.toString();
  }

  private xmlEscape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private snippetFor(ecosystem: string, url: string, host: string, token: string): string {
    const basicUrl = this.withBasic(url, token);
    const secret = this.xmlEscape(token);
    switch (ecosystem) {
      case 'npm': {
        const scope = `//${host}${new URL(url).pathname.replace(/\/$/, '')}/`;
        return `# .npmrc\nregistry=${url}\n${scope}:_authToken=${token}`;
      }
      case 'pypi':
        return `# pip.conf\n[global]\nindex-url = ${basicUrl}`;
      case 'go':
        return `export GOPROXY="${basicUrl},direct"`;
      case 'maven':
        return `<!-- settings.xml -->\n<settings>\n  <servers>\n    <server>\n      <id>depgate</id>\n      <username>_</username>\n      <password>${secret}</password>\n    </server>\n  </servers>\n  <mirrors>\n    <mirror>\n      <id>depgate</id>\n      <mirrorOf>*</mirrorOf>\n      <url>${url}</url>\n    </mirror>\n  </mirrors>\n</settings>`;
      case 'nuget':
        return `<!-- NuGet.Config -->\n<configuration>\n  <packageSources>\n    <clear />\n    <add key="depgate" value="${url}" />\n  </packageSources>\n  <packageSourceCredentials>\n    <depgate>\n      <add key="Username" value="_" />\n      <add key="ClearTextPassword" value="${secret}" />\n    </depgate>\n  </packageSourceCredentials>\n</configuration>`;
      case 'cargo':
        return `# ~/.cargo/config.toml\n[registry]\nglobal-credential-providers = ["cargo:token"]\n\n[source.crates-io]\nreplace-with = "depgate"\n\n[source.depgate]\nregistry = "sparse+${url}"\n\n[registries.depgate]\nindex = "sparse+${url}"\ntoken = "${token}"`;
      case 'composer':
        return `{\n  "repositories": [\n    { "type": "composer", "url": "${url}" }\n  ],\n  "http-basic": {\n    "${host}": { "username": "_", "password": ${JSON.stringify(token)} }\n  }\n}`;
      case 'rubygems':
        return `# ~/.gemrc\n:sources:\n- ${basicUrl}`;
      default:
        return url;
    }
  }

  loadWebhooks(): void {
    this.webhooksLoading = true;
    this.webhookService.list().subscribe({
      next: list => (this.webhooks = list),
      error: err => { this.webhooksLoading = false; this.toast.error(err.error?.error ?? 'Failed to load'); },
      complete: () => (this.webhooksLoading = false),
    });
  }
  openAddWebhook(): void {
    const ref = this.modal.open(WebhookFormDialogComponent);
    ref.closed.subscribe(() => this.loadWebhooks());
  }
  openDeliveries(row: WebhookTarget): void {
    const ref = this.modal.open(WebhookDeliveriesDialogComponent, {
      size: 'xl',
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: { webhook: row } }], parent: this.injector }),
    });
    ref.closed.subscribe(() => this.loadWebhooks());
  }

  testWebhook(row: WebhookTarget): void {
    this.testingWebhookId = row.id;
    this.webhookService.test(row.id).subscribe({
      next: (res) => {
        this.testingWebhookId = null;
        if (res.ok) this.toast.success(`Test event delivered (HTTP ${res.statusCode})`);
        else this.toast.error(`Test event failed: ${res.error ?? 'no answer'}`);
      },
      error: (err) => {
        this.testingWebhookId = null;
        this.toast.error(err.error?.error ?? 'Could not send the test event');
      },
    });
  }

  /** Turning a webhook back on offers to deliver the events skipped while it was off. */
  turnOnWebhook(row: WebhookTarget): void {
    this.webhookService.update(row.id, { isEnabled: true }).subscribe({
      next: async () => {
        this.toast.success('Webhook turned on');
        this.loadWebhooks();
        const resend = await this.confirm.confirm({
          title: 'Deliver skipped events?',
          message: 'Events skipped in the last 7 days while the webhook was off are sent in order, with their original IDs.',
          confirmText: 'Deliver skipped events',
        });
        if (!resend) return;
        this.webhookService.redeliverSkipped(row.id).subscribe({
          next: (res) => this.toast.success(res.queued ? `${res.queued} skipped events queued` : 'No skipped events to deliver'),
          error: (err) => this.toast.error(err.error?.error ?? 'Could not redeliver'),
        });
      },
      error: (err) => this.toast.error(err.error?.error ?? 'Could not turn the webhook on'),
    });
  }

  async deleteWebhook(row: WebhookTarget): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete webhook?',
      message: `${row.url} will stop receiving events.`,
      confirmText: 'Delete webhook',
    });
    if (!ok) return;
    this.webhookService.delete(row.id).subscribe({
      next: () => { this.toast.success('Webhook deleted'); this.loadWebhooks(); },
      error: err => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }

  loadRepositories(): void {
    this.repositoriesLoading = true;
    this.repositoryService.list().subscribe({
      next: list => { this.repositories = list; this.ensureRegistryKey(); },
      error: err => { this.repositoriesLoading = false; this.toast.error(err.error?.error ?? 'Failed to load repositories'); },
      complete: () => (this.repositoriesLoading = false),
    });
  }
  repositoriesForEco(): PackageRepositoryRow[] {
    const order = { remote: 0, virtual: 1 };
    return this.repositories
      .filter(row => row.ecosystem === this.registryEco)
      .sort((a, b) => order[a.type] - order[b.type] || a.key.localeCompare(b.key));
  }
  repositoryTarget(row: PackageRepositoryRow): string {
    if (row.type === 'remote') return row.upstreamUrl || '—';
    if (row.key === 'all') return `Every enabled remote: ${row.memberKeys.join(' → ')}`;
    return row.memberKeys.length ? row.memberKeys.join(' → ') : 'No members';
  }
  /** R4: a virtual repository that searches a public remote before an internal one. */
  orderWarningFor(row: PackageRepositoryRow): string | null {
    if (row.type !== 'virtual') return null;
    return orderWarning(row.memberKeys, this.repositories.filter((other) => other.ecosystem === row.ecosystem));
  }
  openAddRepository(): void {
    void this.router.navigate(['/settings/repositories/new'], { queryParams: { eco: this.registryEco } });
  }
  editRepository(row: PackageRepositoryRow): void {
    void this.router.navigate(['/settings/repositories', row.id, 'edit']);
  }
  async deleteRepository(row: PackageRepositoryRow): Promise<void> {
    if (row.isReserved) return;
    const usage = await firstValueFrom(this.repositoryService.usage(row.id)).catch(() => null);
    const impact = usage ? deletionImpact(usage) : [];
    const ok = await this.confirm.confirm({
      title: 'Delete repository?',
      message: [`Clients configured for ${row.clientPath} will start failing.`, ...impact, `This can't be undone.`].join(' '),
      confirmText: 'Delete repository',
    });
    if (!ok) return;
    this.repositoryService.delete(row.id).subscribe({
      next: () => { this.toast.success(`Deleted ${row.key}`); this.loadRepositories(); },
      error: err => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
  testRepository(row: PackageRepositoryRow): void {
    this.testingId = row.id;
    this.repositoryService.test(row.id).subscribe({
      next: res => { this.testingId = null; this.toast.success(`${row.key} is reachable (${res.latencyMs} ms)`); },
      error: err => { this.testingId = null; this.toast.error(err.error?.error ?? `Could not reach ${row.key}`); },
    });
  }
}
