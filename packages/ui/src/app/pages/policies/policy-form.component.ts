import { Component, DoCheck, ElementRef, HostListener, OnDestroy, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NgbTooltipModule } from '@ng-bootstrap/ng-bootstrap';
import { PolicyService, Policy, PolicyConditions, PolicyMode } from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';
import { LicenseService, OsiLicense } from '../../services/license.service';
import { BreadcrumbService } from '../../services/breadcrumb.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { ChipInputComponent, splitList } from '../../shared/chip-input.component';
import { VersionConstraintsComponent } from '../../shared/version-constraints.component';
import { ECOSYSTEMS, ecosystemLabel, statusLabel } from '../../shared/status';
import { RepositoryScopeComponent } from '../../shared/repository-scope.component';
import { missingIds } from '../../shared/repository-scope';
import { buildVersion, hasInvalidVersion, parseVersion } from '../waivers/waiver-version';
import { ApprovedPackagesComponent } from '../monitoring/approved-packages.component';
import { NO_REMOTE_TICKED, NamespaceRuleComponent } from './namespace-rule.component';
import { RuleSuggestion, licenseIds, raisedCvss, suggestionText } from '../monitoring/monitoring';
import { PackageRepositoryRow, RepositoryService } from '../../services/repository.service';
import {
  POLICY_RULES,
  PolicyDecision,
  PolicyRule,
  RULE_DECISIONS,
  RELEASE_TYPES,
  RELEASE_TYPE_RULES,
  ReleaseTypeId,
  ReleaseTypeInfo,
  SCORECARD_CHECKS,
  PolicyRuleInfo,
  appliesToLabel,
  cvssScoreOf,
  cvssScoreText,
  cvssText,
  epssText,
  formatScore,
  releaseTypeApplies,
  releaseTypeExamples,
  repositoryIsPublic,
  ruleDetail,
  ruleInfo,
  rulesOf,
  scorecardCheckDescription,
  scorecardDetail,
  stableExamples,
} from './policy-rules';

export interface VersionConstraint {
  kind: 'exact' | 'range';
  version: string;
  from: string;
  to: string;
}

/** What the summary panel shows for the chosen rule. */
export interface PolicySummary {
  /** Above the matches, e.g. "Versions with:". */
  lead: string;
  /** What the rule matches; any one is enough. */
  items: string[];
  /** Settings for edge cases, e.g. "Vulnerabilities without CVSS: ignored". */
  notes: Array<{ label: string; value: string }>;
  /** A warning that belongs with the summary, e.g. that every reserved name will be blocked. */
  text?: string;
}

/** Where "Next:" points for a Project health check that needs fixing: the folded Advanced section. */
const ADVANCED_CHECKS = '[data-testid="scorecard-advanced"]';
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea, button:not([disabled]), summary';

/** Longest name the form suggests; the column holds 256. */
const SUGGESTED_NAME_MAX = 80;

const RELEASE_TYPE_WORDS: Record<ReleaseTypeId, string> = {
  prerelease: 'pre-release',
  dev: 'dev',
  snapshot: 'snapshot',
  pseudo: 'pseudo',
};

/**
 * Policies → New policy (`/policies/new`) and Edit policy (`/policies/:id/edit`): the form on the left and,
 * always in view, the summary sentence and Create/Update on the right. `?mode=monitor` starts a new policy in
 * monitor mode, `?suggest=<reasonKey>` applies an "Edit rule" suggestion from Monitoring, and `?returnUrl=`
 * is where Cancel and Save go back to (Policies by default).
 */
