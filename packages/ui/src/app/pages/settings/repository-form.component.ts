import { Component, HostListener, OnDestroy, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  EffectivePolicy,
  PackageRepositoryRow,
  RepositoryService,
  RepositorySource,
  RepositoryType,
  RepositoryWritePayload,
} from '../../services/repository.service';
import { ConfigService } from '../../services/config.service';
import { ToastService } from '../../services/toast.service';
import { BreadcrumbService } from '../../services/breadcrumb.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { ecosystemLabel, isPackageEcosystem } from '../../shared/status';
import { clientPathFor } from '../../shared/client-path';
import { moveKey, orderWarning } from '../../shared/repository-order';

/** Well-known public registry hosts (deps.dev's list plus Packagist). */
export const PUBLIC_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'repo1.maven.org',
  'repo.maven.apache.org',
  'maven.google.com',
  'dl.google.com',
  'repo.jenkins-ci.org',
  'plugins.gradle.org',
  'api.nuget.org',
  'crates.io',
  'index.crates.io',
  'static.crates.io',
  'rubygems.org',
  'index.rubygems.org',
  'repo.packagist.org',
  'packagist.org',
];

const AUTH_TYPES = [
  { value: '', label: 'None' },
  { value: 'basic', label: 'Basic (username/password)' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'header', label: 'Custom header' },
];

/**
 * Settings → Repositories → Add repository (`/settings/repositories/new?eco=npm`) and Edit
 * (`/settings/repositories/:id/edit`): the form on the left and, always in view, a summary with the
 * client URL and Create/Update on the right. After a save the summary links to the repository's
 * snippet on the Registry page. Cancel returns to the Repositories tab on the same ecosystem.
 */
