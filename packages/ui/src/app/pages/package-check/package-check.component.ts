import { Component, DestroyRef, Injector, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { RepositoryService } from '../../services/repository.service';
import {
  CheckedVersion,
  PackageCheckRequest,
  PackageCheckResult,
  PackageCheckService,
} from '../../services/package-check.service';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ECOSYSTEMS, ecosystemLabel, isPackageEcosystem } from '../../shared/status';
import { MODAL_DATA } from '../../tokens';
import { RequestWaiverDialogComponent } from '../waivers/request-waiver-dialog.component';
import { AddExceptionDialogComponent } from '../exceptions/add-exception-dialog.component';
import { versionInputError } from '../waivers/waiver-version';
import {
  NAME_PLACEHOLDERS,
  RecentCheck,
  displayPackageName,
  installCommand,
  isUnblockable,
  mergeRows,
  osvUrl,
  cvssLabel,
  epssLabel,
  panelTone,
  projectHealthMessage,
  readRecentChecks,
  recheckAfterLabel,
  releaseTypeLabel,
  rememberCheck,
  scoreTone,
  statusView,
  visibleRows,
} from './package-check';
import type { ProjectHealth } from '../../services/package-check.service';

type ErrorState = { kind: 'not_found' | 'upstream'; title: string; detail: string };

