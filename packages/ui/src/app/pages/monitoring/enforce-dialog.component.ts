import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MonitorImpact, MonitorService } from '../../services/monitor.service';
import { PolicyService } from '../../services/policy.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';
import { plural, policyRule, reasonLabel } from './monitoring';
import { PolicyConditions } from '../../services/policy.service';

export interface EnforceDialogData {
  policyId: string;
  policyName: string;
  conditions: PolicyConditions;
}

/** What enforcing would block, over everything recorded, then the switch itself (MON-X1). */
@Component({
  selector: 'app-enforce-dialog',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Enforce "{{ data.policyName }}"?</h5>
        <p class="dg-dialog-description">The policy starts blocking. Approved packages keep installing.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      @if (!impact) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else {
        <div class="dg-meta-grid mt-0" data-testid="enforce-impact">
          <div class="dg-meta-card">
            <div class="dg-meta-label">Packages to be blocked</div>
            <div class="dg-meta-value">{{ impact.packagesToBlock | number }}</div>
            <div class="dg-cell-sub">{{ plural(impact.versionsToBlock, 'version') }}</div>
          </div>
          <div class="dg-meta-card">
            <div class="dg-meta-label">Downloads per day</div>
            <div class="dg-meta-value">{{ impact.downloadsPerDay | number: '1.0-1' }}</div>
            <div class="dg-cell-sub">would be refused</div>
          </div>
          <div class="dg-meta-card">
            <div class="dg-meta-label">Approved packages</div>
            <div class="dg-meta-value">{{ impact.approvedPackages | number }}</div>
            @if (impact.partlyApprovedPackages) {
              <div class="dg-cell-sub">{{ impact.partlyApprovedPackages | number }} partly approved</div>
            }
          </div>
          <div class="dg-meta-card">
            <div class="dg-meta-label">Monitored</div>
            <div class="dg-meta-value">{{ plural(impact.daysMonitored, 'day') }}</div>
            @if (impact.monitoringSince) {
              <div class="dg-cell-sub">since {{ impact.monitoringSince | date: 'MMM d, y' }}</div>
            }
          </div>
        </div>

        @if (impact.topReasons.length) {
          <p class="dg-section-label mt-3">Largest reasons</p>
          <ul class="enforce-reasons">
            @for (group of impact.topReasons; track group.reasonKey) {
              <li><span class="dg-cell-primary">{{ label(group.reasonKey) }}</span> <span class="dg-text-muted">· {{ plural(group.packages, 'package') }}</span></li>
            }
          </ul>
        }

        <p class="dg-form-help mt-3 mb-0">
          @if (impact.retentionDays > 0) {
            Counts cover packages downloaded in the last {{ impact.retentionDays }} days.
          } @else {
            Counts cover every package recorded since monitoring started.
          }
          Packages nobody approves are blocked; developers who need one can request a waiver.
        </p>
        @if (impact.packages === 0) {
          <div class="dg-callout is-warning mt-3">
            <span class="material-symbols-outlined" aria-hidden="true">warning</span>
            <div>Nothing downloaded has matched this policy yet, so there is no evidence of what it would block.</div>
          </div>
        }
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" data-testid="enforce-confirm" (click)="enforce()" [disabled]="!impact || saving">
        {{ saving ? 'Enforcing…' : 'Enforce policy' }}
      </button>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`.enforce-reasons { margin: 0; padding-left: 18px; font-size: 0.8125rem; } .enforce-reasons li { margin: 2px 0; }`],
})
export class EnforceDialogComponent implements OnInit {
  activeModal = inject(NgbActiveModal);
  data = inject(MODAL_DATA) as EnforceDialogData;
  private monitor = inject(MonitorService);
  private policies = inject(PolicyService);
  private toast = inject(ToastService);
  impact: MonitorImpact | null = null;
  saving = false;
  readonly plural = plural;

  ngOnInit(): void {
    this.monitor.impact(this.data.policyId).subscribe({
      next: (impact) => (this.impact = impact),
      error: (err) => {
        this.toast.error(err.error?.error ?? 'Failed to load the impact');
        this.activeModal.dismiss();
      },
    });
  }

  label(reasonKey: string): string {
    return reasonLabel(reasonKey, policyRule(this.data.conditions));
  }

  enforce(): void {
    this.saving = true;
    this.policies.update(this.data.policyId, { mode: 'enforce' }).subscribe({
      next: () => {
        this.toast.success(`"${this.data.policyName}" is enforced`);
        this.monitor.refreshCount();
        this.activeModal.close(true);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Enforce failed');
      },
    });
  }
}