@Component({
  selector: 'app-repository-form',
  standalone: true,
  imports: [FormsModule, RouterLink, EmptyStateComponent],
  template: `
    <div class="dg-page rf-page">
      <a class="rf-back" href="#" (click)="cancel(); $event.preventDefault()" data-testid="repo-back">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>Repositories
      </a>
      <header class="dg-page-header">
        <div class="min-w-0">
          <h1 class="dg-page-title">{{ editing ? 'Edit repository' : 'Add repository' }}</h1>
          <p class="dg-page-subtitle">{{ ecosystemName }}{{ editing ? ' · ' + key : '' }}</p>
        </div>
      </header>
      @if (loadError) {
        <section class="dg-card">
          <app-empty-state icon="search_off" title="Repository not found" [description]="loadError">
            <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()">Back to Repositories</button>
          </app-empty-state>
        </section>
      } @else if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="rf-layout">
          <section class="dg-card rf-main" aria-label="Repository">
            <div class="dg-field-row">
              <div>
                <label class="form-label" for="repo-type">Type</label>
                <select id="repo-type" class="form-select" [(ngModel)]="type" [disabled]="editing">
                  <option value="remote">Remote</option>
                  <option value="virtual">Virtual</option>
                </select>
              </div>
              <div>
                <label class="form-label" for="repo-key">Key</label>
                <input id="repo-key" class="form-control font-mono" [(ngModel)]="key" [disabled]="editing" placeholder="e.g. github" autocomplete="off" />
              </div>
            </div>
            <span class="dg-form-help mt-0 mb-3">
              {{ type === 'remote' ? 'Proxies one upstream registry.' : 'Serves several remote repositories behind one URL.' }}
              @if (!editing) {
                The key becomes part of the client URL; <code class="dg-inline-code">default</code> and <code class="dg-inline-code">all</code> are reserved.
              }
              @if (!editing && key.trim() && !validKey()) {
                <span class="text-danger d-block">Use lowercase letters, numbers and hyphens, starting with a letter or number.</span>
              }
            </span>
            <div class="dg-field">
              <label class="form-label" for="repo-description">Description <span class="dg-optional">(optional)</span></label>
              <input id="repo-description" class="form-control" [(ngModel)]="description" autocomplete="off" />
            </div>

            @if (type === 'remote') {
              <p class="dg-section-label mt-4">Upstream</p>
              <div class="dg-field">
                <label class="form-label" for="repo-upstream">Upstream URL</label>
                <input id="repo-upstream" class="form-control" [(ngModel)]="upstreamUrl" placeholder="https://registry.example.com" autocomplete="off" />
              </div>
              <fieldset class="dg-field" data-testid="repo-source" style="border: 0; padding: 0; min-width: 0">
                <legend class="form-label" style="float: none; width: auto">Source</legend>
                @if (reserved) {
                  <span class="dg-chip" data-testid="repo-source-fixed">Public (fixed)</span>
                  <span class="dg-form-help d-block">The default remote is the public registry.</span>
                } @else {
                  <div class="form-check">
                    <input class="form-check-input" type="radio" name="repo-source" id="repo-source-public" value="public" [(ngModel)]="source" />
                    <label class="form-check-label" for="repo-source-public">Public registry</label>
                  </div>
                  <div class="form-check">
                    <input class="form-check-input" type="radio" name="repo-source" id="repo-source-internal" value="internal" [(ngModel)]="source" />
                    <label class="form-check-label" for="repo-source-internal">Internal registry</label>
                  </div>
                  @if (source === 'internal') {
                    <span class="dg-form-help d-block" data-testid="repo-source-help">
                      Your company controls what is published here. Only internal remotes can serve your reserved names.
                    </span>
                  } @else if (source === 'public') {
                    <span class="dg-form-help d-block" data-testid="repo-source-help">
                      Anyone can publish here. Missing publish dates and licenses are looked up on deps.dev, never for reserved names.
                    </span>
                  }
                  @if (!editing && !source) {
                    <span class="dg-form-help text-danger d-block" data-testid="repo-source-required">Choose a source.</span>
                  }
                  @if (source === 'internal' && looksPublic()) {
                    <span class="dg-form-help text-danger d-block" data-testid="repo-source-public-warning">This looks like a public registry, so it should not serve your internal names.</span>
                  }
                }
              </fieldset>
              <div class="dg-field-row">
                <div>
                  <label class="form-label" for="repo-timeout">Timeout (ms)</label>
                  <input id="repo-timeout" type="number" min="1" class="form-control" [(ngModel)]="timeoutMs" />
                </div>
                <div>
                  <label class="form-label" for="repo-retries">Retries</label>
                  <input id="repo-retries" type="number" min="0" class="form-control" [(ngModel)]="retryCount" />
                </div>
              </div>

              <p class="dg-section-label mt-4">Authentication</p>
              <div class="dg-field">
                <label class="form-label" for="repo-auth">Upstream authentication</label>
                <select id="repo-auth" class="form-select" [(ngModel)]="authType">
                  @for (a of authTypes; track a.value) {
                    <option [value]="a.value">{{ a.label }}</option>
                  }
                </select>
                @if (editing && authType) {
                  <span class="dg-form-help">Leave empty to keep the stored credentials.</span>
                }
              </div>
              @if (authType === 'basic') {
                <div class="dg-field-row">
                  <div>
                    <label class="form-label" for="repo-auth-user">Username</label>
                    <input id="repo-auth-user" class="form-control" [(ngModel)]="authUsername" autocomplete="off" />
                  </div>
                  <div>
                    <label class="form-label" for="repo-auth-pass">Password</label>
                    <input id="repo-auth-pass" class="form-control" type="password" [(ngModel)]="authPassword" autocomplete="new-password" />
                  </div>
                </div>
              }
              @if (authType === 'bearer') {
                <div class="dg-field">
                  <label class="form-label" for="repo-auth-token">Bearer token</label>
                  <input id="repo-auth-token" class="form-control" type="password" [(ngModel)]="authToken" autocomplete="off" />
                </div>
              }
              @if (authType === 'header') {
                <div class="dg-field-row">
                  <div>
                    <label class="form-label" for="repo-auth-header">Header name</label>
                    <input id="repo-auth-header" class="form-control" [(ngModel)]="authHeaderName" autocomplete="off" />
                  </div>
                  <div>
                    <label class="form-label" for="repo-auth-value">Header value</label>
                    <input id="repo-auth-value" class="form-control" type="password" [(ngModel)]="authHeaderValue" autocomplete="off" />
                  </div>
                </div>
              }
            }

            @if (type === 'virtual') {
              <p class="dg-section-label mt-4">Members</p>
              @if (key === 'all') {
                <div class="dg-callout mb-3">
                  <span class="material-symbols-outlined">info</span>
                  <span><code class="dg-inline-code">all</code> includes every enabled remote repository automatically. New remotes join the end of the order.</span>
                </div>
              } @else {
                <div class="dg-field" id="repo-members">
                  @if (candidates.length === 0) {
                    <span class="dg-form-help mt-0">Create a remote repository first.</span>
                  } @else {
                    @for (row of candidates; track row.id) {
                      <div class="form-check">
                        <input class="form-check-input" type="checkbox" [id]="'member-' + row.key" [checked]="isMember(row.key)" (change)="toggleMember(row.key)" />
                        <label class="form-check-label" [for]="'member-' + row.key"><span class="font-mono">{{ row.key }}</span> <span class="dg-text-muted text-xs">{{ row.source === 'internal' ? 'internal' : 'public' }}</span></label>
                      </div>
                    }
                  }
                </div>
              }
              @if (memberKeys.length > 0) {
                <div class="dg-field" data-testid="repo-order">
                  <span class="form-label d-block">Search order</span>
                  <ol class="repo-order">
                    @for (memberKey of memberKeys; track memberKey; let i = $index) {
                      <li class="repo-order-row" [attr.data-testid]="'repo-order-' + memberKey">
                        <span class="repo-order-index">{{ i + 1 }}</span>
                        <span class="font-mono">{{ memberKey }}</span>
                        <span class="dg-chip" [class.dg-chip-accent]="sourceOf(memberKey) === 'internal'">{{ sourceOf(memberKey) }}</span>
                        <span class="dg-toolbar-spacer"></span>
                        <button type="button" class="dg-icon-btn" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'Move ' + memberKey + ' up'" title="Move up">
                          <span class="material-symbols-outlined">arrow_upward</span>
                        </button>
                        <button type="button" class="dg-icon-btn" [disabled]="i === memberKeys.length - 1" (click)="move(i, 1)" [attr.aria-label]="'Move ' + memberKey + ' down'" title="Move down">
                          <span class="material-symbols-outlined">arrow_downward</span>
                        </button>
                      </li>
                    }
                  </ol>
                  <span class="dg-form-help d-block">The first remote that has the package serves it. If a remote is down, the search stops there.</span>
                  @if (warning; as message) {
                    <div class="dg-callout is-warning mt-2" data-testid="repo-order-warning">
                      <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                      <div>{{ message }}</div>
                    </div>
                  }
                </div>
              }
            }

            @if (editing) {
              <p class="dg-section-label mt-4">Effective policies</p>
              <div data-testid="repo-effective-policies">
                @if (effectivePolicies === null) {
                  <span class="dg-form-help">Loading…</span>
                } @else if (effectivePolicies.length === 0) {
                  <span class="dg-form-help">No enabled policy applies to this repository.</span>
                } @else {
                  <div class="dg-detail-list">
                    @for (p of effectivePolicies; track p.id) {
                      <div class="dg-detail-row">
                        <div class="dg-detail-label"><span class="dg-tag">{{ p.priority }}</span></div>
                        <div class="dg-detail-value">
                          <a [routerLink]="['/policies']" class="dg-detail-text">{{ p.name }}</a>
                          <span class="dg-chip" [class.dg-chip-accent]="p.scope === 'scoped'">{{ p.scope === 'scoped' ? 'This repository' : 'All repositories' }}</span>
                          @if (p.mode === 'monitor') { <span class="dg-chip">Monitoring</span> }
                        </div>
                      </div>
                    }
                  </div>
                }
                <span class="dg-form-help d-block">Enabled policies, in evaluation order. Edit them on Policies.</span>
              </div>
            }
          </section>

          <aside class="rf-aside" aria-label="Summary">
            <div class="dg-card rf-summary" data-testid="repo-summary-panel">
              <p class="dg-section-label mb-0">Summary</p>
              @if (saved) {
                <div class="dg-callout is-success rf-saved" role="status" data-testid="repo-saved">
                  <span class="material-symbols-outlined" aria-hidden="true">check_circle</span>
                  <div class="min-w-0">
                    <div class="rf-saved-title">{{ saved === 'created' ? 'Repository added' : 'Changes saved' }}</div>
                    <div>Point your package manager at it.</div>
                    <a class="dg-btn dg-btn-secondary dg-btn-sm mt-2" routerLink="/registry" [queryParams]="clientSetupParams" data-testid="repo-client-setup">
                      <span class="material-symbols-outlined">terminal</span> Open client setup
                    </a>
                  </div>
                </div>
              }
              <div class="dg-detail-list rf-facts">
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Ecosystem</div>
                  <div class="dg-detail-value"><span class="dg-chip">{{ ecosystemName }}</span></div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Type</div>
                  <div class="dg-detail-value"><span class="dg-detail-text">{{ type === 'remote' ? 'Remote' : 'Virtual' }}</span></div>
                </div>
                @if (type === 'remote') {
                  <div class="dg-detail-row">
                    <div class="dg-detail-label">Source</div>
                    <div class="dg-detail-value" data-testid="repo-summary-source">
                      <span class="dg-chip" [class.dg-chip-accent]="source === 'internal'">{{ sourceSummary }}</span>
                    </div>
                  </div>
                  <div class="dg-detail-row">
                    <div class="dg-detail-label">Upstream</div>
                    <div class="dg-detail-value"><span class="dg-detail-text rf-wrap">{{ upstreamHost || 'Not set' }}</span></div>
                  </div>
                } @else {
                  <div class="dg-detail-row">
                    <div class="dg-detail-label">Searches</div>
                    <div class="dg-detail-value"><span class="dg-detail-text rf-wrap">{{ membersSummary }}</span></div>
                  </div>
                }
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Client URL</div>
                  <div class="dg-detail-value" data-testid="repo-client-url">
                    @if (clientUrl; as url) {
                      <code class="rf-url">{{ url }}</code>
                      <button type="button" class="dg-icon-btn" (click)="copyClientUrl(url)" title="Copy client URL" aria-label="Copy client URL">
                        <span class="material-symbols-outlined">content_copy</span>
                      </button>
                    } @else {
                      <span class="dg-detail-text">Enter a key</span>
                    }
                  </div>
                </div>
                <div class="dg-detail-row rf-enabled-row">
                  <div class="dg-detail-label"><label for="repoEnabled">Enabled</label></div>
                  <div class="dg-detail-value">
                    <button id="repoEnabled" type="button" class="dg-switch" role="switch" [class.is-on]="isEnabled" [attr.aria-checked]="isEnabled"
                      (click)="isEnabled = !isEnabled" data-testid="repo-enabled"></button>
                  </div>
                </div>
              </div>
              @if (!isEnabled && (key === 'default' || key === 'all')) {
                <span class="dg-form-help mt-0">Turning this off stops client requests to this repository URL.</span>
              }
              @if (saveBlocker(); as blocker) {
                <div class="rf-next" role="status">
                  <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  <span><span class="rf-next-label">Next: </span><button type="button" class="rf-next-link" (click)="goToBlocker()"
                    data-testid="repo-save-blocker">{{ blocker }}</button></span>
                </div>
              }
              <div class="rf-actions">
                @if (editing && !saved) {
                  <a class="rf-link me-auto" routerLink="/registry" [queryParams]="clientSetupParams">Client setup</a>
                }
                <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()" data-testid="repo-cancel">{{ saved && !dirty ? 'Done' : 'Cancel' }}</button>
                <button type="button" class="dg-btn dg-btn-primary" data-testid="repo-save" (click)="save()" [disabled]="!valid() || saving">
                  {{ saving ? 'Saving…' : editing ? 'Update repository' : 'Create repository' }}
                </button>
              </div>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .rf-back {
      display: inline-flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 0.8125rem; font-weight: 600;
      color: var(--color-on-surface-variant); text-decoration: none; align-self: flex-start;
    }
    .rf-back .material-symbols-outlined { font-size: 18px; }
    .rf-back:hover { color: var(--brand-text); }
    .rf-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
    .rf-main { padding: 20px 24px; min-width: 0; }
    .rf-main > .dg-section-label:first-child { margin-top: 0 !important; }
    /* Below the app header (h-16, sticky). */
    .rf-aside { position: sticky; top: 80px; min-width: 0; }
    .rf-summary { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .rf-saved { margin: 0; }
    .rf-saved-title { font-weight: 600; color: var(--color-on-surface); }
    .rf-facts { margin: 0; }
    .rf-wrap { overflow-wrap: anywhere; }
    .rf-url { font-family: var(--font-mono); font-size: 0.75rem; color: var(--color-on-surface); overflow-wrap: anywhere; min-width: 0; }
    .rf-enabled-row label { margin: 0; cursor: pointer; }
    .rf-next {
      display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--info-border); border-radius: var(--radius);
      background: var(--info-bg); font-size: 0.8125rem; line-height: 1.4; color: var(--color-on-surface);
    }
    .rf-next > .material-symbols-outlined { font-size: 16px; margin-top: 1px; color: var(--info-fg); }
    .rf-next-label { font-weight: 600; }
    .rf-next-link {
      padding: 0; border: 0; background: none; font: inherit; text-align: left; color: var(--brand-text);
      text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
    }
    .rf-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
    .rf-link { font-size: 0.8125rem; font-weight: 600; color: var(--brand-text); text-decoration: none; }
    .rf-link:hover { text-decoration: underline; }
    .repo-order { list-style: none; padding: 0; margin: 0 0 4px; border: 1px solid var(--color-border); border-radius: var(--radius); }
    .repo-order-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
    .repo-order-row + .repo-order-row { border-top: 1px solid var(--color-border); }
    .repo-order-index { width: 18px; color: var(--color-text-muted, #6b7280); font-size: 0.75rem; text-align: right; }
    @media (max-width: 991.98px) {
      .rf-layout { grid-template-columns: minmax(0, 1fr); }
      .rf-main { padding: 16px; }
      /* On narrow screens the summary follows the form: the saved note, Enabled and the buttons stay at the bottom. */
      .rf-aside { position: sticky; top: auto; bottom: 0; z-index: 5; }
      .rf-summary { border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: var(--shadow-md); }
      .rf-facts .dg-detail-row:not(.rf-enabled-row) { display: none; }
    }
  `],
})
export class RepositoryFormComponent implements OnDestroy {
  editing = false;
  id = '';
  ecosystem = 'npm';
  type: RepositoryType = 'remote';
  /** Empty until the admin chooses, for a new remote. */
  source: RepositorySource | '' = '';
  /** The reserved `default` remote: always public. */
  reserved = false;
  key = '';
  description = '';
  upstreamUrl = '';
  timeoutMs = 30000;
  retryCount = 3;
  isEnabled = true;
  memberKeys: string[] = [];
  candidates: PackageRepositoryRow[] = [];
  authType = '';
  authUsername = '';
  authPassword = '';
  authToken = '';
  authHeaderName = '';
  authHeaderValue = '';
  saving = false;
  authTypes = AUTH_TYPES;
  /** Enabled policies that apply to this repository; null while loading. */
  effectivePolicies: EffectivePolicy[] | null = null;
  /** Editing: the repository is being fetched. */
  loading = false;
  /** Editing: why the repository could not be loaded. */
  loadError = '';
  /** Set after a save, to offer the client setup for this repository. */
  saved: 'created' | 'updated' | null = null;
  /** The server's client path once the repository exists. */
  clientPath = '';
  gatewayBaseUrl = '';

  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private repositories = inject(RepositoryService);
  private configService = inject(ConfigService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private crumbs = inject(BreadcrumbService);
  private cleanState = '';

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    this.crumbs.detail.set(id ? 'Edit repository' : 'Add repository');
    this.configService.getGateway().subscribe({ next: (cfg) => (this.gatewayBaseUrl = cfg.baseUrl ?? ''), error: () => undefined });
    if (!id) {
      const eco = this.route.snapshot.queryParamMap.get('eco');
      if (isPackageEcosystem(eco)) this.ecosystem = eco!;
      this.loadCandidates();
      this.markClean();
      return;
    }
    this.editing = true;
    this.loading = true;
    // A create lands here with { saved: 'created' } so the summary can offer the client setup.
    const state = this.router.getCurrentNavigation()?.extras.state as { saved?: 'created' } | undefined;
    if (state?.saved === 'created') this.saved = 'created';
    this.repositories.list().subscribe({
      next: (rows) => {
        const row = rows.find((item) => item.id === id);
        this.loading = false;
        if (!row) {
          this.loadError = 'This repository no longer exists. It may have been deleted.';
          return;
        }
        this.fill(row);
        this.candidates = rows.filter((item) => item.ecosystem === row.ecosystem && item.type !== 'virtual');
        this.markClean();
        this.repositories.policies(row.id).subscribe({
          next: (list) => (this.effectivePolicies = list),
          error: () => (this.effectivePolicies = []),
        });
      },
      error: (err) => {
        this.loading = false;
        this.loadError = err.error?.error ?? 'Could not load the repository.';
      },
    });
  }