@Component({
  selector: 'app-package-check',
  standalone: true,
  imports: [DatePipe, NgTemplateOutlet, FormsModule, RouterLink, EcoTagComponent, EmptyStateComponent, StatusPillComponent],
  template: `
    <div class="dg-page">
      <header class="dg-page-header">
        <div>
          <h1 class="dg-page-title">Package check</h1>
          <p class="dg-page-subtitle">See which versions you can install and why others are blocked. Uses your real policies; nothing is downloaded.</p>
        </div>
      </header>

      <section class="dg-card">
        <form class="pc-search" (ngSubmit)="submit()" novalidate>
          <label class="pc-field">
            <span>Ecosystem</span>
            <select class="dg-select" name="ecosystem" [(ngModel)]="ecosystem" (ngModelChange)="onEcosystemChange()">
              @for (eco of ecosystems; track eco) {
                <option [value]="eco">{{ label(eco) }}</option>
              }
            </select>
          </label>
          <label class="pc-field pc-grow">
            <span>Package</span>
            <input class="dg-input" name="package" [(ngModel)]="packageName" [placeholder]="namePlaceholder()"
              autocomplete="off" autocapitalize="off" spellcheck="false" />
          </label>
          @if (repositories.length > 1) {
            <label class="pc-field">
              <span>Repository</span>
              <select class="dg-select" name="repository" [(ngModel)]="repository">
                @for (key of repositories; track key) {
                  <option [value]="key">{{ key }}</option>
                }
              </select>
            </label>
          }
          <label class="pc-field pc-version">
            <span>Version <span class="dg-optional">(optional)</span></span>
            <input class="dg-input font-mono" name="version" [(ngModel)]="version" placeholder="e.g. 1.2.3"
              autocomplete="off" spellcheck="false" />
          </label>
          <button type="submit" class="dg-btn dg-btn-primary pc-submit" [disabled]="checking">
            @if (checking && !loadingMore) {
              <span class="dg-spinner is-sm on-brand" aria-hidden="true"></span>
            } @else {
              <span class="material-symbols-outlined" aria-hidden="true">fact_check</span>
            }
            Check
          </button>
        </form>
        @if (formError) {
          <p class="pc-form-error" role="alert">{{ formError }}</p>
        }
        @if (recent.length) {
          <div class="pc-recent">
            <span class="pc-recent-label">Recent</span>
            @for (item of recent; track item.ecosystem + item.package + item.repository) {
              <button type="button" class="dg-chip pc-recent-chip" (click)="checkRecent(item)">
                {{ label(item.ecosystem) }} · {{ display(item.ecosystem, item.package) }}
                @if (item.repository !== 'default') {
                  <span class="dg-text-muted">· {{ item.repository }}</span>
                }
              </button>
            }
          </div>
        }
      </section>

      @if (checking && !result && !loadingMore) {
        <section class="dg-card"><div class="dg-loading"><span class="dg-spinner"></span></div></section>
      } @else if (error) {
        <section class="dg-card">
          @if (error.kind === 'not_found') {
            <app-empty-state icon="search_off" [title]="error.title" [description]="error.detail" />
          } @else {
            <app-empty-state icon="cloud_off" [title]="error.title" [description]="error.detail">
              <button type="button" class="dg-btn dg-btn-secondary" (click)="retry()">
                <span class="material-symbols-outlined">refresh</span> Retry
              </button>
            </app-empty-state>
          }
        </section>
      } @else if (result) {
        @if (result.packageNotice?.kind === 'malware') {
          <div class="dg-banner dg-banner-block" role="alert">
            <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">gpp_bad</span>
            <div>
              <div class="dg-banner-name">Malicious package</div>
              <p class="dg-banner-copy">
                {{ result.packageNotice?.message }}. No version can be installed, and waivers are not possible.
                @if (isSecurity) {
                  Security can override the entry in <a routerLink="/malicious">Malware Packages</a>.
                }
              </p>
            </div>
          </div>
        } @else if (result.packageNotice?.kind === 'policy') {
          <div class="dg-banner dg-banner-block" role="alert">
            <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">block</span>
            <div>
              <div class="dg-banner-name">Blocked by policy</div>
              <p class="dg-banner-copy">{{ result.packageNotice?.message }}.</p>
            </div>
          </div>
        } @else if (result.packageNotice?.kind === 'namespace') {
          <div class="dg-banner dg-banner-block" role="alert" data-testid="namespace-notice">
            <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">domain</span>
            <div>
              <div class="dg-banner-name">{{ result.namespace?.outcome === 'notFound' ? 'Not found in internal remotes' : 'Blocked: internal namespace' }}</div>
              <p class="dg-banner-copy">{{ result.packageNotice?.message }}</p>
              @if (result.packageNotice?.policyName) {
                <p class="dg-banner-copy">Policy: {{ result.packageNotice?.policyName }}</p>
              }
            </div>
          </div>
        }
        @if (result.namespace; as ns) {
          <div class="dg-callout" role="status" data-testid="namespace-panel">
            <span class="material-symbols-outlined" aria-hidden="true">domain</span>
            <div>
              <strong>Reserved internal namespace {{ ns.pattern }}</strong> · policy {{ ns.policy }}{{ ns.mode === 'monitor' ? ' (monitor only)' : '' }}
              @if (ns.mode === 'monitor') {
                <div>Still served while the policy monitors. Downloads from a public remote are recorded on Monitoring.</div>
              } @else {
                <div data-testid="namespace-internal">
                  Served only from:
                  @for (r of ns.internalRemotes; track r) { <span class="dg-chip dg-chip-success">{{ r }}</span> }
                  @if (ns.internalRemotes.length === 0) { <span class="dg-chip dg-chip-danger">no internal remote</span> }
                </div>
                @if (ns.publicRemotesSkipped.length) {
                  <div data-testid="namespace-skipped">
                    Not consulted: @for (r of ns.publicRemotesSkipped; track r) { <span class="dg-chip">{{ r }}</span> }
                  </div>
                }
              }
            </div>
          </div>
        }
        @if (result.projectHealth; as health) {
          <section class="dg-card pc-health" aria-label="Project health" data-testid="project-health">
            <div class="pc-health-head">
              <span class="material-symbols-outlined" aria-hidden="true">health_and_safety</span>
              <strong>Project health</strong>
              <span class="dg-form-help">OpenSSF Scorecard · version {{ health.version }}</span>
            </div>
            @if (health.status === 'found') {
              <div class="pc-health-summary">
                <span class="pc-health-score dg-chip" [class]="'dg-chip-' + healthTone(health.overall!)" data-testid="project-health-score">{{ health.overall }} / 10</span>
                <a [href]="'https://' + health.project" target="_blank" rel="noopener" class="font-mono" data-testid="project-health-repo">{{ health.project }}</a>
                <span class="dg-chip" [class.dg-chip-success]="health.via === 'deps.dev' && health.provenance && health.provenance !== 'UNVERIFIED_METADATA'" data-testid="project-health-source">
                  {{ health.via === 'registry' ? 'Declared by the package' : 'From deps.dev' + (health.provenance ? ' · ' + health.provenance : '') }}
                </span>
                <span class="dg-form-help">scanned {{ health.date | date: 'MMM d, y' }}</span>
              </div>
              @if (health.scoreVia === 'deps.dev') {
                <p class="dg-form-help mb-2" data-testid="project-health-backup">Score from deps.dev because the Scorecard API had none. It may be older and miss some checks.</p>
              }
              @if (health.checks?.length) {
                <details class="pc-health-details" data-testid="project-health-details">
                  <summary>Details</summary>
                  <table class="table table-sm pc-health-checks">
                    <tbody>
                      @for (c of health.checks; track c.name) {
                        <tr>
                          <th scope="row">{{ c.name }}</th>
                          <td><span class="dg-chip" [class]="'dg-chip-' + healthTone(c.score)">{{ c.score < 0 ? 'Inconclusive' : c.score }}</span></td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </details>
              }
            } @else {
              <p class="mb-0" data-testid="project-health-message">{{ healthMessage(health) }}</p>
            }
          </section>
        }
        @if (result.missingVersions.length && result.packageNotice?.kind !== 'namespace') {
          <div class="dg-callout is-warning" role="alert">
            <span class="material-symbols-outlined" aria-hidden="true">warning</span>
            <div>
              <strong>Version {{ result.missingVersions.join(', ') }} not found.</strong>
              {{ display(result.ecosystem, result.package) }} has no such version in {{ result.repository }}. Pick one from the list below.
            </div>
          </div>
        }
        @if (dataUnavailable()) {
          <div class="dg-callout is-warning" role="status">
            <span class="material-symbols-outlined" aria-hidden="true">warning</span>
            <div>Vulnerability data could not be loaded. Versions that could not be fully checked are marked and never recommended. Try again shortly.</div>
          </div>
        }

        <section class="dg-card">
          <div class="dg-card-body">
            <div class="pc-summary-main">
              <div class="pc-title-row">
                <h2 class="pc-package">{{ display(result.ecosystem, result.package) }}</h2>
                <app-eco-tag [ecosystem]="result.ecosystem" />
                <span class="dg-tag">{{ result.repository }}</span>
              </div>
              <div class="pc-meta">
                <div class="pc-meta-when">
                  <span class="material-symbols-outlined" aria-hidden="true">schedule</span>
                  <span>
                    <span class="pc-meta-when-label">Checked {{ checkedLabel(result.checkedAt) }}</span>
                    <time [attr.datetime]="result.checkedAt">{{ result.checkedAt | date: 'MMM d, HH:mm:ss' }}</time>
                  </span>
                </div>
                <div class="pc-meta-facts">
                  <span class="pc-meta-fact">Checked against <span class="pc-meta-v">{{ result.checkedAgainst.join(', ') }}</span></span>
                  @if ((result.searchOrder?.length ?? 0) > 1) {
                    <span class="pc-meta-fact" data-testid="pc-search-order">Searched in order: <span class="pc-meta-v">{{ result.searchOrder!.join(' → ') }}</span></span>
                  }
                  @if (result.servedBy) {
                    <span class="pc-meta-fact" data-testid="pc-served-by">Served by <span class="pc-meta-v">{{ result.servedBy }}</span></span>
                  }
                </div>
              </div>
            </div>
            <div class="pc-panels">
            @for (row of requestedRows(); track row.version) {
              <div class="pc-panel" [class]="'pc-panel is-' + tone(row)" data-testid="requested-version">
                <div class="dg-meta-label">Version you asked for</div>
                <div class="pc-rec-row">
                  <span class="pc-rec-version">{{ row.version }}</span>
                  @if (row.releaseType !== 'stable') {
                    <span class="dg-chip dg-chip-warning pc-type">{{ releaseLabel(row.releaseType) }}</span>
                  }
                  @if (row.publishedAt) {
                    <span class="dg-text-muted text-xs">Released {{ row.publishedAt | date: 'MMM d, y' }}</span>
                  }
                </div>
                @if (row.license !== undefined) {
                  <ng-container *ngTemplateOutlet="licenseLine; context: { $implicit: row.license, testId: 'requested-license' }" />
                }
                <div class="pc-panel-status">
                  <app-status-pill [value]="row.status" [label]="view(row).label" [tone]="view(row).tone" />
                </div>
                <div class="pc-panel-reason">
                  <ng-container *ngTemplateOutlet="reasonDetail; context: { $implicit: row }" />
                  @if (row.status === 'allowed' && !row.policyName && !row.incomplete?.length && !row.monitoring?.length) {
                    <span class="dg-cell-sub">No policy blocks this version.</span>
                  }
                  @if (row.version === result.recommended?.version) {
                    <span class="dg-cell-sub">This is also the recommended version.</span>
                  }
                </div>
                @if (row.status === 'allowed') {
                  <div class="pc-install">
                    <pre class="dg-code">{{ install(row.version) }}</pre>
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="copy(install(row.version))">
                      <span class="material-symbols-outlined">content_copy</span> Copy
                    </button>
                  </div>
                } @else if (isUnblockable(row)) {
                  <div class="pc-panel-actions">
                    @if (canRequestWaiver) {
                      @if (row.waiverPending) {
                        <app-status-pill value="pending" label="Waiver pending" />
                      } @else {
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="requestWaiver(row)">Request waiver</button>
                      }
                    } @else if (isSecurity) {
                      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addException(row)">Add exception</button>
                    }
                  </div>
                }
              </div>
            }
            <div class="pc-recommended" [class.is-empty]="!result.recommended">
              @if (result.recommended; as rec) {
                <div class="dg-meta-label">Recommended version</div>
                <div class="pc-rec-row">
                  <span class="pc-rec-version">{{ rec.version }}</span>
                  @if (rec.releaseType !== 'stable') {
                    <span class="dg-chip dg-chip-warning">{{ releaseLabel(rec.releaseType) }}</span>
                  }
                  @if (rec.publishedAt) {
                    <span class="dg-text-muted text-xs">Released {{ rec.publishedAt | date: 'MMM d, y' }}</span>
                  }
                </div>
                @if (rec.license !== undefined) {
                  <ng-container *ngTemplateOutlet="licenseLine; context: { $implicit: rec.license, testId: 'recommended-license' }" />
                }
                @if (recommendedRow(); as recRow) {
                  <div class="pc-panel-status" data-testid="recommended-status">
                    <app-status-pill [value]="recRow.status" [label]="view(recRow).label" [tone]="view(recRow).tone" />
                  </div>
                  <div class="pc-panel-reason" data-testid="recommended-reason">
                    <ng-container *ngTemplateOutlet="reasonDetail; context: { $implicit: recRow }" />
                    @if (!recRow.policyName && !recRow.monitoring?.length) {
                      <span class="dg-cell-sub">No policy blocks this version.</span>
                    }
                  </div>
                }
                <div class="pc-install">
                  <pre class="dg-code">{{ install(rec.version) }}</pre>
                  <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="copy(install(rec.version))">
                    <span class="material-symbols-outlined">content_copy</span> Copy
                  </button>
                </div>
              } @else if (result.packageNotice?.kind !== 'malware') {
                <div class="dg-meta-label">Recommended version</div>
                <p class="pc-none">
                  No version of {{ display(result.ecosystem, result.package) }} is currently allowed{{ result.hasMore ? ' among the versions checked so far' : '' }}.
                  @if (canRequestWaiver) {
                    See the reasons below, and request a waiver for the version you need.
                  } @else if (isSecurity) {
                    See the reasons below. You can add an exception for one version.
                  }
                </p>
              }
            </div>
            </div>
          </div>
        </section>

        <section class="dg-card">
          <div class="dg-toolbar">
            <label class="pc-check">
              <input type="checkbox" class="form-check-input" [(ngModel)]="allowedOnly" />
              <span>Allowed only</span>
            </label>
            <label class="pc-check">
              <input type="checkbox" class="form-check-input" [(ngModel)]="hidePrerelease" />
              <span>Hide pre-releases</span>
            </label>
            <div class="dg-search pc-filter-search">
              <span class="material-symbols-outlined" aria-hidden="true">search</span>
              <input class="dg-input" type="search" placeholder="Filter versions" aria-label="Filter versions" [(ngModel)]="search" />
            </div>
            <span class="dg-toolbar-spacer"></span>
            <span class="dg-text-muted text-xs">Showing the newest {{ windowEnd() }} of {{ result.totalVersions }} versions</span>
          </div>

          @if (shown().length === 0) {
            <app-empty-state icon="filter_alt_off" [compact]="true"
              [title]="result.totalVersions ? 'No versions match the filters' : 'This package has no versions'" />
          } @else {
            <div class="dg-table-wrap">
              <table class="dg-table pc-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Released</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th class="col-actions"><span class="visually-hidden">Action</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of shown(); track row.version) {
                    <tr>
                      <td class="col-nowrap">
                        <span class="font-mono dg-cell-primary">{{ row.version }}</span>
                        @if (row.isDefault) {
                          <span class="dg-tag ms-1" title="The version a plain install picks">default</span>
                        }
                      </td>
                      <td class="col-nowrap dg-text-variant">{{ row.publishedAt ? (row.publishedAt | date: 'MMM d, y') : '—' }}</td>
                      <td class="col-nowrap">
                        <span class="dg-chip pc-type" [class.dg-chip-warning]="row.releaseType !== 'stable'">{{ releaseLabel(row.releaseType) }}</span>
                      </td>
                      <td class="col-nowrap">
                        <app-status-pill [value]="row.status" [label]="view(row).label" [tone]="view(row).tone" />
                      </td>
                      <td class="pc-reason">
                        <ng-container *ngTemplateOutlet="reasonDetail; context: { $implicit: row }" />
                        @if (!row.policyName && !row.reasons.length && !row.vulnerabilities?.length && !row.allowedAfter && !row.monitoring?.length) {
                          <span class="dg-text-muted">—</span>
                        }
                      </td>
                      <td class="col-actions col-nowrap">
                        @if (isUnblockable(row)) {
                          @if (canRequestWaiver) {
                            @if (row.waiverPending) {
                              <app-status-pill value="pending" label="Waiver pending" />
                            } @else {
                              <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="requestWaiver(row)">Request waiver</button>
                            }
                          } @else if (isSecurity) {
                            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addException(row)">Add exception</button>
                          }
                        } @else if (row.status === 'allowed') {
                          <button type="button" class="dg-icon-btn" (click)="copy(install(row.version))"
                            title="Copy install command" [attr.aria-label]="'Copy install command for ' + row.version">
                            <span class="material-symbols-outlined">content_copy</span>
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (result.hasMore) {
            <div class="pc-more">
              <button type="button" class="dg-btn dg-btn-secondary" [disabled]="checking" (click)="loadMore()">
                @if (loadingMore) {
                  <span class="dg-spinner is-sm" aria-hidden="true"></span>
                }
                Load more
              </button>
            </div>
          }
        </section>
      }
    </div>

    <ng-template #licenseLine let-license let-testId="testId">
      <div class="pc-license" [attr.data-testid]="testId">
        <span class="material-symbols-outlined" aria-hidden="true">gavel</span>
        <span class="pc-license-label">License</span>
        @if (license) {
          <span class="font-mono">{{ license }}</span>
        } @else {
          <span class="dg-text-muted">Not declared</span>
        }
      </div>
    </ng-template>

    <ng-template #reasonDetail let-row>
      @if (row.policyName) {
        <span class="dg-cell-primary">{{ row.policyName }}</span>
        @if (row.policyScope?.length) {
          <span class="dg-cell-sub" data-testid="policy-scope">Scoped to {{ row.policyScope!.join(', ') }}</span>
        }
      }
      @for (reason of row.reasons; track $index) {
        <span class="dg-cell-sub">{{ reason }}</span>
      }
      @if (row.vulnerabilities?.length) {
        <span class="pc-vulns">
          @for (vuln of row.vulnerabilities.slice(0, 4); track vuln.id) {
            <a class="dg-chip" [class.dg-chip-danger]="vuln.severity === 'CRITICAL' || vuln.severity === 'HIGH'"
              [href]="osv(vuln.id)" target="_blank" rel="noopener noreferrer" data-testid="pc-vuln"
              [title]="vuln.severity + ' · ' + cvssLabel(vuln) + ' · EPSS ' + epssLabel(vuln.epss) + (result?.epssDate ? ' (' + $safeNavigationMigration(result?.epssDate) + ')' : '') + ' · open in OSV'">
              {{ vuln.id }} <span class="pc-epss" data-testid="pc-vuln-epss">{{ cvssLabel(vuln) }} · EPSS {{ epssLabel(vuln.epss) }}</span>
            </a>
          }
          @if (row.vulnerabilities.length > 4) {
            <span class="dg-text-muted text-xs">+{{ row.vulnerabilities.length - 4 }} more</span>
          }
        </span>
      }
      @if (row.allowedAfter) {
        <span class="dg-cell-sub">Can be checked again after {{ formatRecheck(row.allowedAfter) }}</span>
      }
      @if (row.exception) {
        <span class="dg-cell-sub">Exception until {{ row.exception.expiresAt | date: 'MMM d, y' }}</span>
      }
      @for (match of row.monitoring ?? []; track match.policyId) {
        <span class="dg-cell-sub" data-testid="monitoring-reason">
          Would be blocked by "{{ match.policyName }}" (monitoring): {{ match.reasons.join('; ') }}
        </span>
      }
    </ng-template>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .pc-epss { font-weight: 400; opacity: 0.8; margin-left: 4px; }
      .pc-health { padding: 14px 16px; }
      .pc-health-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .pc-health-head .material-symbols-outlined { color: var(--brand); }
      .pc-health-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .pc-health-score { font-weight: 700; }
      .pc-health-details { margin-top: 8px; }
      .pc-health-details summary {
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--brand);
        cursor: pointer;
        user-select: none;
        width: fit-content;
      }
      .pc-health-details summary:hover { text-decoration: underline; }
      .pc-health-checks { margin: 8px 0 0; max-width: 420px; font-size: 0.8125rem; }
      .pc-health-checks th { font-weight: 500; }
      .pc-search {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 12px;
        padding: 16px;
      }
      .pc-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin: 0;
        min-width: 0;
        > span {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--color-muted);
        }
      }
      .pc-grow { flex: 1 1 260px; }
      .pc-version { flex: 0 1 160px; }
      .pc-check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        height: 36px;
        font-size: 0.8125rem;
        color: var(--color-on-surface);
        white-space: nowrap;
        .form-check-input { margin: 0; }
      }
      .pc-form-error {
        margin: -4px 16px 12px;
        font-size: 0.75rem;
        color: var(--danger-fg);
      }
      .pc-recent {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 0 16px 14px;
      }
      .pc-recent-label {
        font-size: 0.6875rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-muted);
        margin-right: 4px;
      }
      .pc-recent-chip {
        cursor: pointer;
        &:hover { border-color: var(--brand); color: var(--brand); }
      }
      .pc-panels {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
        gap: 16px;
        margin-top: 16px;
        align-items: start;
      }
      .pc-panel {
        border: 1px solid var(--color-border);
        background: var(--color-surface-container-low);
        border-radius: var(--radius-lg);
        padding: 12px 14px;
        min-width: 0;
        &.is-success { border-color: var(--success-border); background: var(--success-bg); }
        &.is-danger { border-color: var(--danger-border); background: var(--danger-bg); }
        &.is-warning { border-color: var(--warning-border); background: var(--warning-bg); }
      }
      .pc-panel-status { margin-top: 8px; }
      .pc-license {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        font-size: 0.8125rem;
        color: var(--color-on-surface);
        word-break: break-word;
        .material-symbols-outlined { font-size: 16px; color: var(--color-muted); }
      }
      .pc-license-label { font-weight: 600; color: var(--color-muted); }
      .pc-panel-reason {
        margin-top: 6px;
        .dg-cell-sub { white-space: normal; }
      }
      .pc-panel-actions { margin-top: 10px; }
      .pc-title-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pc-package {
        margin: 0;
        font-family: 'Manrope', sans-serif;
        font-size: 1.25rem;
        font-weight: 800;
        word-break: break-all;
        color: var(--color-on-surface);
      }
      .pc-meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px 16px;
        margin: 10px 0 0;
      }
      .pc-meta-when {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        .material-symbols-outlined { font-size: 18px; color: var(--brand); }
      }
      .pc-meta-when-label {
        display: block;
        font-size: 0.8125rem;
        font-weight: 600;
        line-height: 1.2;
        color: var(--color-on-surface);
      }
      .pc-meta-when time {
        display: block;
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        line-height: 1.3;
        color: var(--color-muted);
      }
      .pc-meta-facts {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 6px;
        min-width: 0;
      }
      .pc-meta-fact {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        max-width: 100%;
        padding: 3px 8px;
        border: 1px solid var(--color-border);
        border-radius: 999px;
        background: var(--color-surface-container-low);
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--color-muted);
        word-break: break-word;
      }
      .pc-meta-v {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        font-weight: 600;
        letter-spacing: 0;
        color: var(--color-on-surface);
      }
      .pc-recommended {
        border: 1px solid var(--success-border);
        background: var(--success-bg);
        border-radius: var(--radius-lg);
        padding: 12px 14px;
        min-width: 0;
        &.is-empty {
          border-color: var(--color-border);
          background: var(--color-surface-container-low);
        }
      }
      .pc-rec-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }
      .pc-rec-version {
        font-family: var(--font-mono);
        font-size: 1.125rem;
        font-weight: 700;
        color: var(--color-on-surface);
        word-break: break-all;
      }
      .pc-install {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin-top: 10px;
        .dg-code { flex: 1 1 auto; min-width: 0; padding: 8px 12px; }
      }
      .pc-none {
        margin: 0;
        font-size: 0.8125rem;
        line-height: 1.5;
        color: var(--color-on-surface-variant);
      }
      .pc-filter-search { flex: 0 1 220px; min-width: 160px; }
      .pc-type { white-space: nowrap; word-break: normal; }
      .pc-reason {
        min-width: 220px;
        max-width: 420px;
        .dg-cell-sub { white-space: normal; }
      }
      .pc-vulns {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
        a.dg-chip { text-decoration: none; font-family: var(--font-mono); font-size: 0.6875rem; }
        a.dg-chip:hover { text-decoration: underline; }
      }
      .pc-more {
        display: flex;
        justify-content: center;
        padding: 14px 16px;
        border-top: 1px solid var(--color-border);
      }
      @media (max-width: 767.98px) {
        .pc-field, .pc-version, .pc-grow { flex: 1 1 100%; }
        .pc-submit { width: 100%; justify-content: center; }
        .pc-filter-search { flex: 1 1 100%; max-width: none; }
        .pc-meta { align-items: flex-start; }
        .pc-meta-facts { justify-content: flex-start; }
      }
    `,
  ],
})
export class PackageCheckComponent implements OnInit {
  readonly healthTone = scoreTone;
  readonly epssLabel = epssLabel;
  readonly cvssLabel = cvssLabel;
  healthMessage(health: ProjectHealth): string {
    return projectHealthMessage(health);
  }
  ecosystems = ECOSYSTEMS;
  ecosystem = 'npm';
  packageName = '';
  repository = 'default';
  version = '';
  repositories: string[] = ['default'];

