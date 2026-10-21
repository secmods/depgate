import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MonitorPackage, MonitorPolicy, MonitorService } from '../../services/monitor.service';
import { ToastService } from '../../services/toast.service';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { MODAL_DATA } from '../../tokens';
import {
  APPROVAL_MAX_LENGTH,
  ApprovalChoice,
  approvalChoices,
  approvalVersions,
  defaultExpiry,
  listTooLong,
  plural,
  policyRule,
} from './monitoring';

export interface ApproveDialogData {
  policy: MonitorPolicy;
  packages: MonitorPackage[];
}

const CHOICE_LABELS: Record<ApprovalChoice, string> = {
  matched: 'The versions downloaded',
  range: 'From the lowest to the highest version downloaded',
  all: 'All versions, including future ones',
};

/** Approve packages for one policy: a policy-scoped exception per package (MON-E2–E4). */
@Component({
  selector: 'app-approve-dialog',
  standalone: true,
  imports: [FormsModule, EcoTagComponent],
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ packages.length === 1 ? 'Approve ' + packages[0].packageName : 'Approve ' + plural(packages.length, 'package') }}</h5>
        <p class="dg-dialog-description">
          Approved versions keep installing when "{{ policy.name }}" is enforced. Other policies still apply.
        </p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      @if (packages.length > 1) {
        <div class="approve-list mb-3">
          @for (pkg of packages; track pkg.ecosystem + pkg.packageName) {
            <span class="dg-chip">{{ pkg.packageName }}</span>
          }
        </div>
      }

      <fieldset class="dg-field">
        <legend class="form-label">Versions</legend>
        <div class="d-flex flex-column gap-2" role="radiogroup" aria-label="Versions to approve">
          @for (option of choices; track option) {
            <label class="form-check" [attr.data-testid]="'approve-scope-' + option">
              <input type="radio" class="form-check-input" name="approve-scope" [value]="option" [(ngModel)]="choice"
                [disabled]="option === 'matched' && tooLong.length > 0 && tooLong.length === packages.length && choices.length > 1" />
              <span class="form-check-label">
                {{ choiceLabel(option) }}
                @if (packages.length === 1) {
                  <span class="dg-text-muted">· {{ preview(packages[0], option) }}</span>
                }
              </span>
            </label>
          }
        </div>
        @if (choice === 'matched' && tooLong.length) {
          <span class="dg-form-help text-danger d-block mt-2" data-testid="approve-too-long">
            {{ tooLongMessage }}
          </span>
        }
        @if (onlyVersions) {
          <span class="dg-form-help d-block mt-2">A vulnerability approval lists versions, so a future vulnerable release is not let through.</span>
        }
      </fieldset>

      <div class="dg-field-row" style="grid-template-columns: minmax(0, 220px)">
        <div>
          <label class="form-label" for="approve-expiry">Expires</label>
          <input id="approve-expiry" type="date" class="form-control" [(ngModel)]="expiry" [min]="today" required />
        </div>
      </div>
      <div class="dg-field">
        <label class="form-label" for="approve-reason">Reason</label>
        <textarea id="approve-reason" class="form-control" rows="2" [(ngModel)]="reason" required
          placeholder="Why these packages must keep working"></textarea>
      </div>

      @if (otherPolicies.length) {
        <div class="dg-callout is-warning" data-testid="approve-also-matched">
          <span class="material-symbols-outlined" aria-hidden="true">warning</span>
          <div>
            Also matched by {{ otherPolicies.join(', ') }}, which will still block these packages when enforced.
          </div>
        </div>
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" data-testid="approve-submit" (click)="submit()" [disabled]="!canSubmit">
        {{ saving ? 'Approving…' : 'Approve' }}
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`.approve-list { display: flex; flex-wrap: wrap; gap: 6px; max-height: 120px; overflow-y: auto; }`],
})
export class ApproveDialogComponent {
  activeModal = inject(NgbActiveModal);
  private monitor = inject(MonitorService);
  private toast = inject(ToastService);
  private data = inject(MODAL_DATA) as ApproveDialogData;

  readonly policy = this.data.policy;
  readonly packages = this.data.packages;
  readonly choices: ApprovalChoice[];
  choice: ApprovalChoice;
  expiry = defaultExpiry();
  reason = '';
  saving = false;
  readonly today = new Date().toISOString().slice(0, 10);
  readonly plural = plural;

  constructor() {
    const allowed = approvalChoices(policyRule(this.policy.conditions));
    this.choices = allowed?.choices ?? [];
    let preferred = allowed?.preferred ?? 'matched';
    // When the versions do not fit one approval, the range is the next narrowest choice.
    if (preferred === 'matched' && this.tooLong.length && this.choices.includes('range')) preferred = 'range';
    this.choice = preferred;
  }

  get onlyVersions(): boolean {
    return this.choices.length === 1;
  }

  /** Packages whose downloaded versions do not fit one approval. */
  get tooLong(): MonitorPackage[] {
    return this.packages.filter((pkg) => listTooLong(pkg));
  }

  get tooLongMessage(): string {
    const names = this.tooLong.map((pkg) => pkg.packageName).join(', ');
    const fix = this.choices.includes('range') ? ' Approve the range or all versions instead.' : ' Approve them from the expanded rows in smaller sets.';
    return `${names}: too many versions to list in one approval (${APPROVAL_MAX_LENGTH} characters).${fix}`;
  }

  get otherPolicies(): string[] {
    const names = new Set<string>();
    for (const pkg of this.packages) for (const other of pkg.alsoMatchedBy) names.add(`"${other.policyName}"`);
    return [...names];
  }

  choiceLabel(choice: ApprovalChoice): string {
    return CHOICE_LABELS[choice];
  }

  preview(pkg: MonitorPackage, choice: ApprovalChoice): string {
    if (choice === 'all') return '*';
    if (choice === 'range') return pkg.versionRange ? `${pkg.versionRange.min} – ${pkg.versionRange.max}` : '*';
    return pkg.versionCount === 1 ? pkg.versions[0]?.version ?? '' : plural(pkg.versionCount, 'version');
  }

  get canSubmit(): boolean {
    if (this.saving || !this.reason.trim() || !this.expiry || this.expiry < this.today) return false;
    return !(this.choice === 'matched' && this.tooLong.length > 0);
  }

  submit(): void {
    if (!this.canSubmit) return;
    this.saving = true;
    // End of the chosen day, so "expires on the 9th" includes the 9th.
    const expiresAt = new Date(`${this.expiry}T23:59:59`).toISOString();
    this.monitor
      .approve({
        policyId: this.policy.id,
        items: this.packages.map((pkg) => ({
          ecosystem: pkg.ecosystem,
          packageName: pkg.packageName,
          versions: approvalVersions(pkg, this.choice),
        })),
        expiresAt,
        reason: this.reason.trim(),
      })
      .subscribe({
        next: (res) => {
          this.toast.success(res.items.length === 1 ? `Approved ${res.items[0].packageName}` : `Approved ${plural(res.items.length, 'package')}`);
          this.activeModal.close(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.error ?? 'Approve failed');
        },
      });
  }
}
