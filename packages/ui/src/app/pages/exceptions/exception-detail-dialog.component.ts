import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { ExceptionEntry, ExceptionService } from '../../services/exception.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { ecosystemLabel } from '../../shared/status';
import { MODAL_DATA } from '../../tokens';

@Component({
  selector: 'app-exception-detail-dialog',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ entry.packageName }}</h5>
        <p class="dg-dialog-description">{{ ecosystem }} · {{ entry.version || '*' }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-banner" [class]="'dg-banner ' + (expired ? 'dg-banner-neutral' : 'dg-banner-allow')">
        <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ expired ? 'history' : 'check_circle' }}</span>
        <div class="min-w-0">
          <div class="dg-banner-name">{{ expired ? 'Expired' : 'Active' }}</div>
          <p class="dg-banner-copy">
            {{ expired ? 'This exception no longer applies. Policies decide again.' : 'Matching versions are allowed until the exception expires.' }}
          </p>
        </div>
      </div>

      <div class="dg-detail-list">
        <div class="dg-detail-row">
          <div class="dg-detail-label">Versions</div>
          <div class="dg-detail-value"><span class="dg-chip">{{ entry.version && entry.version !== '*' ? entry.version : 'All versions' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Applies to</div>
          <div class="dg-detail-value">
            <span class="dg-detail-text">{{ entry.policyId ? 'Policy "' + (entry.policyName || entry.policyId) + '" only' : 'Every policy' }}</span>
          </div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Repositories</div>
          <div class="dg-detail-value" data-testid="exception-detail-scope">
            @for (ref of entry.repositories ?? []; track ref.id) {
              <span class="dg-chip dg-chip-accent">{{ ref.ecosystem }}/{{ ref.key }}</span>
            } @empty {
              <span class="dg-detail-text">All repositories</span>
            }
          </div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Expires</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ entry.expiresAt | date: 'medium' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Approved by</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ entry.approvedBy || '—' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Created</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ entry.createdAt | date: 'medium' }}</span></div>
        </div>
        <div class="dg-detail-row is-stacked">
          <div class="dg-detail-label">Reason</div>
          <div class="dg-detail-value dg-detail-prose">
            @if (entry.reason) { {{ entry.reason }} } @else { <span class="dg-empty">None given</span> }
          </div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      @if (canRevoke) {
        <button type="button" class="dg-btn dg-btn-danger-outline dg-footer-start" (click)="revoke()" [disabled]="submitting">Revoke</button>
      }
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Close</button>
    </div>
  `,
})
export class ExceptionDetailDialogComponent {
  activeModal = inject(NgbActiveModal);
  private data = inject(MODAL_DATA) as { entry: ExceptionEntry; canRevoke?: boolean };
  private exceptionService = inject(ExceptionService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  entry = this.data.entry;
  canRevoke = this.data.canRevoke === true;
  submitting = false;

  get expired(): boolean {
    return new Date(this.entry.expiresAt) <= new Date();
  }

  get ecosystem(): string {
    return ecosystemLabel(this.entry.ecosystem);
  }

  async revoke(): Promise<void> {
    if (this.submitting || !this.canRevoke) return;
    const ok = await this.confirm.confirm({
      title: 'Revoke exception?',
      message: `${this.entry.packageName} will be evaluated by policy again right away.`,
      confirmText: 'Revoke',
    });
    if (!ok) return;
    this.submitting = true;
    this.exceptionService.delete(this.entry.id).subscribe({
      next: () => this.activeModal.close('revoked'),
      error: (err) => {
        this.submitting = false;
        this.toast.error(err.error?.error ?? 'Revoke failed');
      },
    });
  }
}