  checking = false;
  loadingMore = false;
  formError = '';
  error: ErrorState | null = null;
  result: PackageCheckResult | null = null;
  rows: CheckedVersion[] = [];
  recent: RecentCheck[] = readRecentChecks();

  allowedOnly = false;
  hidePrerelease = false;
  search = '';

  readonly isUnblockable = isUnblockable;

  private auth = inject(AuthService);
  private service = inject(PackageCheckService);
  private repositoryService = inject(RepositoryService);
  private toast = inject(ToastService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private lastRequest: PackageCheckRequest | null = null;

  get isSecurity(): boolean {
    return this.auth.isSecurity();
  }

  /** Waivers are requested by Users; Security adds exceptions instead. */
  get canRequestWaiver(): boolean {
    return this.auth.isUser();
  }

  ngOnInit(): void {
    this.loadRepositories();
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => this.fromParams(params));
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  display(ecosystem: string, name: string): string {
    return displayPackageName(ecosystem, name);
  }

  namePlaceholder(): string {
    return NAME_PLACEHOLDERS[this.ecosystem] ?? '';
  }

  releaseLabel = releaseTypeLabel;
  view = statusView;
  osv = osvUrl;

  install(version: string): string {
    return this.result ? installCommand(this.result.ecosystem, this.result.package, version) : '';
  }

  tone = panelTone;

  /** How far down the newest-first list the table goes, after any Load more. */
  windowEnd(): number {
    return this.result ? Math.min(this.result.offset + this.result.limit, this.result.totalVersions) : 0;
  }

  shown(): CheckedVersion[] {
    return visibleRows(
      this.rows,
      { allowedOnly: this.allowedOnly, hidePrerelease: this.hidePrerelease, search: this.search },
      this.windowEnd()
    );
  }

  requestedRows(): CheckedVersion[] {
    return this.rows.filter((row) => row.requested);
  }

  /** The recommended version's row, for its status and reasons (an exception, a monitoring policy). */
  recommendedRow(): CheckedVersion | null {
    const version = this.result?.recommended?.version;
    return version ? (this.rows.find((row) => row.version === version) ?? null) : null;
  }

  dataUnavailable(): boolean {
    return this.rows.some((row) => row.status === 'allowed' && row.incomplete?.includes('cve'));
  }

  formatRecheck(iso: string): string {
    return recheckAfterLabel(iso);
  }

  checkedLabel(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min ago` : 'earlier';
  }

  onEcosystemChange(): void {
    this.formError = '';
    this.loadRepositories();
  }

  submit(): void {
    this.formError = '';
    const name = this.packageName.trim();
    const version = this.version.trim();
    if (!name) {
      this.formError = 'Enter a package name.';
      return;
    }
    const versionError = versionInputError(version, this.ecosystem);
    if (versionError) {
      this.formError = versionError;
      return;
    }
    const queryParams = {
      ecosystem: this.ecosystem,
      package: name,
      version: version || null,
      repository: this.repository !== 'default' ? this.repository : null,
    };
    const current = this.route.snapshot.queryParamMap;
    const same =
      current.get('ecosystem') === queryParams.ecosystem &&
      current.get('package') === queryParams.package &&
      current.get('version') === queryParams.version &&
      current.get('repository') === queryParams.repository;
    if (same) {
      this.run();
      return;
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  checkRecent(item: RecentCheck): void {
    this.ecosystem = item.ecosystem;
    this.packageName = displayPackageName(item.ecosystem, item.package);
    this.repository = item.repository;
    this.version = '';
    this.loadRepositories();
    this.submit();
  }

  retry(): void {
    this.run();
  }

  loadMore(): void {
    if (!this.result || !this.lastRequest || this.checking) return;
    const offset = this.result.offset + this.result.limit;
    this.checking = true;
    this.loadingMore = true;
    this.service.check({ ...this.lastRequest, offset }).subscribe({
      next: (page) => {
        this.rows = mergeRows(this.rows, page.versions);
        const recommended = this.result?.recommended ?? page.recommended;
        this.result = { ...page, recommended, packageNotice: this.result?.packageNotice ?? page.packageNotice, missingVersions: this.result?.missingVersions ?? [] };
        this.checking = false;
        this.loadingMore = false;
      },
      error: (err: HttpErrorResponse) => {
        this.checking = false;
        this.loadingMore = false;
        this.toast.error(err.error?.error ?? 'Could not load more versions');
      },
    });
  }

  requestWaiver(row: CheckedVersion): void {
    if (!this.result) return;
    const ref = this.modal.open(RequestWaiverDialogComponent, {
      injector: Injector.create({
        providers: [
          {
            provide: MODAL_DATA,
            useValue: {
              ecosystems: [...ECOSYSTEMS],
              prefill: {
                ecosystem: this.result.ecosystem,
                packageName: this.result.package,
                version: row.version,
                repository: this.result.repository,
              },
            },
          },
        ],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((saved) => {
      if (!saved) return;
      row.waiverPending = true;
      this.toast.success('Request submitted for review');
    });
  }

  addException(row: CheckedVersion): void {
    if (!this.result) return;
    const ref = this.modal.open(AddExceptionDialogComponent, {
      injector: Injector.create({
        providers: [
          {
            provide: MODAL_DATA,
            useValue: {
              ecosystems: [...ECOSYSTEMS],
              prefill: { ecosystem: this.result.ecosystem, packageName: this.result.package, version: row.version },
            },
          },
        ],
        parent: this.injector,
      }),
    });
    ref.closed.subscribe((saved) => {
      if (!saved) return;
      this.toast.success('Exception added');
      this.run();
    });
  }

  copy(text: string): void {
    if (!text) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      this.toast.error('Copy is not available in this browser');
      return;
    }
    clipboard.writeText(text).then(
      () => this.toast.success('Copied to clipboard'),
      () => this.toast.error('Could not copy to the clipboard')
    );
  }

  private fromParams(params: ParamMap): void {
    const pkg = params.get('package')?.trim();
    if (!pkg) return;
    const ecosystem = params.get('ecosystem') ?? this.ecosystem;
    if (isPackageEcosystem(ecosystem)) {
      if (ecosystem !== this.ecosystem) {
        this.ecosystem = ecosystem;
        this.loadRepositories();
      }
    }
    this.packageName = pkg;
    this.version = params.get('version')?.trim() ?? '';
    this.repository = params.get('repository')?.trim() || 'default';
    if (!this.repositories.includes(this.repository)) this.repositories = [...this.repositories, this.repository];
    this.run();
  }

  private loadRepositories(): void {
    const ecosystem = this.ecosystem;
    this.repositoryService.list(ecosystem).subscribe({
      next: (rows) => {
        if (ecosystem !== this.ecosystem) return;
        const keys = rows
          .filter((row) => row.ecosystem === ecosystem && row.isEnabled)
          .map((row) => row.key)
          .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)));
        this.repositories = keys.length ? keys : ['default'];
        if (!this.repositories.includes(this.repository)) this.repository = 'default';
      },
      error: () => {
        this.repositories = ['default'];
      },
    });
  }

  private run(): void {
    const name = this.packageName.trim();
    if (!name) return;
    const request: PackageCheckRequest = {
      ecosystem: this.ecosystem,
      package: name,
      repository: this.repository,
      versions: this.version.trim() ? [this.version.trim()] : [],
      offset: 0,
      limit: 10,
      showDev: this.ecosystem === 'composer',
    };
    this.lastRequest = request;
    this.checking = true;
    this.loadingMore = false;
    this.formError = '';
    this.error = null;
    this.service.check(request).subscribe({
      next: (result) => {
        if (this.lastRequest !== request) return;
        this.result = result;
        this.rows = result.versions;
        this.checking = false;
        this.recent = rememberCheck({ ecosystem: result.ecosystem, package: result.package, repository: result.repository });
      },
      error: (err: HttpErrorResponse) => {
        if (this.lastRequest !== request) return;
        this.checking = false;
        this.result = null;
        this.rows = [];
        const message: string = err.error?.error ?? '';
        if (err.status === 400) {
          this.formError = message || 'Check the package name and version.';
        } else if (err.status === 404) {
          this.error = {
            kind: 'not_found',
            title: `No package named "${name}" in ${request.repository}.`,
            detail: 'Check the spelling or the ecosystem.',
          };
        } else if (err.status === 502) {
          this.error = {
            kind: 'upstream',
            title: `Couldn't reach ${err.error?.registry ?? 'the registry'}.`,
            detail: 'The registry did not answer and nothing was cached. Try again in a moment.',
          };
        } else if (err.status === 429) {
          this.toast.error(message || 'Too many checks. Wait a minute and try again.');
        } else {
          this.toast.error(message || 'Package check failed');
        }
      },
    });
  }
}