@Component({
  selector: 'app-policy-form',
  standalone: true,
  imports: [
    CommonModule, FormsModule, NgbTooltipModule, VersionConstraintsComponent, ApprovedPackagesComponent, RepositoryScopeComponent,
    NamespaceRuleComponent, EmptyStateComponent, ChipInputComponent,
  ],
  template: `
    <div class="dg-page pf-page">
      <a class="pf-back" href="#" (click)="cancel(); $event.preventDefault()" data-testid="policy-back">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>{{ returnLabel }}
      </a>
      <header class="dg-page-header">
        <div class="min-w-0">
          <h1 class="dg-page-title">{{ editing ? 'Edit policy' : 'New policy' }}</h1>
          <p class="dg-page-subtitle">Block or allow package versions that match a rule.</p>
        </div>
      </header>

      @if (loadError) {
        <section class="dg-card">
          <app-empty-state icon="search_off" title="Policy not found" [description]="loadError">
            <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()">Back to {{ returnLabel }}</button>
          </app-empty-state>
        </section>
      } @else if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="pf-layout">
          <section class="dg-card pf-main" aria-label="Policy">
            @if (suggestionNote) {
              <div class="dg-callout mb-3" data-testid="policy-suggestion">
                <span class="material-symbols-outlined" aria-hidden="true">tips_and_updates</span>
                <div><strong>Suggested change:</strong> {{ suggestionNote }}. Save to recheck recorded downloads.</div>
              </div>
            }
            @if (legacyRules.length > 1) {
              <div class="dg-callout is-warning mb-3" data-testid="policy-legacy-rules">
                <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                <div>This policy has several rules ({{ legacyRuleNames }}). Saving keeps only the selected one; create a policy for each of the others.</div>
              </div>
            }
            <div class="dg-field">
              <label class="form-label" for="policy-name">Name</label>
              <input id="policy-name" class="form-control" [(ngModel)]="name" required autocomplete="off" />
            </div>
            <div class="dg-field">
              <label class="form-label" for="policy-description">Description <span class="dg-optional">(optional)</span></label>
              <textarea id="policy-description" class="form-control" rows="2" [(ngModel)]="description"></textarea>
            </div>
            <div class="dg-field-row" style="grid-template-columns: repeat(2, minmax(0, 1fr))">
              <div>
                <label class="form-label" for="policy-priority">Priority</label>
                <input id="policy-priority" type="number" class="form-control" [(ngModel)]="priority" />
                <span class="dg-form-help">Lower numbers run first.</span>
              </div>
              <div>
                <label class="form-label" for="policy-ecosystem">Ecosystem</label>
                <select id="policy-ecosystem" class="form-select" [(ngModel)]="ecosystem">
                  <option value="">All</option>
                  @for (e of ecosystems; track e) {
                    <option [value]="e">{{ ecoLabel(e) }}</option>
                  }
                </select>
              </div>
            </div>

            <app-repository-scope idPrefix="policy" [ecosystems]="ecosystem ? [ecosystem] : []" [selectedIds]="repositoryIds"
              [missingCount]="missingRepositoryCount" (selectedIdsChange)="repositoryIds = $event"
              (modeChange)="scopeMode = $event" (labelsChange)="scopeLabels = $event" />

            <fieldset class="dg-field">
              <legend class="form-label">Rule</legend>
              @if (rule && !ruleGridOpen) {
                <div class="rule-option is-selected rule-chosen" data-testid="policy-rule-chosen">
                  <span class="material-symbols-outlined rule-icon" aria-hidden="true">{{ chosenRule.icon }}</span>
                  <span class="rule-text">
                    <span class="rule-label">{{ chosenRule.label }}</span>
                    <span class="rule-desc">{{ chosenRule.description }}</span>
                  </span>
                  <button type="button" class="pf-link" (click)="ruleGridOpen = true" aria-label="Change rule" data-testid="policy-rule-change">Change</button>
                </div>
              } @else {
                <div class="rule-grid" role="radiogroup" aria-label="Rule">
                  @for (r of rules; track r.id) {
                    <label class="rule-option" [class.is-selected]="rule === r.id" [attr.data-testid]="'policy-rule-' + r.id"
                      (click)="closeRuleGridOn(r.id)">
                      <input type="radio" name="policy-rule" class="visually-hidden" [value]="r.id" [ngModel]="rule" (ngModelChange)="selectRule($event)" />
                      <span class="material-symbols-outlined rule-icon" aria-hidden="true">{{ r.icon }}</span>
                      <span class="rule-text">
                        <span class="rule-label">{{ r.label }}</span>
                        <span class="rule-desc">{{ r.description }}</span>
                      </span>
                    </label>
                  }
                </div>
              }
            </fieldset>

            @if (rule) {
              <div class="policy-section" data-testid="policy-rule-body">
                <div class="policy-section-body">
                  @if (rule === 'packages') {
                    <div class="dg-field" data-testid="policy-action">
                      <label class="form-label" for="policy-decision">Action</label>
                      <select id="policy-decision" class="form-select form-select-sm action-select" [(ngModel)]="decision" data-testid="policy-decision">
                        @for (d of decisionOptions; track d) {
                          <option [value]="d">{{ decisionLabel(d) }}</option>
                        }
                      </select>
                    </div>
                  } @else if (!decisionAllowed) {
                    <div class="dg-callout is-danger mb-3" data-testid="policy-decision-invalid">
                      <span class="material-symbols-outlined" aria-hidden="true">error</span>
                      <div>
                        This policy allows versions, but Allow is only for the Packages rule.
                        <button type="button" class="pf-link" (click)="decision = 'BLOCK'">Change to Block</button>
                      </div>
                    </div>
                  }
                  @if (decision === 'ALLOW' && decisionAllowed) {
                    <div class="dg-callout is-warning mb-3" data-testid="policy-allow-warning">
                      <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                      <div>Allowed versions skip every lower-priority policy, including vulnerability checks. Use it for packages you trust.</div>
                    </div>
                  }
                  @if (decision === 'BLOCK') {
                    <fieldset class="mb-3" data-testid="policy-mode">
                      <legend class="form-label mb-1">Enforcement</legend>
                      <div class="mode-options" role="radiogroup" aria-label="Enforcement">
                        <label class="rt-option" [class.is-off]="mode !== 'enforce'" data-testid="policy-mode-enforce">
                          <input type="radio" name="policy-mode" class="form-check-input" value="enforce" [ngModel]="mode" (ngModelChange)="setMode($event)" />
                          <span class="rt-body">
                            <span class="rt-label">Enforce</span>
                            <span class="rt-desc">Matching versions are blocked.</span>
                          </span>
                        </label>
                        <label class="rt-option" [class.is-off]="mode !== 'monitor'" data-testid="policy-mode-monitor">
                          <input type="radio" name="policy-mode" class="form-check-input" value="monitor" [ngModel]="mode" (ngModelChange)="setMode($event)" />
                          <span class="rt-body">
                            <span class="rt-label">Monitor only (log, don't block)</span>
                            <span class="rt-desc">Records what it would block on the Monitoring page. Enforce it after review.</span>
                          </span>
                        </label>
                      </div>
                      @if (autoMonitorNote && mode === 'monitor') {
                        <span class="dg-form-help d-block mt-1" data-testid="policy-mode-auto">Switched to Monitor only — recommended for this rule.</span>
                      } @else if (recommendMonitor) {
                        <span class="dg-form-help d-block mt-1" data-testid="policy-mode-hint">
                          @if (rule === 'namespace') {
                            Monitor first to see which downloads would be blocked.
                          } @else {
                            This rule covers every package in {{ ecosystem ? ecoLabel(ecosystem) : 'every ecosystem' }}. Monitor first to see what it would break.
                          }
                        </span>
                      }
                    </fieldset>
                  }
                  @switch (rule) {
                    @case ('packages') {
                      <div class="dg-field">
                        <label class="form-label" for="policy-packages">Package names</label>
                        <app-chip-input inputId="policy-packages" testId="policy-packages" placeholder="e.g. left-pad, *-malware (* = any)"
                          [values]="packageNames" (valuesChange)="packageNames = $event" (draftChange)="packageDraft = $event" />
                      </div>
                      <label class="form-label">Versions <span class="dg-optional">(optional)</span></label>
                      <app-version-constraints [constraints]="versionConstraints" idPrefix="policy" [ecosystem]="ecosystem" />
                      @if (hasIncompleteRange) {
                        <span class="dg-form-help text-danger">Each range needs both a start and an end version.</span>
                      }
                    }
                    @case ('releaseType') {
                      <fieldset>
                        <div class="d-flex align-items-center justify-content-between mb-2">
                          <legend class="form-label mb-0">Release types to match</legend>
                          <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="selectAllReleaseTypes()" data-testid="release-type-all">
                            Select all
                          </button>
                        </div>
                        <div class="rt-list">
                          @for (t of releaseTypes; track t.id) {
                            <label class="rt-option" [class.is-disabled]="!applies(t)" [attr.data-testid]="'release-type-' + t.id">
                              <input type="checkbox" class="form-check-input" [checked]="isReleaseTypeSelected(t.id)"
                                [disabled]="!applies(t)" (change)="toggleReleaseType(t.id)" [attr.aria-describedby]="'rt-desc-' + t.id" />
                              <span class="rt-body">
                                <span class="rt-head">
                                  <span class="rt-label">{{ t.label }}</span>
                                  <span class="dg-chip">{{ applies(t) ? appliesTo(t) : 'Not in ' + ecoLabel(ecosystem) }}</span>
                                </span>
                                <span class="rt-desc" [id]="'rt-desc-' + t.id">{{ t.description }}</span>
                                @if (applies(t)) {
                                  <span class="rt-tags">
                                    <span class="rt-eg">e.g.</span>
                                    @for (v of examples(t); track v) { <span class="dg-tag">{{ v }}</span> }
                                  </span>
                                }
                              </span>
                            </label>
                          }
                        </div>
                      </fieldset>
                      <div class="rt-tags mt-2">
                        <span class="rt-eg">Not affected (stable):</span>
                        @for (v of stableExampleList; track v) { <span class="dg-tag">{{ v }}</span> }
                      </div>
                      <details class="rt-details mt-2">
                        <summary>How {{ ecosystem ? ecoLabel(ecosystem) : 'each ecosystem' }} decides the release type</summary>
                        <table class="rt-table">
                          <tbody>
                            @for (row of releaseTypeRules; track row.ecosystem) {
                              <tr><th scope="row">{{ ecoLabel(row.ecosystem) }}</th><td>{{ row.rule }}</td></tr>
                            }
                          </tbody>
                        </table>
                      </details>
                    }
                    @case ('releaseAge') {
                      <p class="dg-form-help mt-0 mb-2">Matches if either applies.</p>
                      <div class="rt-list">
                        <div class="rt-option age-option" [class.is-off]="!tooNewEnabled" data-testid="release-age-too-new">
                          <input id="policy-age-new" type="checkbox" class="form-check-input" [ngModel]="tooNewEnabled" (ngModelChange)="setTooNew($event)" />
                          <label class="age-text" for="policy-age-new">Published less than</label>
                          <input type="number" min="1" class="form-control form-control-sm age-number" [(ngModel)]="tooNewHoursStr"
                            [disabled]="!tooNewEnabled" placeholder="72" aria-label="Too new within hours" />
                          <span class="age-text">hours ago</span>
                          <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="Why block new versions"
                            ngbTooltip="Gives the community time to spot a bad release.">info</span>
                        </div>
                        <div class="rt-option age-option" [class.is-off]="!unmaintainedEnabled" data-testid="release-age-unmaintained">
                          <input id="policy-age-old" type="checkbox" class="form-check-input" [ngModel]="unmaintainedEnabled" (ngModelChange)="setUnmaintained($event)" />
                          <label class="age-text" for="policy-age-old">No release in</label>
                          <input type="number" min="1" class="form-control form-control-sm age-number" [(ngModel)]="unmaintainedDaysStr"
                            [disabled]="!unmaintainedEnabled" placeholder="365" aria-label="Unmaintained after days" />
                          <span class="age-text">days</span>
                        </div>
                      </div>
                      @if (releaseAgeIncomplete) {
                        <span class="dg-form-help text-danger">Enter a number above zero for each selected option.</span>
                      }
                    }
                    @case ('vulnerability') {
                      <p class="dg-form-help mt-0 mb-2">Set at least one.</p>
                      <div class="dg-field">
                        <label class="form-label" for="policy-cvss">
                          CVSS score at least
                          <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="How the CVSS score is chosen"
                            ngbTooltip="The score comes from the advisory's CVSS 4.0 vector, else 3.1, else 3.0. Without a vector, the advisory's severity counts as the lowest score of its rating.">info</span>
                        </label>
                        <span class="age-input mt-0">
                          <input id="policy-cvss" type="number" min="0.1" max="10" step="0.1" class="form-control form-control-sm"
                            [(ngModel)]="cvssMinStr" placeholder="7.0" data-testid="cvss-min" />
                          <span>out of 10</span>
                        </span>
                        @if (cvssMinInvalid) {
                          <span class="dg-form-help text-danger">Enter a score from 0.1 to 10, with at most one decimal.</span>
                        }
                        <span class="dg-form-help">High = 7.0 · Critical = 9.0</span>
                        @if (cvssMin !== null) {
                          <div class="unknown-row" role="radiogroup" aria-label="When a vulnerability has no CVSS score" data-testid="cvss-unknown">
                            <span class="unknown-label">When a vulnerability has no CVSS score:</span>
                            <label class="epss-mode"><input type="radio" name="cvss-unknown" class="form-check-input" value="ignore" [(ngModel)]="cvssUnknown" data-testid="cvss-unknown-ignore" /> Ignore it <span class="dg-optional">(recommended)</span></label>
                            <label class="epss-mode"><input type="radio" name="cvss-unknown" class="form-check-input" value="match" [(ngModel)]="cvssUnknown" data-testid="cvss-unknown-match" /> {{ blockLabel }} the version</label>
                            <span class="unknown-note">Most Go advisories are unrated.</span>
                          </div>
                        }
                      </div>
                      <div class="rt-option mb-3" [class.is-off]="!epssEnabled" data-testid="epss-section">
                        <input id="policy-epss" type="checkbox" class="form-check-input" [ngModel]="epssEnabled" (ngModelChange)="toggleEpss($event)" />
                        <div class="rt-body">
                          <label class="rt-label" for="policy-epss">Exploit likelihood (EPSS)</label>
                          <span class="rt-desc">
                            Chance a CVE is exploited in the next 30 days (<a href="https://www.first.org/epss/" target="_blank" rel="noopener">FIRST</a>).
                            With CVSS, both must match.
                            <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="EPSS changes daily"
                              ngbTooltip="It changes daily, so a version can be blocked one day and served the next.">info</span>
                          </span>
                          @if (epssEnabled) {
                            <div class="epss-modes" role="radiogroup" aria-label="EPSS threshold">
                              <label class="epss-mode" data-testid="epss-mode-score">
                                <input type="radio" name="epss-mode" class="form-check-input" value="score" [(ngModel)]="epssMode" />
                                EPSS score at least
                                <input type="number" min="0.01" max="100" step="0.1" class="form-control form-control-sm" [(ngModel)]="epssScoreStr"
                                  [disabled]="epssMode !== 'score'" aria-label="EPSS score percent" data-testid="epss-score" /> %
                              </label>
                              <label class="epss-mode" data-testid="epss-mode-percentile">
                                <input type="radio" name="epss-mode" class="form-check-input" value="percentile" [(ngModel)]="epssMode" />
                                EPSS percentile at least
                                <input type="number" min="1" max="100" step="1" class="form-control form-control-sm" [(ngModel)]="epssPercentileStr"
                                  [disabled]="epssMode !== 'percentile'" aria-label="EPSS percentile" data-testid="epss-percentile" /> th
                              </label>
                            </div>
                            <div class="unknown-row" role="radiogroup" aria-label="When a vulnerability has no EPSS score" data-testid="epss-unknown">
                              <span class="unknown-label">When a vulnerability has no EPSS score:</span>
                              <label class="epss-mode"><input type="radio" name="epss-unknown" class="form-check-input" value="ignore" [(ngModel)]="epssUnknown" data-testid="epss-unknown-ignore" /> Ignore it</label>
                              <label class="epss-mode"><input type="radio" name="epss-unknown" class="form-check-input" value="match" [(ngModel)]="epssUnknown" data-testid="epss-unknown-match" /> {{ blockLabel }} the version <span class="dg-optional">(recommended)</span></label>
                              <span class="unknown-note">New CVEs get a score after a day or so.</span>
                            </div>
                          }
                        </div>
                      </div>
                      <div class="dg-field mb-0">
                        <label class="form-label" for="policy-cves">CVE IDs</label>
                        <app-chip-input inputId="policy-cves" testId="policy-cves" placeholder="e.g. CVE-2024-1234"
                          [values]="cveIds" (valuesChange)="cveIds = $event" (draftChange)="cveDraft = $event" [errorOf]="cveError" />
                      </div>
                    }
                    @case ('license') {
                      <div class="rt-list mb-3" role="radiogroup" aria-label="Which licenses get the action">
                        <label class="rt-option" [class.is-off]="licenseMode !== 'allow'" data-testid="license-mode-allow">
                          <input type="radio" name="license-mode" class="form-check-input" value="allow" [(ngModel)]="licenseMode" />
                          <span class="rt-body">
                            <span class="rt-label">Block every license except the approved ones</span>
                            <span class="rt-desc">List approved licenses. All others get this action, including packages with no license.</span>
                          </span>
                        </label>
                        <label class="rt-option" [class.is-off]="licenseMode !== 'deny'" data-testid="license-mode-deny">
                          <input type="radio" name="license-mode" class="form-check-input" value="deny" [(ngModel)]="licenseMode" />
                          <span class="rt-body">
                            <span class="rt-label">Block only the listed licenses</span>
                            <span class="rt-desc">List banned licenses. All others are allowed.</span>
                          </span>
                        </label>
                      </div>
                      <label class="form-label" for="policy-license-search">{{ licenseMode === 'allow' ? 'Approved licenses' : 'Banned licenses' }}</label>
                      <div class="license-chips-container dg-subsection">
                        @for (spdxId of selectedLicenses; track spdxId) {
                          <span class="dg-chip gap-1">
                            {{ getLicenseDisplayName(spdxId) }}
                            <button type="button" class="license-remove" [attr.aria-label]="'Remove ' + spdxId" (click)="removeLicense(spdxId)">
                              <span class="material-symbols-outlined">close</span>
                            </button>
                          </span>
                        }
                        <div class="position-relative d-inline-block">
                          <input
                            id="policy-license-search"
                            type="text"
                            class="form-control form-control-sm"
                            style="width: 220px"
                            [(ngModel)]="licenseSearchQuery"
                            (ngModelChange)="onLicenseSearch($event)"
                            (focus)="showLicenseDropdown = true; onLicenseSearch(licenseSearchQuery)"
                            (blur)="onLicenseBlur()"
                            (keydown.enter)="addTypedLicense(); $event.preventDefault()"
                            placeholder="Search or type a license ID…"
                            autocomplete="off"
                          />
                          @if (showLicenseDropdown) {
                            <ul class="list-group position-absolute top-100 start-0 mt-1 license-dropdown">
                              @for (lic of filteredLicenses(); track lic.spdxId) {
                                @if (!selectedLicenses.includes(lic.spdxId)) {
                                  <li class="list-group-item list-group-item-action py-2" (mousedown)="addLicense(lic); $event.preventDefault()">
                                    <span class="fw-semibold">{{ lic.spdxId }}</span>
                                    <small class="text-muted d-block">{{ lic.name }}</small>
                                  </li>
                                }
                              }
                              @if (customLicense(); as typed) {
                                <li class="list-group-item list-group-item-action py-2" (mousedown)="addTypedLicense(); $event.preventDefault()">
                                  <span class="fw-semibold">Add "{{ typed }}"</span>
                                  <small class="text-muted d-block">For licenses not on the OSI list, e.g. SSPL-1.0, BUSL-1.1, or a pattern such as BSD-*</small>
                                </li>
                              }
                            </ul>
                          }
                        </div>
                      </div>
                      <span class="dg-form-help">With OR, one approved license is enough (MIT OR GPL-3.0 needs only MIT). With AND, every license must be approved.</span>
                      @if (licenseMode === 'allow') {
                        <div class="form-check mt-3">
                          <input id="policy-license-unknown" type="checkbox" class="form-check-input" [(ngModel)]="allowUnknownLicense" />
                          <label class="form-check-label" for="policy-license-unknown">Allow packages with no license info</label>
                          <span class="dg-form-help d-block">When off, a package with no declared license is not approved.</span>
                        </div>
                      }
                    }
                    @case ('namespace') {
                      @if (!ecosystem) {
                        <span class="dg-form-help text-danger d-block mb-2" data-testid="ns-ecosystem-required">Select an ecosystem above.</span>
                      }
                      <app-namespace-rule [ecosystem]="ecosystem" [reserved]="reservedNamespaces" [publicPackages]="publicPackages"
                        [mode]="monitoring ? 'monitor' : 'enforce'" [repositoryIds]="repositoryIds" [allowedRemotes]="allowedRemotes"
                        (allowedRemotesChange)="allowedRemotes = $event"
                        (reservedChange)="reservedNamespaces = $event" (publicPackagesChange)="publicPackages = $event"
                        (errorsChange)="namespaceErrors = $event" (internalRemotesChange)="namespaceInternalKeys = $event" />
                    }
                    @case ('scorecard') {
                      <div class="dg-callout mb-3" data-testid="scorecard-info">
                        <span class="material-symbols-outlined" aria-hidden="true">info</span>
                        <div>
                          Rates project hygiene, not malware. GitHub/GitLab sources only; skipped for repositories behind internal remotes.
                          <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="Which repository is scored"
                            ngbTooltip="The repository is the one the package declares, so a package can claim a well-known project.">help</span>
                        </div>
                      </div>
                      @if (scorecardScopeWarning) {
                        <div class="dg-callout is-warning mb-3" data-testid="scorecard-scope-warning">
                          <span class="material-symbols-outlined" aria-hidden="true">warning</span>
                          <div>{{ scorecardScopeWarning }}</div>
                        </div>
                      }
                      <div class="dg-field" data-testid="scorecard-overall">
                        <label class="form-label" for="policy-scorecard-min">Overall score at least</label>
                        <span class="sc-score">
                          <input id="policy-scorecard-min" type="number" min="0" max="10" step="0.1" class="form-control form-control-sm"
                            [(ngModel)]="scorecardMinScoreStr" placeholder="5.0" data-testid="scorecard-min" />
                          <span>out of 10</span>
                        </span>
                        <span class="dg-form-help">Leave empty to use only individual checks.</span>
                      </div>
                      <details class="rt-details mb-0" [open]="scorecardAdvancedOpen" (toggle)="scorecardAdvancedOpen = $any($event.target).open" data-testid="scorecard-advanced">
                        <summary>Advanced: checks and edge cases{{ scorecardChecks.length ? ' (' + scorecardChecks.length + ')' : '' }}</summary>
                        <div class="sc-edges">
                          <div class="sc-edge" data-testid="scorecard-unknown">
                            <label for="scorecard-unknown">When a package has no Scorecard result</label>
                            <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="When a package has no Scorecard result"
                              ngbTooltip="The package names no repository, its repository is outside GitHub and GitLab, or Scorecard has not scanned it. Blocking these blocks a large part of every ecosystem.">info</span>
                            <select id="scorecard-unknown" class="form-select form-select-sm" [(ngModel)]="scorecardUnknown" data-testid="scorecard-unknown-select">
                              <option value="allow">Allow</option>
                              <option value="block">Block</option>
                            </select>
                          </div>
                          <div class="sc-edge" data-testid="scorecard-unavailable">
                            <label for="scorecard-unavailable">Scorecard unreachable</label>
                            <span class="material-symbols-outlined pf-info" tabindex="0" role="img" aria-label="When Scorecard can't be reached"
                              ngbTooltip="Allow: packages are served, and Package check shows the result as incomplete. Block: packages are blocked until Scorecard can be reached again.">info</span>
                            <select id="scorecard-unavailable" class="form-select form-select-sm" [(ngModel)]="scorecardUnavailable" data-testid="scorecard-unavailable-select">
                              <option value="allow">Allow</option>
                              <option value="block">Block</option>
                            </select>
                          </div>
                        </div>
                        @if (scorecardUnavailable === 'block') {
                          <span class="dg-form-help text-danger d-block mb-2" data-testid="scorecard-unavailable-warning">
                            If the Scorecard service is down, every package this policy covers is blocked until it is back.
                          </span>
                        }
                        <p class="dg-form-help mt-2 mb-2">
                          Any failing check blocks. Good floors: Dangerous-Workflow, Maintained, Binary-Artifacts. Avoid Fuzzing and CII-Best-Practices (most projects score 0).
                        </p>
                        @for (row of scorecardChecks; track $index; let i = $index) {
                          <div class="sc-check" [attr.data-testid]="'scorecard-check-' + i">
                            <select class="form-select form-select-sm" [(ngModel)]="row.name" [attr.aria-label]="'Check ' + (i + 1)">
                              @for (c of scorecardCheckOptions; track c.name) { <option [value]="c.name">{{ c.name }}</option> }
                            </select>
                            <span>at least</span>
                            <input type="number" min="0" max="10" step="1" class="form-control form-control-sm" [(ngModel)]="row.minStr" [attr.aria-label]="'Minimum for ' + row.name" />
                            <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="removeScorecardCheck(i)" [attr.aria-label]="'Remove ' + row.name">
                              <span class="material-symbols-outlined">close</span>
                            </button>
                            <span class="rt-desc sc-check-desc">{{ checkDescription(row.name) }}</span>
                          </div>
                        }
                        <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addScorecardCheck()" data-testid="scorecard-add-check">Add check</button>
                      </details>
                    }
                  }
                </div>
              </div>
            }

            @if (editing && id && decision === 'BLOCK') {
              <div class="mt-4">
                <app-approved-packages [policyId]="id" />
              </div>
            }
          </section>

          <aside class="pf-aside" aria-label="Summary">
            <div class="dg-card pf-summary" data-testid="policy-summary-panel">
              <p class="dg-section-label mb-0">Summary</p>
              @if (hasSummary) {
                <div class="dg-banner" [ngClass]="bannerClass" data-testid="policy-summary-banner">
                  <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ bannerIcon }}</span>
                  <div class="min-w-0">
                    <div class="dg-banner-name" data-testid="policy-summary-title">{{ summaryTitle }}</div>
                    <div class="pf-summary-body" data-testid="policy-summary">
                      @if (summary.items.length) {
                        <p class="pf-summary-lead">{{ summary.lead }}</p>
                        <ul class="pf-summary-items">
                          @for (item of summary.items; track $index; let first = $first) {
                            <li>@if (!first) {<span class="pf-or">or </span>}{{ item }}</li>
                          }
                        </ul>
                      }
                      @if (summary.notes.length) {
                        <dl class="pf-summary-notes">
                          @for (note of summary.notes; track note.label) {
                            <div><dt>{{ note.label }}: </dt><dd>{{ note.value }}</dd></div>
                          }
                        </dl>
                      }
                      @if (summary.text) { <p class="pf-summary-warning" data-testid="policy-summary-warning">{{ summary.text }}</p> }
                    </div>
                  </div>
                </div>
              }
              <div class="dg-detail-list pf-facts">
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Rule</div>
                  <div class="dg-detail-value"><span class="dg-detail-text" data-testid="policy-review-rule">{{ rule ? chosenRule.label : 'Not chosen' }}</span></div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Ecosystem</div>
                  <div class="dg-detail-value"><span class="dg-chip">{{ ecosystemSummary }}</span></div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Applies to</div>
                  <div class="dg-detail-value" data-testid="policy-review-scope">
                    @if (repositoryIds.length) {
                      @for (label of scopeLabels; track label) { <span class="dg-chip dg-chip-accent">{{ label }}</span> }
                    } @else {
                      <span class="dg-chip">All repositories</span>
                    }
                  </div>
                </div>
                <div class="dg-detail-row pf-enabled-row">
                  <div class="dg-detail-label"><label for="policyEnabled">Enabled</label></div>
                  <div class="dg-detail-value">
                    <button id="policyEnabled" type="button" class="dg-switch" role="switch" [class.is-on]="isEnabled" [attr.aria-checked]="isEnabled"
                      (click)="isEnabled = !isEnabled" data-testid="policy-enabled"></button>
                  </div>
                </div>
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Priority</div>
                  <div class="dg-detail-value"><span class="dg-detail-text">{{ priority }}</span></div>
                </div>
              </div>
              @if (saveBlocker(); as blocker) {
                <div class="pf-next" role="status">
                  <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                  <span><span class="pf-next-label">Next: </span><button type="button" class="pf-next-link" (click)="goToBlocker()"
                    data-testid="policy-save-blocker">{{ blocker }}</button></span>
                </div>
              }
              <div class="pf-actions">
                <button type="button" class="dg-btn dg-btn-secondary" (click)="cancel()" data-testid="policy-cancel">Cancel</button>
                <!-- A disabled button gets no hover, so the tooltip sits on a wrapper. -->
                <span class="pf-save-wrap" [ngbTooltip]="saving ? '' : saveBlocker()" placement="top">
                  <button type="button" class="dg-btn dg-btn-primary" data-testid="policy-save" (click)="save()" [disabled]="!canSave() || saving">
                    {{ saving ? 'Saving…' : editing ? 'Update policy' : 'Create policy' }}
                  </button>
                </span>
              </div>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .pf-back {
      display: inline-flex; align-items: center; gap: 4px; margin-bottom: -8px; font-size: 0.8125rem; font-weight: 600;
      color: var(--color-on-surface-variant); text-decoration: none; align-self: flex-start;
    }
    .pf-back .material-symbols-outlined { font-size: 18px; }
    .pf-back:hover { color: var(--brand-text); }
    .pf-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
    .pf-main { padding: 20px 24px; min-width: 0; }
    /* Below the app header (h-16, sticky). */
    .pf-aside { position: sticky; top: 80px; min-width: 0; }
    .pf-summary { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .pf-summary .dg-banner { margin: 0; align-items: flex-start; }
    .pf-summary-body { margin-top: 4px; font-size: 0.8125rem; line-height: 1.45; color: var(--color-on-surface-variant); }
    .pf-summary-warning { margin: 6px 0 0; font-weight: 500; color: var(--danger-fg); }
    .pf-summary-lead { margin: 0; color: var(--color-on-surface); }
    .pf-summary-items { margin: 2px 0 0; padding-left: 18px; list-style: disc; color: var(--color-on-surface); overflow-wrap: anywhere; }
    .pf-or { color: var(--color-muted); }
    .pf-summary-notes { margin: 6px 0 0; }
    .pf-summary-notes > div { display: flex; flex-wrap: wrap; gap: 4px; }
    .pf-summary-notes dt { font-weight: 500; }
    .pf-summary-notes dd { margin: 0; color: var(--color-on-surface); }
    .pf-facts { margin: 0; }
    .pf-enabled-row label { margin: 0; cursor: pointer; }
    .pf-next {
      display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--info-border); border-radius: var(--radius);
      background: var(--info-bg); font-size: 0.8125rem; line-height: 1.4; color: var(--color-on-surface);
    }
    .pf-next > .material-symbols-outlined { font-size: 16px; margin-top: 1px; color: var(--info-fg); }
    .pf-next-label { font-weight: 600; }
    .pf-next-link {
      padding: 0; border: 0; background: none; font: inherit; text-align: left; color: var(--brand-text);
      text-decoration: underline; text-underline-offset: 2px; cursor: pointer;
    }
    .pf-next-link:hover { text-decoration-thickness: 2px; }
    .pf-save-wrap { display: inline-flex; }
    .pf-save-wrap .dg-btn:disabled { pointer-events: none; }
    .pf-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .pf-link { padding: 0; border: 0; background: none; color: var(--brand-text); font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
    .pf-link:hover { text-decoration: underline; }
    .pf-info { font-size: 16px; vertical-align: -3px; color: var(--color-muted); cursor: help; }
    .pf-info:hover, .pf-info:focus-visible { color: var(--brand-text); outline: none; }
    @media (max-width: 991.98px) {
      .pf-layout { grid-template-columns: minmax(0, 1fr); }
      .pf-main { padding: 16px; }
      /* On narrow screens the summary follows the form: its title, first two matches, Enabled and the buttons stay at the bottom. */
      .pf-aside { position: sticky; top: auto; bottom: 0; z-index: 5; }
      .pf-summary { border-radius: var(--radius-lg) var(--radius-lg) 0 0; box-shadow: var(--shadow-md); }
      .pf-facts .dg-detail-row:not(.pf-enabled-row) { display: none; }
      .pf-summary-items li:nth-child(n + 3), .pf-summary-notes { display: none; }
      .pf-summary-warning { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    }
    .policy-section { margin-top: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); overflow: visible; }
    .policy-section-body { padding: 14px; }
    .action-select { width: auto; min-width: 8.5rem; font-weight: 600; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    legend { float: none; width: auto; }
    .rule-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
    .rule-option {
      display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; cursor: pointer;
      border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface);
      transition: border-color 0.15s, background 0.15s;
    }
    .rule-option:hover { border-color: var(--brand); }
    .rule-option:focus-within { outline: 2px solid var(--brand); outline-offset: 1px; }
    .rule-option.is-selected { border-color: var(--brand); background: var(--color-surface-container-low); box-shadow: inset 0 0 0 1px var(--brand); }
    .rule-chosen { cursor: default; align-items: center; }
    .rule-chosen:focus-within { outline: none; }
    .rule-chosen .rule-text { flex: 1; }
    .rule-icon { font-size: 20px; color: var(--brand); }
    .rule-text { display: flex; flex-direction: column; min-width: 0; }
    .rule-label { font-size: 0.875rem; font-weight: 600; color: var(--color-on-surface); }
    .rule-desc { font-size: 0.75rem; line-height: 1.4; color: var(--color-on-surface-variant); }
    .rt-list { display: flex; flex-direction: column; gap: 8px; }
    .mode-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
    .rt-option {
      display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; cursor: pointer;
      border: 1px solid var(--color-border); border-radius: var(--radius);
    }
    .rt-option:hover:not(.is-disabled) { border-color: var(--brand); }
    .rt-option .form-check-input { margin-top: 3px; flex-shrink: 0; }
    .rt-option.is-disabled { cursor: not-allowed; opacity: 0.55; }
    label.rt-label { cursor: pointer; margin: 0; }
    .rt-option.is-off .rt-desc { opacity: 0.75; }
    .age-option { flex-wrap: wrap; align-items: center; gap: 8px; cursor: default; }
    .age-option .form-check-input { margin-top: 0; }
    .age-text { font-size: 0.875rem; color: var(--color-on-surface); margin: 0; }
    label.age-text { cursor: pointer; font-weight: 600; }
    .age-number { width: 90px; }
    .age-input { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 0.8125rem; color: var(--color-on-surface-variant); }
    .age-input input { width: 110px; }
    .rt-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .rt-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .rt-label { font-size: 0.875rem; font-weight: 600; color: var(--color-on-surface); }
    .rt-desc { font-size: 0.8125rem; color: var(--color-on-surface-variant); }
    .rt-tags { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    .rt-eg { font-size: 0.75rem; color: var(--color-muted); margin-right: 2px; }
    .rt-details summary { font-size: 0.8125rem; color: var(--brand); cursor: pointer; }
    .rt-table { width: 100%; margin-top: 8px; font-size: 0.8125rem; }
    .rt-table th { width: 96px; padding: 4px 8px 4px 0; font-weight: 600; vertical-align: top; white-space: nowrap; }
    .rt-table td { padding: 4px 0; color: var(--color-on-surface-variant); }
    .unknown-row { display: flex; flex-wrap: wrap; align-items: center; column-gap: 14px; row-gap: 2px; margin-top: 8px; font-size: 0.8125rem; }
    .unknown-row .epss-mode { margin: 0; }
    .unknown-label { flex-basis: 100%; font-weight: 600; color: var(--color-on-surface); }
    .unknown-note { color: var(--color-muted); font-size: 0.75rem; }
    .license-chips-container {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      min-height: 44px; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius);
    }
    .license-remove { display: inline-grid; place-items: center; padding: 0; border: none; background: transparent; color: inherit; opacity: 0.6; cursor: pointer; }
    .license-remove:hover { opacity: 1; }
    .license-remove .material-symbols-outlined { font-size: 14px; }
    .license-dropdown { min-width: 280px; max-height: 220px; overflow-y: auto; z-index: 1000; box-shadow: var(--shadow-md); }
    .epss-modes { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
    .epss-mode { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; margin: 0 0 4px; }
    .epss-mode input[type='number'] { width: 90px; }
    .sc-score { display: flex; align-items: center; gap: 10px; font-size: 0.8125rem; color: var(--color-on-surface-variant); }
    .sc-score input[type='number'] { width: 90px; }
    .sc-edges { display: grid; gap: 8px; margin: 10px 0 8px; }
    .sc-edge { display: flex; align-items: center; gap: 6px; font-size: 0.8125rem; }
    .sc-edge label { margin: 0; min-width: 245px; font-weight: 600; color: var(--color-on-surface); }
    .sc-edge select { width: auto; min-width: 7rem; margin-left: 6px; }
    .sc-check { display: grid; grid-template-columns: minmax(0, 220px) auto 80px auto; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 0.8125rem; }
    .sc-check-desc { grid-column: 1 / -1; margin-top: -4px; }
    .sc-check .material-symbols-outlined { font-size: 16px; }
  `],
})
export class PolicyFormComponent implements DoCheck, OnDestroy {
  editing = false;
  id = '';
  name = '';
  description = '';
  decision: PolicyDecision = 'BLOCK';
  priority = 0;
  ecosystem = '';
  ecosystems: string[] = [...ECOSYSTEMS];
  isEnabled = true;
  /** Block policies only: monitor records what it would block instead of blocking. */
  mode: PolicyMode = 'enforce';
  /** Repositories the policy applies to; empty for every repository. */
  repositoryIds: string[] = [];
  /** `npm/prod` labels of the chosen repositories. */
  scopeLabels: string[] = [];
  scopeMode: 'all' | 'selected' = 'all';
  /** Scoped repositories that were deleted since the policy was saved. */
  missingRepositoryCount = 0;
  /** "Edit rule" from the Monitoring page: the change applied to the form, in words. */
  suggestionNote = '';
  saving = false;
  /** Editing: the policy is being fetched. */
  loading = false;
  /** Editing: why the policy could not be loaded. */
  loadError = '';
  /** Where Cancel and Save return to: an app path. */
  returnUrl = '/policies';