  ngOnDestroy(): void {
    this.crumbs.detail.set(null);
  }

  private fill(row: PackageRepositoryRow): void {
    this.id = row.id;
    this.ecosystem = row.ecosystem;
    this.type = row.type;
    this.key = row.key;
    this.description = row.description ?? '';
    this.upstreamUrl = row.upstreamUrl ?? '';
    this.source = row.source === 'internal' ? 'internal' : 'public';
    this.reserved = row.isReserved && row.type === 'remote';
    this.timeoutMs = row.timeoutMs;
    this.retryCount = row.retryCount;
    this.isEnabled = row.isEnabled;
    this.memberKeys = [...row.memberKeys];
    this.authType = row.authType ?? '';
    this.clientPath = row.clientPath;
  }

  private loadCandidates(): void {
    this.repositories.list(this.ecosystem).subscribe({
      next: (rows) => (this.candidates = rows.filter((row) => row.type !== 'virtual')),
    });
  }

  get ecosystemName(): string {
    return ecosystemLabel(this.ecosystem);
  }

  /** Where Cancel and the back link go: the Repositories tab on this ecosystem. */
  get returnUrl(): string {
    return `/settings?tab=upstreams&eco=${encodeURIComponent(this.ecosystem)}`;
  }

  get clientSetupParams(): Record<string, string> {
    return { eco: this.ecosystem, key: this.key.trim().toLowerCase() };
  }

