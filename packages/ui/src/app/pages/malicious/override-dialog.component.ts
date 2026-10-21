import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MaliciousService, MaliciousPackage } from '../../services/malicious.service';
import { ToastService } from '../../services/toast.service';
import { ecosystemLabel } from '../../shared/status';
import { MODAL_PKG } from '../../tokens';

@Component({
  selector: 'app-override-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Change decision</h5>
        <p class="dg-dialog-description">{{ pkg?.name }} · {{ ecosystem }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-banner" [class]="'dg-banner ' + (allowed ? 'dg-banner-allow' : 'dg-banner-block')">
        <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ allowed ? 'check_circle' : 'block' }}</span>
        <div class="min-w-0">
          <div class="dg-banner-name">Currently {{ allowed ? 'allowed' : 'blocked' }}</div>
          <p class="dg-banner-copy">
            {{ allowed ? 'Blocking restores the malware rule for this package.' : 'Allowing bypasses the malware rule. Your reason is recorded.' }}
          </p>
        </div>
      </div>
      @if (!allowed) {
        <div class="dg-field">
          <label class="form-label" for="override-reason">Justification</label>
          <textarea id="override-reason" class="form-control" [(ngModel)]="overrideReason" rows="3"
            placeholder="e.g. False positive confirmed by the security team"></textarea>
        </div>
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      @if (allowed) {
        <button type="button" class="dg-btn dg-btn-danger" (click)="submit('BLOCK')" [disabled]="saving">Block package</button>
      } @else {
        <button type="button" class="dg-btn dg-btn-success" (click)="submit('ALLOW')" [disabled]="saving || !overrideReason.trim()">Allow package</button>
      }
    </div>
  `,
})
export class OverrideDialogComponent {
  pkg = inject(MODAL_PKG, { optional: true }) as MaliciousPackage | null;
  overrideReason = this.pkg?.overrideReason ?? '';
  saving = false;

  activeModal = inject(NgbActiveModal);
  private malicious = inject(MaliciousService);
  private toast = inject(ToastService);

  get allowed(): boolean {
    return this.pkg?.overrideStatus === 'ALLOW';
  }

  get ecosystem(): string {
    return ecosystemLabel(this.pkg?.ecosystem);
  }

  submit(status: 'BLOCK' | 'ALLOW'): void {
    if (!this.pkg || this.saving) return;
    const reason = status === 'ALLOW' ? this.overrideReason.trim() : undefined;
    if (status === 'ALLOW' && !reason) return;
    this.saving = true;
    this.malicious.setOverride(this.pkg.id, status, reason).subscribe({
      next: () => {
        this.toast.success(status === 'ALLOW' ? `${this.pkg?.name} is now allowed` : `${this.pkg?.name} is now blocked`);
        this.activeModal.close(true);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Update failed');
      },
    });
  }
}
