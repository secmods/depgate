import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { Policy, PolicyConditions } from '../../services/policy.service';
import { NamespaceCollision, NamespaceService } from '../../services/namespace.service';
import { MODAL_DATA } from '../../tokens';
import { StatusPillComponent } from '../../shared/status-pill.component';
import { ApprovedPackagesComponent } from '../monitoring/approved-packages.component';
import { MonitorActionsService } from '../monitoring/monitor-actions.service';
import { daysSince, plural } from '../monitoring/monitoring';
import { ecosystemLabel, statusLabel } from '../../shared/status';
import {
  PolicyRule,
  RELEASE_TYPES,
  ReleaseTypeInfo,
  cvssText,
  epssText,
  formatScore,
  releaseTypeApplies,
  releaseTypeExamples,
  ruleInfo,
  rulesOf,
  scorecardCheckDescription,
  stableExamples,
  versionText,
} from './policy-rules';

@Component({
  selector: 'app-policy-view-dialog',
  standalone: true,
  imports: [CommonModule, StatusPillComponent, ApprovedPackagesComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ policy.name }}</h5>
        <p class="dg-dialog-description">{{ policy.description || 'Priority ' + policy.priority + ' · ' + (policy.isEnabled ? 'Enforced' : 'Disabled') }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">

      <div class="dg-banner" [ngClass]="'dg-banner-' + decisionKey">
        <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ decisionIcon }}</span>
        <div class="min-w-0">
          <div class="dg-banner-name">{{ decisionLabel }}{{ monitoring ? ' · monitor only' : '' }}</div>
          <p class="dg-banner-copy">
            {{ monitoring ? 'Blocks nothing yet. Records the downloads it would block.' : 'Applies to package versions that match the rule below.' }}
          </p>
        </div>
      </div>

      @if (monitoring) {
        <div class="dg-callout mb-3" data-testid="view-monitoring">
          <span class="material-symbols-outlined" aria-hidden="true">visibility</span>
          <div>
            Monitoring since {{ policy.modeChangedAt | date: 'MMM d, y' }} ({{ plural(days, 'day') }}).
            <button type="button" class="btn btn-link p-0 align-baseline" (click)="openReport()">Open the report</button> to see what it would block.
          </div>
        </div>
      }

      <p class="dg-section-label">Scope</p>
      <div class="dg-detail-list mb-3">
        <div class="dg-detail-row">
          <div class="dg-detail-label">Ecosystem</div>
          <div class="dg-detail-value">
            @if (ecosystemList.length) {
              @for (e of ecosystemList; track $index) {
                <span class="dg-chip">{{ label(e) }}</span>
              }
            } @else {
              <span class="dg-empty">All</span>
            }
          </div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Repositories</div>
          <div class="dg-detail-value" data-testid="view-scope">
            @for (ref of policy.repositories ?? []; track ref.id) {
              <span class="dg-chip dg-chip-accent">{{ ref.ecosystem }}/{{ ref.key }}</span>
            }
            @if ((policy.repositoryIds ?? []).length > (policy.repositories ?? []).length) {
              <span class="dg-chip dg-chip-warning">Deleted repository</span>
            }
            @if (!(policy.repositoryIds ?? []).length) {
              <span class="dg-empty">All repositories</span>
            }
          </div>
        </div>
      </div>

      @if (rules.length > 1) {
        <div class="dg-callout is-warning mb-3">
          <span class="material-symbols-outlined" aria-hidden="true">warning</span>
          <div>This policy has several rules, and all must match. Edit it to keep one, and create a policy for each of the others.</div>
        </div>
      }

      @for (rule of rules; track rule) {
        <p class="dg-section-label">Rule · {{ ruleLabel(rule) }}</p>
        <div class="dg-detail-list mb-3">
          @switch (rule) {
            @case ('packages') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">Package names</div>
                <div class="dg-detail-value">
                  @for (p of packageList; track $index) { <span class="dg-chip">{{ p }}</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Versions</div>
                <div class="dg-detail-value">
                  @if (versionSummary !== 'Any version') {
                    <span class="dg-chip">{{ versionSummary }}</span>
                  } @else {
                    <span class="dg-empty">Any version</span>
                  }
                </div>
              </div>
            }
            @case ('releaseType') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">Release types</div>
                <div class="dg-detail-value">
                  @for (t of releaseTypeList; track t.id) { <span class="dg-chip dg-chip-accent">{{ t.label }}</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Matches, e.g.</div>
                <div class="dg-detail-value d-flex flex-wrap gap-1">
                  @for (v of matchedExamples; track v) { <span class="dg-tag">{{ v }}</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Stays allowed, e.g.</div>
                <div class="dg-detail-value d-flex flex-wrap gap-1">
                  @for (v of stableExampleList; track v) { <span class="dg-tag">{{ v }}</span> }
                </div>
              </div>
            }
            @case ('releaseAge') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">Release age</div>
                <div class="dg-detail-value">
                  @for (part of releaseAgeParts; track $index) { <span class="dg-chip dg-chip-accent">{{ part }}</span> }
                </div>
              </div>
            }
            @case ('vulnerability') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">CVE IDs</div>
                <div class="dg-detail-value">
                  @if (cveList.length) {
                    @for (cve of cveList; track $index) { <span class="dg-chip dg-chip-danger">{{ cve }}</span> }
                  } @else {
                    <span class="dg-empty">None</span>
                  }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">CVSS score</div>
                <div class="dg-detail-value" data-testid="view-cvss">
                  @if (cvssSummary) {
                    <span class="dg-chip dg-chip-warning">{{ cvssSummary }}</span>
                    <span class="dg-form-help ms-1">{{ conditions['cvssUnknown'] === 'match' ? 'No score or severity: matches' : 'No score or severity: ignored' }}</span>
                  } @else {
                    <span class="dg-empty">Any</span>
                  }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Exploit likelihood</div>
                <div class="dg-detail-value" data-testid="view-epss">
                  @if (epssSummary) {
                    <span class="dg-chip dg-chip-danger">{{ epssSummary }}</span>
                    <span class="dg-form-help ms-1">{{ conditions['epssUnknown'] === 'ignore' ? 'Vulnerabilities without EPSS: ignored' : 'Vulnerabilities without EPSS: blocked' }}</span>
                  } @else {
                    <span class="dg-empty">Any</span>
                  }
                </div>
              </div>
            }
            @case ('license') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">{{ allowOnlyLicenses ? 'Approved licenses' : 'Banned licenses' }}</div>
                <div class="dg-detail-value">
                  @for (lic of licenseList; track $index) {
                    <span class="dg-chip" [class.dg-chip-success]="allowOnlyLicenses" [class.dg-chip-warning]="!allowOnlyLicenses">{{ lic }}</span>
                  }
                </div>
              </div>
              @if (allowOnlyLicenses) {
                <div class="dg-detail-row">
                  <div class="dg-detail-label">Packages without a license</div>
                  <div class="dg-detail-value">{{ allowUnknownLicense ? 'Allowed' : 'Blocked' }}</div>
                </div>
              }
            }
            @case ('namespace') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">Reserved namespaces</div>
                <div class="dg-detail-value" data-testid="view-reserved">
                  @for (p of listOf('reservedNamespaces'); track p) { <span class="dg-chip dg-chip-accent">{{ p }}</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Public on purpose</div>
                <div class="dg-detail-value">
                  @for (p of listOf('publicPackages'); track p) { <span class="dg-chip">{{ p }}</span> }
                  @if (listOf('publicPackages').length === 0) { <span class="dg-empty">None</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Served from</div>
                <div class="dg-detail-value" data-testid="view-served-from">
                  @if (listOf('allowedRemotes').length) {
                    Only the {{ listOf('allowedRemotes').length === 1 ? 'remote' : listOf('allowedRemotes').length + ' remotes' }} the policy allows. Other remotes are never asked about these names.
                  } @else {
                    Internal remotes only. Public remotes are never asked about these names.
                  }
                </div>
              </div>
            }
            @case ('scorecard') {
              <div class="dg-detail-row">
                <div class="dg-detail-label">Overall score</div>
                <div class="dg-detail-value" data-testid="view-scorecard-min">
                  @if (scorecardMin !== null) { <span class="dg-chip dg-chip-accent">At least {{ score(scorecardMin) }}</span> }
                  @else { <span class="dg-empty">Not set</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Checks</div>
                <div class="dg-detail-value" data-testid="view-scorecard-checks">
                  @for (c of scorecardChecks; track c.name) { <span class="dg-chip" [title]="checkDescription(c.name)">{{ c.name }} at least {{ score(c.minScore) }}</span> }
                  @if (scorecardChecks.length === 0) { <span class="dg-empty">None</span> }
                </div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Packages without a Scorecard</div>
                <div class="dg-detail-value">{{ conditions['scorecardUnknown'] === 'block' ? 'Blocked' : 'Allowed' }}</div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Scorecard unreachable</div>
                <div class="dg-detail-value">{{ conditions['scorecardUnavailable'] === 'block' ? 'Blocked' : 'Allowed' }}</div>
              </div>
              <div class="dg-detail-row">
                <div class="dg-detail-label">Applies to</div>
                <div class="dg-detail-value">Repositories whose remotes are all public. Repositories with an internal remote are skipped.</div>
              </div>
            }
          }
        </div>
      }

      @if (rules.includes('namespace')) {
        <p class="dg-section-label">Namespace collisions</p>
        <div data-testid="view-collisions">
          @if (collisions === null) {
            <span class="dg-form-help">Loading…</span>
          } @else if (collisions.length === 0) {
            <span class="dg-form-help">None found. The daily check runs only when Namespace collision check is on in Settings → Repositories → Gateway security.</span>
          } @else {
            <div class="dg-callout is-warning mb-2">
              <span class="material-symbols-outlined" aria-hidden="true">warning</span>
              <div>These reserved names also exist on a public registry. This policy protects builds that use DepGate; make sure nothing installs around it.</div>
            </div>
            <div class="dg-detail-list mb-3">
              @for (c of collisions; track c.id) {
                <div class="dg-detail-row">
                  <div class="dg-detail-label"><span class="font-mono">{{ c.name }}</span></div>
                  <div class="dg-detail-value">
                    @if (c.publicLatestVersion) { <span class="dg-chip dg-chip-danger">public {{ c.publicLatestVersion }}</span> }
                    <span class="dg-form-help">first seen {{ c.firstSeenAt | date: 'medium' }}</span>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }

      <div class="dg-meta-grid">
        <div class="dg-meta-card">
          <div class="dg-meta-label">Priority</div>
          <div class="dg-meta-value">{{ policy.priority }}</div>
        </div>
        <div class="dg-meta-card">
          <div class="dg-meta-label">Status</div>
          <div>
            @if (!policy.isEnabled) {
              <app-status-pill value="DISABLED" label="Disabled" />
            } @else if (monitoring) {
              <app-status-pill value="monitoring" label="Monitoring" tone="info" />
            } @else {
              <app-status-pill value="ENABLED" label="Enforced" />
            }
          </div>
        </div>
      </div>

      @if (policy.decision === 'BLOCK') {
        <div class="mt-3">
          <app-approved-packages [policyId]="policy.id" />
        </div>
      }

    </div>
    <div class="modal-footer">
      @if (monitoring) {
        <button type="button" class="dg-btn dg-btn-secondary dg-footer-start" (click)="restart()" data-testid="view-restart">Restart monitoring</button>
      }
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Close</button>
      @if (monitoring) {
        <button type="button" class="dg-btn dg-btn-primary" (click)="enforce()" data-testid="view-enforce">Enforce…</button>
      }
    </div>
  `,
})

export class PolicyViewDialogComponent {
  policy: Policy = (inject(MODAL_DATA) as { policy: Policy }).policy;
  activeModal = inject(NgbActiveModal);
  /** Internal namespace policies: reserved names found on the public registry; null while loading. */
  collisions: NamespaceCollision[] | null = null;
  private namespaces = inject(NamespaceService);

  constructor() {
    if (this.rules.includes('namespace')) {
      this.namespaces.collisions(this.policy.id).subscribe({
        next: (rows) => (this.collisions = rows),
        error: () => (this.collisions = []),
      });
    }
  }

  listOf(field: 'reservedNamespaces' | 'publicPackages' | 'allowedRemotes'): string[] {
    const raw = this.conditions[field];
    return Array.isArray(raw) ? raw.map(String) : [];
  }
  private actions = inject(MonitorActionsService);
  private router = inject(Router);
  readonly plural = plural;

  get monitoring(): boolean {
    return this.policy.mode === 'monitor' && this.policy.decision === 'BLOCK';
  }

  get days(): number {
    return daysSince(this.policy.modeChangedAt);
  }

  openReport(): void {
    this.activeModal.close('report');
    this.router.navigate(['/monitoring', this.policy.id]);
  }

  async enforce(): Promise<void> {
    if (await this.actions.enforce(this.policy)) this.activeModal.close('changed');
  }

  async restart(): Promise<void> {
    if (await this.actions.restart(this.policy)) this.policy = { ...this.policy, modeChangedAt: new Date().toISOString() };
  }

  get epssSummary(): string {
    return epssText(this.conditions as PolicyConditions);
  }

  get scorecardMin(): number | null {
    const raw = this.conditions['scorecardMinScore'];
    return typeof raw === 'number' ? raw : null;
  }

  get scorecardChecks(): Array<{ name: string; minScore: number }> {
    const raw = this.conditions['scorecardChecks'];
    return Array.isArray(raw) ? (raw as Array<{ name: string; minScore: number }>) : [];
  }

  score(value: number): string {
    return formatScore(value);
  }

  checkDescription(name: string): string {
    return scorecardCheckDescription(name);
  }

  get conditions(): Record<string, unknown> {
    let c = this.policy?.conditions;
    if (typeof c === 'string') {
      try {
        c = JSON.parse(c) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    if (!c || typeof c !== 'object') return {};
    return c as Record<string, unknown>;
  }

  get ecosystemList(): string[] {
    const raw = this.conditions['ecosystem'];
    return Array.isArray(raw) ? raw.map(String) : [];
  }

  get packageList(): string[] {
    const raw = this.conditions['packageBlockList'];
    return Array.isArray(raw) ? raw.map(String) : [];
  }

  get versionSummary(): string {
    const r = this.conditions['versionRange'];
    return versionText(typeof r === 'string' ? r : '');
  }

  get rules(): PolicyRule[] {
    return rulesOf(this.conditions);
  }

  ruleLabel(rule: PolicyRule): string {
    return ruleInfo(rule).label;
  }

  private get ecosystem(): string {
    return this.ecosystemList[0] ?? '';
  }

  get releaseTypeList(): ReleaseTypeInfo[] {
    const raw = this.conditions['releaseTypes'];
    const chosen = Array.isArray(raw) ? raw.map(String) : [];
    return RELEASE_TYPES.filter((info) => chosen.includes(info.id) && releaseTypeApplies(info, this.ecosystem));
  }

  get matchedExamples(): string[] {
    return this.releaseTypeList.flatMap((info) => releaseTypeExamples(info, this.ecosystem).slice(0, 2));
  }

  get stableExampleList(): string[] {
    return stableExamples(this.ecosystem);
  }

  get cveList(): string[] {
    const raw = this.conditions['cveBlockList'];
    return Array.isArray(raw) ? raw.map(String) : [];
  }

  /** "CVSS ≥ 7.0", empty without a CVSS minimum. */
  get cvssSummary(): string {
    return cvssText(this.conditions as PolicyConditions);
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  get decisionLabel(): string {
    return statusLabel(this.policy.decision);
  }

  get decisionKey(): string {
    return this.policy.decision === 'ALLOW' ? 'allow' : 'block';
  }

  get decisionIcon(): string {
    if (this.policy.decision === 'ALLOW') return 'check_circle';
    return 'block';
  }

  get releaseAgeParts(): string[] {
    const parts: string[] = [];
    const minDays = this.conditions['releaseAgeMinDays'];
    const maxHours = this.conditions['releaseAgeMaxHours'];
    if (typeof minDays === 'number' && minDays > 0) {
      parts.push(`No release in ${minDays} ${minDays === 1 ? 'day' : 'days'}`);
    }
    if (typeof maxHours === 'number' && maxHours > 0) {
      parts.push(`Newer than ${maxHours} ${maxHours === 1 ? 'hour' : 'hours'}`);
    }
    return parts;
  }

  get allowUnknownLicense(): boolean {
    return this.conditions['allowUnknownLicense'] === true;
  }

  /** Allow-only license policies list approved licenses; block policies list banned ones. */
  get allowOnlyLicenses(): boolean {
    const raw = this.conditions['licenseAllowList'];
    return Array.isArray(raw) && raw.length > 0;
  }

  get licenseList(): string[] {
    const raw = this.conditions[this.allowOnlyLicenses ? 'licenseAllowList' : 'licenseDenyList'];
    return Array.isArray(raw) ? raw.map(String) : [];
  }
}