  /** The URL package clients use, once there is a valid key. */
  get clientUrl(): string {
    const key = this.key.trim().toLowerCase();
    if (!key || (!this.editing && !this.validKey())) return '';
    const path = this.clientPath || clientPathFor(this.ecosystem, key);
    const base = this.gatewayBaseUrl.replace(/\/$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  get sourceSummary(): string {
    if (this.reserved) return 'Public (fixed)';
    if (this.source === 'internal') return 'Internal';
    if (this.source === 'public') return 'Public';
    return 'Not chosen';
  }

  get upstreamHost(): string {
    const url = this.upstreamUrl.trim();
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  get membersSummary(): string {
    if (this.key === 'all' && this.memberKeys.length === 0) return 'Every enabled remote';
    return this.memberKeys.length ? this.memberKeys.join(' → ') : 'No members';
  }

  async copyClientUrl(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
      this.toast.success('Client URL copied');
    } catch {
      this.toast.error('Could not copy to the clipboard');
    }
  }

  /** Same host list as the backend: an internal remote on one of these is probably a mistake. */
  looksPublic(): boolean {
    try {
      return PUBLIC_REGISTRY_HOSTS.includes(new URL(this.upstreamUrl.trim()).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  /** `internal` or `public` for a member remote. */
  sourceOf(key: string): string {
    return this.candidates.find((row) => row.key === key)?.source === 'internal' ? 'internal' : 'public';
  }

  move(index: number, delta: number): void {
    this.memberKeys = moveKey(this.memberKeys, index, delta);
  }

  /** R4: a public remote searched before an internal one. */
  get warning(): string | null {
    return orderWarning(this.memberKeys, this.candidates);
  }

  validKey(): boolean {
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(this.key.trim().toLowerCase());
  }

  isMember(key: string): boolean {
    return this.memberKeys.includes(key);
  }

  toggleMember(key: string): void {
    this.memberKeys = this.isMember(key)
      ? this.memberKeys.filter((item) => item !== key)
      : [...this.memberKeys, key];
  }

  /** What still stops Create/Update, in words; null when the form can be saved. */
  saveBlocker(): string | null {
    if (!this.editing && !this.validKey()) return this.key.trim() ? 'Fix the key' : 'Enter a key';
    if (this.type === 'remote' && !this.upstreamUrl.trim()) return 'Enter the upstream URL';
    if (this.type === 'remote' && !this.reserved && !this.source) return 'Choose a source';
    return null;
  }

  goToBlocker(): void {
    const blocker = this.saveBlocker();
    const target = blocker?.includes('key') ? 'repo-key' : blocker?.includes('upstream') ? 'repo-upstream' : 'repo-source-public';
    document.getElementById(target)?.focus();
  }

  valid(): boolean {
    return this.saveBlocker() === null;
  }

  /** Whether the form differs from what was loaded (or from a blank form). */
  get dirty(): boolean {
    return !this.loading && !this.loadError && this.state() !== this.cleanState;
  }

  /** For the route guard: true to leave, after asking when there are unsaved changes. */
  canLeave(): boolean | Promise<boolean> {
    if (!this.dirty) return true;
    return this.confirm.confirm({
      title: 'Discard changes?',
      message: this.editing ? 'Your changes to this repository have not been saved.' : 'This repository has not been added yet.',
      confirmText: 'Discard changes',
      tone: 'danger',
    });
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty) event.preventDefault();
  }

  cancel(): void {
    void this.router.navigateByUrl(this.returnUrl);
  }

  private markClean(): void {
    this.cleanState = this.state();
  }

  private state(): string {
    return JSON.stringify([
      this.type, this.key, this.description, this.upstreamUrl, this.source, this.timeoutMs, this.retryCount, this.isEnabled,
      this.memberKeys, this.authType, this.authUsername, this.authPassword, this.authToken, this.authHeaderName, this.authHeaderValue,
    ]);
  }

  save(): void {
    if (!this.valid() || this.saving) return;
    this.saving = true;
    const payload: RepositoryWritePayload = {
      description: this.description.trim(),
      isEnabled: this.isEnabled,
    };
    if (this.type === 'remote') {
      payload.upstreamUrl = this.upstreamUrl.trim();
      if (!this.reserved && this.source) payload.source = this.source;
      payload.timeoutMs = this.timeoutMs;
      payload.retryCount = this.retryCount;
      payload.authType = (this.authType || null) as RepositoryWritePayload['authType'];
      payload.authUsername = this.authUsername;
      payload.authPassword = this.authPassword;
      payload.authToken = this.authToken;
      payload.authHeaderName = this.authHeaderName;
      payload.authHeaderValue = this.authHeaderValue;
    }
    // For `all` the list is its search order (R2); for a custom virtual, its members in order.
    if (this.type === 'virtual') {
      payload.memberKeys = this.memberKeys;
    }
    if (!this.editing) {
      this.repositories.create({ ...payload, ecosystem: this.ecosystem, key: this.key.trim().toLowerCase(), type: this.type }).subscribe({
        next: (row) => {
          this.toast.success('Repository added');
          this.markClean();
          void this.router.navigate(['/settings/repositories', row.id, 'edit'], { replaceUrl: true, state: { saved: 'created' } });
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.error ?? 'Save failed');
        },
      });
      return;
    }
    this.repositories.update(this.id, payload).subscribe({
      next: (row) => {
        this.saving = false;
        this.toast.success('Repository updated');
        if (row?.clientPath) this.clientPath = row.clientPath;
        // Stored secrets are never echoed back; clear what was typed so the form matches the server.
        this.authUsername = this.authPassword = this.authToken = this.authHeaderName = this.authHeaderValue = '';
        this.markClean();
        this.saved = 'updated';
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Save failed');
      },
    });
  }
}