  readonly rules = POLICY_RULES;
  readonly releaseTypes = RELEASE_TYPES;
  rule: PolicyRule | '' = '';
  /** Every rule card is shown until one is picked; afterwards only the chosen one, with Change. */
  ruleGridOpen = true;
  /** Rules a policy saved before single-rule policies still carries. */
  legacyRules: PolicyRule[] = [];
  /** Picking the rule or EPSS switched a new policy to monitor; cleared once the user picks a mode. */
  autoMonitorNote = false;

  packageNames: string[] = [];
  /** Typed in the package box but not yet a chip. */
  packageDraft = '';
  versionConstraints: VersionConstraint[] = [];
  selectedReleaseTypes: ReleaseTypeId[] = [];
  tooNewEnabled = false;
  tooNewHoursStr = '';
  unmaintainedEnabled = false;
  unmaintainedDaysStr = '';
  cveIds: string[] = [];
  cveDraft = '';
  /** Vulnerability rule: CVSS minimum as typed, 0.1–10. */
  cvssMinStr = '';
  cvssUnknown: 'match' | 'ignore' = 'ignore';
  /** Vulnerability rule: EPSS threshold, entered in percent. */
  epssEnabled = false;
  epssMode: 'score' | 'percentile' = 'score';
  epssScoreStr = '10';
  epssPercentileStr = '95';
  epssUnknown: 'match' | 'ignore' = 'match';
  selectedLicenses: string[] = [];
  /** New license policies allow only approved licenses; block mode is for a short banned list. */
  licenseMode: 'allow' | 'deny' = 'allow';
  allowUnknownLicense = false;
  /** Namespace protection rule. */
  reservedNamespaces: string[] = [];
  publicPackages: string[] = [];
  /** Remote IDs allowed to serve the names (R6); empty for every internal remote. */
  allowedRemotes: string[] = [];
  namespaceErrors: string[] = [];
  /** Keys of the internal remotes of the chosen ecosystem, for the review sentence. */
  namespaceInternalKeys: string[] = [];
  /** Project health (OpenSSF Scorecard) rule. */
  scorecardMinScoreStr = '5';
  scorecardChecks: Array<{ name: string; minStr: string }> = [];
  scorecardUnknown: 'allow' | 'block' = 'allow';
  scorecardUnavailable: 'allow' | 'block' = 'allow';
  scorecardAdvancedOpen = false;
  readonly scorecardCheckOptions = SCORECARD_CHECKS;
  /** Repositories, read once the Project health rule is chosen, for the "none is public" warning. */
  private repositoryRows: PackageRepositoryRow[] | null = null;
  licenseSearchQuery = '';
  showLicenseDropdown = false;
  private allLicenses: OsiLicense[] = [];
  filteredLicenses = signal<OsiLicense[]>([]);

  private policyService = inject(PolicyService);
  private toast = inject(ToastService);
  private licenseService = inject(LicenseService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private crumbs = inject(BreadcrumbService);
  private confirm = inject(ConfirmService);
  private repositoryService = inject(RepositoryService);
  private host = inject(ElementRef);
  /** The form as last loaded or saved, to tell whether leaving loses changes. */
  private cleanState = '';
  private saved = false;
  /** The name last suggested; the name follows suggestions until the user types another. */
  private suggestedName = '';

  constructor() {
    this.licenseService.loadLicenses().then((list) => {
      this.allLicenses = list;
    });
    const params = this.route.snapshot.paramMap;
    const query = this.route.snapshot.queryParamMap;
    this.returnUrl = safeReturnUrl(query.get('returnUrl'));
    const id = params.get('id');
    this.crumbs.detail.set(id ? 'Edit policy' : 'New policy');
    if (!id) {
      if (query.get('mode') === 'monitor') this.mode = 'monitor';
      this.markClean();
      return;
    }
    this.editing = true;
    this.loading = true;
    this.policyService.get(id).subscribe({
      next: (policy) => {
        this.load(policy);
        this.loading = false;
        this.markClean();
        // A suggestion from Monitoring is an unsaved change: leaving asks first.
        const suggest = query.get('suggest');
        if (suggest) this.applySuggestion({ reasonKey: suggest });
      },
      error: (err) => {
        this.loading = false;
        this.loadError = err.error?.error ?? 'It may have been deleted.';
      },
    });
  }

  ngOnDestroy(): void {
    this.crumbs.detail.set(null);
  }

  /** A new policy's name follows the suggestion while it is empty or still the last one suggested. */
  ngDoCheck(): void {
    if (this.editing || this.loading) return;
    const next = this.nameSuggestion;
    if (next === this.suggestedName) return;
    if (!this.name.trim() || this.name === this.suggestedName) this.name = next;
    this.suggestedName = next;
  }

  /** "Block lodash (npm)", "Vulnerability: CVSS ≥ 7.0"; empty until the rule matches something. */
  get nameSuggestion(): string {
    if (!this.rule || !this.hasSummary) return '';
    const c = this.buildConditions();
    let name: string;
    switch (this.rule) {
      case 'packages':
        name = `${this.decisionLabel(this.decision)} ${this.packageList.join(', ')}`;
        break;
      case 'releaseType':
        name = `Block ${joinWords(this.chosenReleaseTypes.map((info) => RELEASE_TYPE_WORDS[info.id]))} versions`;
        break;
      case 'license':
        name = `License: ${this.licenseMode === 'allow' ? 'only' : 'no'} ${this.selectedLicenses.join(', ')}`;
        break;
      case 'namespace':
        name = `Namespace protection: ${this.reservedNamespaces.join(', ')}`;
        break;
      case 'scorecard':
        name = `Project health: ${scorecardDetail(c)}`;
        break;
      default:
        name = `${ruleInfo(this.rule).label}: ${ruleDetail(this.rule, c)}`;
    }
    const eco = this.ecosystem ? ` (${ecosystemLabel(this.ecosystem)})` : '';
    const room = SUGGESTED_NAME_MAX - eco.length;
    return (name.length > room ? `${name.slice(0, room - 1).trimEnd()}…` : name) + eco;
  }

  /** "Monitoring" or "Policies": the page Cancel returns to. */
  get returnLabel(): string {
    return this.returnUrl.startsWith('/monitoring') ? 'Monitoring' : 'Policies';
  }

  /** Whether the form differs from what was loaded (or from a blank form). */
  get dirty(): boolean {
    return !this.saved && !this.loading && !this.loadError && this.state() !== this.cleanState;
  }

  /** For the route guard: true to leave, after asking when there are unsaved changes. */
  canLeave(): boolean | Promise<boolean> {
    if (!this.dirty) return true;
    return this.confirm.confirm({
      title: 'Discard changes?',
      message: this.editing ? 'Your changes to this policy have not been saved.' : 'This policy has not been created yet.',
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
    return JSON.stringify(this.payload());
  }

  private payload() {
    return {
      name: this.name.trim(),
      description: this.description.trim() || null,
      decision: this.decision,
      priority: this.priority,
      conditions: this.buildConditions(),
      isEnabled: this.isEnabled,
      mode: this.monitoring ? 'monitor' : 'enforce',
      repositoryIds: this.repositoryIds,
    } satisfies Partial<Policy>;
  }

  get monitoring(): boolean {
    return this.decision === 'BLOCK' && this.mode === 'monitor';
  }

  /** Rules other than Packages cover every package in the ecosystem: the ones worth monitoring first. */
  get recommendMonitor(): boolean {
    return !!this.rule && this.rule !== 'packages' && this.mode === 'enforce' && !this.editing;
  }

  /** The user picks Enforce or Monitor only. */
  setMode(mode: PolicyMode): void {
    this.mode = mode;
    this.autoMonitorNote = false;
  }

  /** Monitors a new block policy for a rule worth monitoring first, and says so under Enforcement. */
  private switchToMonitor(): void {
    if (this.editing || this.decision !== 'BLOCK') return;
    if (this.mode !== 'monitor') this.autoMonitorNote = true;
    this.mode = 'monitor';
  }

  /** "Block" for a radio that blocks, "Flag" while the policy only monitors. */
  get blockLabel(): string {
    return this.monitoring ? 'Flag' : 'Block';
  }

  /** The change "Edit rule" proposes for a reason group on the Monitoring page (MON-U4). */
  applySuggestion(suggestion: RuleSuggestion): void {
    const key = suggestion.reasonKey;
    this.suggestionNote = suggestionText(this.rule || null, key, this.buildConditions());
    switch (this.rule) {
      case 'license':
        if (key === 'UNKNOWN') {
          if (this.licenseMode === 'allow') this.allowUnknownLicense = true;
          else this.selectedLicenses = this.selectedLicenses.filter((id) => id.toUpperCase() !== 'UNKNOWN');
        } else if (this.licenseMode === 'allow') {
          const ids = licenseIds(key);
          // One approved choice is enough for an OR expression; every part is needed for AND.
          const add = /\sOR\s/i.test(key) ? ids.slice(0, 1) : ids;
          this.selectedLicenses = [...this.selectedLicenses, ...add.filter((id) => !this.selectedLicenses.includes(id))];
        } else {
          const ids = new Set(licenseIds(key).map((id) => id.toLowerCase()));
          this.selectedLicenses = this.selectedLicenses.filter((id) => !ids.has(id.toLowerCase()));
        }
        break;
      case 'vulnerability':
        if (key.startsWith('cve:')) {
          const cve = key.slice(4).toLowerCase();
          this.cveBlockListStr = this.cveList.filter((id) => id.toLowerCase() !== cve).join(', ');
        } else if (key === 'epss:unknown') {
          this.epssUnknown = 'ignore';
        } else if (key.startsWith('epss:')) {
          // Double the threshold, so only clearly likelier exploits still match.
          if (this.epssMode === 'score') this.epssScoreStr = String(Math.min(100, Number(this.epssScoreStr) * 2));
          else this.epssPercentileStr = String(Math.min(100, Number(this.epssPercentileStr) + Math.ceil((100 - Number(this.epssPercentileStr)) / 2)));
        } else if (key === 'cvss:unknown') {
          this.cvssUnknown = 'ignore';
        } else {
          const raised = raisedCvss(this.cvssMin ?? undefined);
          this.cvssMinStr = raised === null ? '' : cvssScoreText(raised);
        }
        break;
      case 'releaseType':
        this.selectedReleaseTypes = this.selectedReleaseTypes.filter((type) => type !== key);
        break;
      case 'releaseAge':
        if (key === 'too_new' && this.tooNewHours > 1) this.tooNewHoursStr = String(Math.max(1, Math.floor(this.tooNewHours / 2)));
        if (key === 'unmaintained' && this.unmaintainedDays > 0) this.unmaintainedDaysStr = String(this.unmaintainedDays * 2);
        break;
      case 'scorecard':
        if (key === 'scorecard:overall' && this.scorecardMinScore !== null) {
          this.scorecardMinScoreStr = String(Math.max(0, this.scorecardMinScore - 1));
        } else if (key === 'scorecard:unknown') {
          this.scorecardUnknown = 'allow';
        } else if (key === 'scorecard:unavailable') {
          this.scorecardUnavailable = 'allow';
        } else if (key.startsWith('scorecard:')) {
          const check = key.slice(10);
          this.scorecardChecks = this.scorecardChecks.filter((row) => row.name !== check);
        }
        break;
      default:
        // A package pattern cannot be narrowed automatically; the note says what to change.
        break;
    }
  }

  private load(p: Policy): void {
    this.id = p.id;
    this.name = p.name;
    this.description = p.description ?? '';
    this.decision = p.decision;
    this.priority = p.priority;
    this.isEnabled = p.isEnabled;
    this.mode = p.mode === 'monitor' ? 'monitor' : 'enforce';
    // Deleted repositories stay in the stored scope so it never widens; the form asks to choose again.
    this.repositoryIds = (p.repositories ?? []).map((ref) => ref.id);
    this.scopeLabels = (p.repositories ?? []).map((ref) => `${ref.ecosystem}/${ref.key}`);
    this.missingRepositoryCount = missingIds(p.repositoryIds, p.repositories).length;
    this.scopeMode = this.repositoryIds.length || this.missingRepositoryCount ? 'selected' : 'all';
    let raw: unknown = p.conditions;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = {};
      }
    }
    const c = (raw ?? {}) as PolicyConditions;
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
    this.ecosystem = list(c.ecosystem)[0] ?? '';
    this.packageBlockListStr = list(c.packageBlockList).join(', ');
    this.versionConstraints = parseVersion(c.versionRange ?? '');
    this.selectedReleaseTypes = list(c.releaseTypes).filter((t): t is ReleaseTypeId =>
      RELEASE_TYPES.some((info) => info.id === t)
    );
    const maxHours = Number(c.releaseAgeMaxHours ?? 0);
    const minDays = Number(c.releaseAgeMinDays ?? 0);
    this.tooNewEnabled = maxHours > 0;
    this.tooNewHoursStr = maxHours > 0 ? String(maxHours) : '';
    this.unmaintainedEnabled = minDays > 0;
    this.unmaintainedDaysStr = minDays > 0 ? String(minDays) : '';
    this.cveBlockListStr = list(c.cveBlockList).join(', ');
    this.cvssMinStr = typeof c.cvssMin === 'number' ? cvssScoreText(c.cvssMin) : '';
    this.cvssUnknown = c.cvssUnknown === 'match' ? 'match' : 'ignore';
    this.epssEnabled = typeof c.epssMin === 'number' || typeof c.epssPercentileMin === 'number';
    this.epssMode = typeof c.epssPercentileMin === 'number' ? 'percentile' : 'score';
    if (typeof c.epssMin === 'number') this.epssScoreStr = String(Number((c.epssMin * 100).toFixed(4)));
    if (typeof c.epssPercentileMin === 'number') this.epssPercentileStr = String(Math.round(c.epssPercentileMin * 100));
    this.epssUnknown = c.epssUnknown === 'ignore' ? 'ignore' : 'match';
    const approved = list(c.licenseAllowList);
    this.licenseMode = approved.length ? 'allow' : list(c.licenseDenyList).length ? 'deny' : 'allow';
    this.selectedLicenses = approved.length ? approved : list(c.licenseDenyList);
    this.allowUnknownLicense = c.allowUnknownLicense === true;
    this.reservedNamespaces = list(c.reservedNamespaces);
    this.publicPackages = list(c.publicPackages);
    this.allowedRemotes = list(c.allowedRemotes);
    this.scorecardMinScoreStr = typeof c.scorecardMinScore === 'number' ? String(c.scorecardMinScore) : '';
    this.scorecardChecks = (Array.isArray(c.scorecardChecks) ? c.scorecardChecks : []).map((row) => ({
      name: String(row?.name ?? ''),
      minStr: String(row?.minScore ?? ''),
    }));
    this.scorecardUnknown = c.scorecardUnknown === 'block' ? 'block' : 'allow';
    this.scorecardUnavailable = c.scorecardUnavailable === 'block' ? 'block' : 'allow';
    this.scorecardAdvancedOpen = this.scorecardChecks.length > 0 || this.scorecardUnknown === 'block' || this.scorecardUnavailable === 'block';
    this.legacyRules = rulesOf(c);
    this.rule = this.legacyRules[0] ?? '';
    this.ruleGridOpen = !this.rule;
    if (this.rule === 'scorecard') this.loadRepositories();
  }

  /** Actions the chosen rule offers; both before a rule is picked. */
  get decisionOptions(): PolicyDecision[] {
    return this.rule ? RULE_DECISIONS[this.rule] : ['ALLOW', 'BLOCK'];
  }

  get decisionAllowed(): boolean {
    return this.decisionOptions.includes(this.decision);
  }

  /** Picking a rule that does not offer the current action switches it to Block. */
  selectRule(rule: PolicyRule): void {
    if (rule !== this.rule) this.autoMonitorNote = false;
    this.rule = rule;
    this.ruleGridOpen = false;
    if (!this.decisionAllowed) this.decision = 'BLOCK';
    if (rule === 'scorecard') {
      // Many popular, safe packages score 3–5: a new Project health policy starts by monitoring.
      this.switchToMonitor();
      this.loadRepositories();
    }
  }

  private loadRepositories(): void {
    if (this.repositoryRows) return;
    this.repositoryRows = [];
    this.repositoryService.list().subscribe({
      next: (rows) => (this.repositoryRows = rows),
      error: () => (this.repositoryRows = []),
    });
  }

  /** Clicking the already chosen card closes the grid again; another card is chosen through its radio. */
  closeRuleGridOn(rule: PolicyRule): void {
    if (rule === this.rule) this.ruleGridOpen = false;
  }

  /** The chosen rule's card. */
  get chosenRule(): PolicyRuleInfo {
    return ruleInfo(this.rule || 'packages');
  }

  get legacyRuleNames(): string {
    return this.legacyRules.map((rule) => ruleInfo(rule).label.toLowerCase()).join(', ');
  }

  // --- Packages rule ---

  addExactVersion(): void {
    this.versionConstraints.push({ kind: 'exact', version: '', from: '', to: '' });
  }

  addVersionRange(): void {
    this.versionConstraints.push({ kind: 'range', version: '', from: '', to: '' });
  }

  removeVersionConstraint(index: number): void {
    this.versionConstraints.splice(index, 1);
  }

  get hasIncompleteRange(): boolean {
    return this.versionConstraints.some((vr) => vr.kind === 'range' && !!vr.from.trim() !== !!vr.to.trim());
  }

  /** The package chips, plus what is typed but not yet a chip. */
  get packageList(): string[] {
    return unique([...this.packageNames, ...splitList(this.packageDraft)]);
  }

  /** The package names as one comma-separated string, as older code and tests set them. */
  get packageBlockListStr(): string {
    return this.packageNames.join(', ');
  }

  set packageBlockListStr(value: string) {
    this.packageNames = unique(splitList(value));
    this.packageDraft = '';
  }

  get versionSummary(): string {
    const parts = this.versionConstraints.map((vr) => this.describeConstraint(vr)).filter(Boolean);
    return parts.length ? parts.join(', ') : 'Any version';
  }

  private describeConstraint(vr: VersionConstraint): string {
    if (vr.kind === 'exact') return vr.version.trim();
    const from = vr.from.trim();
    const to = vr.to.trim();
    if (from && to) return `${from} – ${to}`;
    if (from) return `>= ${from}`;
    if (to) return `<= ${to}`;
    return '';
  }

  private buildVersionRange(): string {
    const built = buildVersion(this.versionConstraints);
    if (built === '*') return '';
    return built
      .split(' || ')
      .map((part) => (/[<>=\s]/.test(part) ? part : `=${part}`))
      .join(' || ');
  }

  // --- Release type rule ---

  get releaseTypeRules() {
    return this.ecosystem ? RELEASE_TYPE_RULES.filter((row) => row.ecosystem === this.ecosystem) : RELEASE_TYPE_RULES;
  }

  applies(info: ReleaseTypeInfo): boolean {
    return releaseTypeApplies(info, this.ecosystem);
  }

  appliesTo(info: ReleaseTypeInfo): string {
    return appliesToLabel(info);
  }

  examples(info: ReleaseTypeInfo): string[] {
    return releaseTypeExamples(info, this.ecosystem);
  }

  isReleaseTypeSelected(id: ReleaseTypeId): boolean {
    return this.selectedReleaseTypes.includes(id);
  }

  toggleReleaseType(id: ReleaseTypeId): void {
    this.selectedReleaseTypes = this.isReleaseTypeSelected(id)
      ? this.selectedReleaseTypes.filter((t) => t !== id)
      : [...this.selectedReleaseTypes, id];
  }

  selectAllReleaseTypes(): void {
    this.selectedReleaseTypes = RELEASE_TYPES.filter((info) => this.applies(info)).map((info) => info.id);
  }

  /** Selected types that can occur in the chosen ecosystem, in display order. */
  get chosenReleaseTypes(): ReleaseTypeInfo[] {
    return RELEASE_TYPES.filter((info) => this.isReleaseTypeSelected(info.id) && this.applies(info));
  }

  get matchedExamples(): string[] {
    return this.chosenReleaseTypes.flatMap((info) => this.examples(info).slice(0, 2));
  }

  get stableExampleList(): string[] {
    return stableExamples(this.ecosystem);
  }

  // --- Release age, vulnerability, license ---

  get tooNewHours(): number {
    return positiveInt(this.tooNewHoursStr);
  }

  get unmaintainedDays(): number {
    return positiveInt(this.unmaintainedDaysStr);
  }

  /** A ticked option without a number above zero. */
  get releaseAgeIncomplete(): boolean {
    return (this.tooNewEnabled && this.tooNewHours === 0) || (this.unmaintainedEnabled && this.unmaintainedDays === 0);
  }

  /** Selecting an option fills in the usual number, so the selection alone is enough. */
  setTooNew(on: boolean): void {
    this.tooNewEnabled = on;
    if (on && this.tooNewHours === 0) this.tooNewHoursStr = '72';
  }

  setUnmaintained(on: boolean): void {
    this.unmaintainedEnabled = on;
    if (on && this.unmaintainedDays === 0) this.unmaintainedDaysStr = '365';
  }

  /** The CVE chips, plus what is typed but not yet a chip. */
  get cveList(): string[] {
    return unique([...this.cveIds, ...splitList(this.cveDraft)]);
  }

  get cveBlockListStr(): string {
    return this.cveIds.join(', ');
  }

  set cveBlockListStr(value: string) {
    this.cveIds = unique(splitList(value));
    this.cveDraft = '';
  }

  /** An advisory ID as OSV lists it: CVE-2024-1234, GHSA-xxxx-xxxx-xxxx, PYSEC-2021-1, GO-2022-0001. */
  readonly cveError = (id: string): string =>
    /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? '' : 'Not an advisory ID, e.g. CVE-2024-1234 or GHSA-…';

  /** The CVSS minimum, or null when empty or not a score from 0.1 to 10 with one decimal. */
  get cvssMin(): number | null {
    return cvssScoreOf(this.cvssMinStr);
  }

  get cvssMinInvalid(): boolean {
    return String(this.cvssMinStr ?? '').trim() !== '' && this.cvssMin === null;
  }

  /** Scores change daily, so a new policy that uses EPSS starts by monitoring. */
  toggleEpss(on: boolean): void {
    this.epssEnabled = on;
    if (on) this.switchToMonitor();
    else this.autoMonitorNote = false;
  }

  /** The EPSS threshold as the API stores it (a fraction), or null when off or not a valid number. */
  get epssFraction(): number | null {
    if (!this.epssEnabled) return null;
    const raw = this.epssMode === 'score' ? this.epssScoreStr : this.epssPercentileStr;
    const n = Number(String(raw ?? '').trim());
    if (!String(raw ?? '').trim() || !Number.isFinite(n) || n <= 0 || n > 100) return null;
    return Number((n / 100).toFixed(6));
  }

  getLicenseDisplayName(spdxId: string): string {
    const lic = this.allLicenses.find((l) => l.spdxId === spdxId);
    return lic ? lic.spdxId : spdxId;
  }

  addLicense(lic: OsiLicense): void {
    if (!this.selectedLicenses.includes(lic.spdxId)) {
      this.selectedLicenses = [...this.selectedLicenses, lic.spdxId];
      this.licenseSearchQuery = '';
      this.onLicenseSearch('');
    }
  }

  /** A typed ID that the OSI list does not offer, such as SSPL-1.0 or a pattern like BSD-*. */
  customLicense(): string | null {
    const typed = this.licenseSearchQuery.trim();
    if (!typed || /\s/.test(typed) || this.selectedLicenses.some((l) => l.toLowerCase() === typed.toLowerCase())) return null;
    const offered = this.filteredLicenses().some((l) => l.spdxId.toLowerCase() === typed.toLowerCase());
    return offered ? null : typed;
  }

  /** Enter adds the exact OSI match, otherwise the typed ID. */
  addTypedLicense(): void {
    const typed = this.licenseSearchQuery.trim();
    if (!typed) return;
    const match = this.filteredLicenses().find((l) => l.spdxId.toLowerCase() === typed.toLowerCase());
    if (match) {
      this.addLicense(match);
      return;
    }
    const custom = this.customLicense();
    if (!custom) return;
    this.selectedLicenses = [...this.selectedLicenses, custom];
    this.licenseSearchQuery = '';
    this.onLicenseSearch('');
  }

  removeLicense(spdxId: string): void {
    this.selectedLicenses = this.selectedLicenses.filter((l) => l !== spdxId);
  }

  onLicenseSearch(query: string): void {
    this.licenseService.searchLicenses(query).then((list) => {
      this.filteredLicenses.set(list);
      if (list.length) this.allLicenses = list;
    });
  }

  onLicenseBlur(): void {
    setTimeout(() => (this.showLicenseDropdown = false), 150);
  }

  // --- Project health (OpenSSF Scorecard) ---

  /** The overall minimum, or null when the field is empty or not a score. */
  get scorecardMinScore(): number | null {
    return scoreOf(this.scorecardMinScoreStr);
  }

  get scorecardMinScoreInvalid(): boolean {
    return String(this.scorecardMinScoreStr ?? '').trim() !== '' && this.scorecardMinScore === null;
  }

  checkDescription(name: string): string {
    return scorecardCheckDescription(name);
  }

  /** A new row gets the first check not listed yet, with a hard floor of 10. */
  addScorecardCheck(): void {
    const used = new Set(this.scorecardChecks.map((row) => row.name));
    const next = SCORECARD_CHECKS.find((check) => check.name === 'Dangerous-Workflow' && !used.has(check.name))
      ?? SCORECARD_CHECKS.find((check) => !used.has(check.name));
    if (!next) return;
    this.scorecardChecks = [...this.scorecardChecks, { name: next.name, minStr: '10' }];
    this.scorecardAdvancedOpen = true;
  }

  removeScorecardCheck(index: number): void {
    this.scorecardChecks = this.scorecardChecks.filter((_, i) => i !== index);
  }

  private get scorecardCheckList(): Array<{ name: string; minScore: number }> {
    return this.scorecardChecks.flatMap((row) => {
      const min = scoreOf(row.minStr);
      return min === null ? [] : [{ name: row.name, minScore: min }];
    });
  }

  private get scorecardError(): string {
    if (this.scorecardMinScoreInvalid) return 'The overall score must be a number from 0 to 10.';
    if (this.scorecardChecks.some((row) => scoreOf(row.minStr) === null)) return 'Each check needs a minimum from 0 to 10.';
    if (new Set(this.scorecardChecks.map((row) => row.name)).size !== this.scorecardChecks.length) return 'List each check once.';
    if (this.scorecardMinScore === null && this.scorecardChecks.length === 0) return 'Set an overall score or add a check.';
    return '';
  }

  /** Scoped to repositories none of which is public: the rule would never apply (§5.1). */
  get scorecardScopeWarning(): string {
    if (this.rule !== 'scorecard' || this.repositoryIds.length === 0 || !this.repositoryRows?.length) return '';
    const rows = this.repositoryRows;
    const chosen = rows.filter((row) => this.repositoryIds.includes(row.id));
    if (chosen.length === 0 || chosen.some((row) => repositoryIsPublic(row, rows))) return '';
    return 'None of the selected repositories is public, so this rule will never apply. It checks only repositories whose remotes are all public.';
  }

  // --- Summary, validation, save ---

  ecoLabel(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  decisionLabel(decision: string): string {
    return statusLabel(decision);
  }

  get ecosystemSummary(): string {
    return this.ecosystem ? ecosystemLabel(this.ecosystem) : 'All ecosystems';
  }

  /** The banner title: the action, or what a monitoring policy would do. */
  get summaryTitle(): string {
    if (this.decision === 'ALLOW') return 'Allow';
    return this.monitoring ? 'Monitor only — would block' : 'Block';
  }

  get bannerClass(): string {
    if (this.decision === 'ALLOW') return 'dg-banner-allow';
    return this.monitoring ? 'dg-banner-pending' : 'dg-banner-block';
  }

  get bannerIcon(): string {
    if (this.decision === 'ALLOW') return 'check_circle';
    return this.monitoring ? 'visibility' : 'block';
  }

  /** The rule matches something yet, so the summary has something to show (before the form can be saved, too). */
  get hasSummary(): boolean {
    const summary = this.summary;
    return !!this.rule && summary.items.length > 0;
  }

  /** What the chosen rule matches and how it treats edge cases. Ecosystem and repositories are listed under it. */
  get summary(): PolicySummary {
    const notes: PolicySummary['notes'] = [];
    // A monitoring policy blocks nothing; it flags what it would block.
    const blocked = this.monitoring ? 'flagged' : 'blocked';
    const c = this.buildConditions();
    switch (this.rule) {
      case 'packages': {
        const lead = this.versionSummary === 'Any version' ? 'Every version of:' : `Versions ${this.versionSummary} of:`;
        return { lead, items: this.packageList, notes };
      }
      case 'releaseType':
        return { lead: 'Versions that are:', items: this.chosenReleaseTypes.map((info) => info.label), notes };
      case 'releaseAge': {
        const items: string[] = [];
        if (this.tooNewEnabled && this.tooNewHours > 0) items.push(`Published less than ${plural(this.tooNewHours, 'hour')} ago`);
        if (this.unmaintainedEnabled && this.unmaintainedDays > 0) {
          // Read after "or" when it is the second line.
          items.push(`${items.length ? 'from' : 'From'} packages with no release in ${plural(this.unmaintainedDays, 'day')}`);
        }
        return { lead: 'Versions matching:', items, notes };
      }
      case 'vulnerability': {
        const items: string[] = [];
        // One vulnerability must meet every threshold, so they share a line.
        const thresholds = [cvssText(c), epssText(c)].filter(Boolean);
        if (thresholds.length) items.push(thresholds.join(' and '));
        if (this.cveList.length) items.push(this.cveList.join(', '));
        if (this.cvssMin !== null) notes.push({ label: 'Vulnerabilities without CVSS', value: this.cvssUnknown === 'match' ? blocked : 'ignored' });
        if (this.epssFraction !== null) notes.push({ label: 'Vulnerabilities without EPSS', value: this.epssUnknown === 'match' ? blocked : 'ignored' });
        return { lead: 'Versions with:', items, notes };
      }
      case 'license': {
        const items = this.selectedLicenses.length ? [listText(this.selectedLicenses)] : [];
        if (this.licenseMode === 'deny') return { lead: 'Versions licensed under:', items, notes };
        notes.push({ label: 'Packages without a license', value: this.allowUnknownLicense ? 'allowed' : blocked });
        return { lead: 'Versions whose license is not:', items, notes };
      }
      case 'namespace': {
        // R6: bound to chosen remotes, or by default every internal remote.
        const keys = this.namespaceInternalKeys.join(', ');
        const bound = this.allowedRemotes.length > 0;
        const servedFrom = bound ? keys || 'the chosen remotes' : keys ? `internal remotes (${keys})` : 'internal remotes';
        notes.push({ label: 'Served only from', value: servedFrom });
        notes.push({ label: 'Other remotes', value: blocked });
        if (this.publicPackages.length) notes.push({ label: 'From any remote', value: this.publicPackages.join(', ') });
        return { lead: 'Packages named:', items: [...this.reservedNamespaces], notes, text: this.namespaceWarning };
      }
      case 'scorecard': {
        const items: string[] = [];
        if (this.scorecardMinScore !== null) items.push(`OpenSSF Scorecard below ${formatScore(this.scorecardMinScore)}`);
        for (const check of this.scorecardCheckList) items.push(`${check.name} check below ${formatScore(check.minScore)}`);
        notes.push({ label: 'Packages without a Scorecard', value: this.scorecardUnknown === 'block' ? blocked : 'allowed' });
        notes.push({ label: 'Scorecard unreachable', value: this.scorecardUnavailable === 'block' ? blocked : 'allowed' });
        return { lead: 'Packages with:', items, notes };
      }
      default:
        return { lead: '', items: [], notes };
    }
  }

  /** An enforced policy whose names no remote may serve blocks every one of them; the summary says so. */
  private get namespaceWarning(): string {
    if (this.monitoring || this.namespaceInternalKeys.length || !this.reservedNamespaces.length) return '';
    return this.allowedRemotes.length
      ? 'None of the chosen remotes is enabled, so every one of these names is blocked.'
      : 'There is no internal remote yet, so every one of these names is blocked.';
  }

  /** Why Create is unavailable, shown next to the disabled button; empty when the policy can be saved. */
  saveBlocker(): string {
    return this.blocker()?.text ?? '';
  }

  /** Scrolls to the field the save blocker is about, puts the cursor in it and makes it pulse. */
  goToBlocker(): void {
    const blocker = this.blocker();
    if (!blocker) return;
    if (blocker.target === ADVANCED_CHECKS) this.scorecardAdvancedOpen = true;
    // Let a folded section open before looking for the field.
    setTimeout(() => {
      const target = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(blocker.target);
      if (!target) return;
      const field = target.matches(FOCUSABLE) ? target : target.querySelector<HTMLElement>(FOCUSABLE);
      const box = target.closest<HTMLElement>('.chip-box, .tag-box, .license-chips-container') ?? target;
      box.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      field?.focus({ preventScroll: true });
      box.classList.remove('dg-attention');
      void box.offsetWidth; // restart the pulse when clicked twice
      box.classList.add('dg-attention');
      setTimeout(() => box.classList.remove('dg-attention'), 1400);
    });
  }

  /** What still stops the save, and a selector for the field it is about. */
  private blocker(): { text: string; target: string } | null {
    const at = (text: string, target: string) => ({ text, target });
    if (!this.name.trim()) return at('Enter a name.', '#policy-name');
    if (this.scopeMode === 'selected' && this.repositoryIds.length === 0) {
      return at('Select at least one repository, or All repositories.', '[data-testid="policy-scope"]');
    }
    if (!this.rule) return at('Select a rule.', '.rule-grid');
    if (!this.decisionAllowed) return at('Allow is only available for the Packages rule.', '[data-testid="policy-decision-invalid"]');
    const body = '[data-testid="policy-rule-body"]';
    switch (this.rule) {
      case 'packages':
        if (this.packageList.length === 0) return at('Add at least one package name.', '#policy-packages');
        if (this.hasIncompleteRange) return at('Each range needs both a start and an end version.', `${body} app-version-constraints`);
        if (hasInvalidVersion(this.versionConstraints, this.ecosystem)) return at('Fix the version marked invalid.', `${body} .is-invalid`);
        return null;
      case 'releaseType':
        return this.chosenReleaseTypes.length > 0 ? null : at('Select at least one release type.', `${body} .rt-list`);
      case 'releaseAge':
        if (!this.tooNewEnabled && !this.unmaintainedEnabled) return at('Select too new, unmaintained, or both.', '#policy-age-new');
        if (!this.releaseAgeIncomplete) return null;
        return at(
          'Enter the number of hours or days.',
          this.tooNewEnabled && this.tooNewHours === 0 ? '[aria-label="Too new within hours"]' : '[aria-label="Unmaintained after days"]'
        );
      case 'vulnerability':
        if (this.cvssMinInvalid) return at('Enter a CVSS score from 0.1 to 10, with at most one decimal.', '#policy-cvss');
        if (this.cveList.some((id) => this.cveError(id))) return at('Fix the CVE ID marked invalid.', '#policy-cves');
        if (this.epssEnabled && this.epssFraction === null) {
          return this.epssMode === 'score'
            ? at('Enter an EPSS score above 0 and at most 100 %.', '[data-testid="epss-score"]')
            : at('Enter an EPSS percentile from 1 to 100.', '[data-testid="epss-percentile"]');
        }
        if (this.cveList.length > 0 || this.cvssMin !== null || this.epssEnabled) return null;
        return at('Add a CVE ID, enter a CVSS score, or set an EPSS threshold.', '#policy-cvss');
      case 'license':
        return this.selectedLicenses.length > 0 ? null : at('Add at least one license.', '#policy-license-search');
      case 'namespace': {
        if (!this.ecosystem) return at('Select one ecosystem for a Namespace protection policy.', '#policy-ecosystem');
        if (this.reservedNamespaces.length === 0) return at('Add at least one package name.', '#ns-reserved-input');
        const error = this.namespaceErrors[0];
        if (!error) return null;
        return at(error, error === NO_REMOTE_TICKED ? '[data-testid="ns-remotes"]' : '#ns-reserved-input');
      }
      case 'scorecard': {
        const error = this.scorecardError;
        if (!error) return null;
        const inChecks = !this.scorecardMinScoreInvalid && this.scorecardChecks.length > 0;
        return at(error, inChecks ? ADVANCED_CHECKS : '#policy-scorecard-min');
      }
      default:
        return at('Select a rule.', '.rule-grid');
    }
  }

  canSave(): boolean {
    return this.saveBlocker() === '';
  }

  buildConditions(): PolicyConditions {
    const conditions: PolicyConditions = {};
    if (this.ecosystem) conditions.ecosystem = [this.ecosystem];
    switch (this.rule) {
      case 'packages': {
        conditions.packageBlockList = this.packageList;
        const range = this.buildVersionRange();
        if (range) conditions.versionRange = range;
        break;
      }
      case 'releaseType':
        conditions.releaseTypes = this.chosenReleaseTypes.map((info) => info.id);
        break;
      case 'releaseAge':
        if (this.tooNewEnabled) conditions.releaseAgeMaxHours = this.tooNewHours;
        if (this.unmaintainedEnabled) conditions.releaseAgeMinDays = this.unmaintainedDays;
        break;
      case 'vulnerability':
        if (this.cveList.length) conditions.cveBlockList = this.cveList;
        if (this.cvssMin !== null) {
          conditions.cvssMin = this.cvssMin;
          if (this.cvssUnknown === 'match') conditions.cvssUnknown = 'match';
        }
        if (this.epssFraction !== null) {
          if (this.epssMode === 'score') conditions.epssMin = this.epssFraction;
          else conditions.epssPercentileMin = this.epssFraction;
          if (this.epssUnknown === 'ignore') conditions.epssUnknown = 'ignore';
        }
        break;
      case 'license':
        if (this.licenseMode === 'allow') {
          conditions.licenseAllowList = [...this.selectedLicenses];
          if (this.allowUnknownLicense) conditions.allowUnknownLicense = true;
        } else {
          conditions.licenseDenyList = [...this.selectedLicenses];
        }
        break;
      case 'namespace':
        conditions.reservedNamespaces = [...this.reservedNamespaces];
        if (this.publicPackages.length) conditions.publicPackages = [...this.publicPackages];
        if (this.allowedRemotes.length) conditions.allowedRemotes = [...this.allowedRemotes];
        break;
      case 'scorecard':
        if (this.scorecardMinScore !== null) conditions.scorecardMinScore = this.scorecardMinScore;
        if (this.scorecardCheckList.length) conditions.scorecardChecks = this.scorecardCheckList;
        if (this.scorecardUnknown === 'block') conditions.scorecardUnknown = 'block';
        if (this.scorecardUnavailable === 'block') conditions.scorecardUnavailable = 'block';
        break;
    }
    return conditions;
  }

  save(): void {
    // The button is disabled until the policy can be saved.
    if (!this.canSave()) return;
    const payload = this.payload();

    this.saving = true;
    const request = this.editing ? this.policyService.update(this.id, payload) : this.policyService.create(payload);
    request.subscribe({
      next: (saved: Partial<Policy> & { recheck?: boolean }) => {
        const done = this.editing ? 'Policy updated' : 'Policy created';
        this.toast.success(saved?.recheck ? `${done}. Recorded downloads are being rechecked.` : done);
        this.saved = true;
        void this.router.navigateByUrl(this.returnUrl);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? (this.editing ? 'Update failed' : 'Create failed'));
      },
      complete: () => (this.saving = false),
    });
  }
}

/** Only a path inside the app, never another site. */
export function safeReturnUrl(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/policies';
}

/** Each value once, in first-seen order. */
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** A Scorecard score from 0 to 10, or null. */
function scoreOf(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
}

function positiveInt(value: string): number {
  const n = parseInt(value, 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** `A`, `A or B`, `A, B or C`. */
function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}
