import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MaliciousPackage } from '../../services/malicious.service';
import { ecosystemLabel } from '../../shared/status';
import { MODAL_PKG } from '../../tokens';

@Component({
  selector: 'app-malicious-view-dialog',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ pkg?.name }}</h5>
        <p class="dg-dialog-description">{{ ecosystem }} · {{ pkg?.source === 'custom' ? 'Custom entry' : 'Threat feed' }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-banner" [class]="'dg-banner ' + (allowed ? 'dg-banner-allow' : 'dg-banner-block')">
        <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ allowed ? 'check_circle' : 'block' }}</span>
        <div class="min-w-0">
          <div class="dg-banner-name">{{ allowed ? 'Allowed' : 'Blocked' }}</div>
          <p class="dg-banner-copy">{{ allowed ? 'An override lets this package through.' : 'Downloads of matching versions are rejected.' }}</p>
        </div>
      </div>

      <div class="dg-detail-list">
        <div class="dg-detail-row">
          <div class="dg-detail-label">Versions</div>
          <div class="dg-detail-value"><span class="dg-chip">{{ pkg?.versionRange?.trim() || 'All versions' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Advisory</div>
          <div class="dg-detail-value"><span class="dg-detail-text font-mono">{{ pkg?.reason || '—' }}</span></div>
        </div>
        @if (pkg?.sourceUrl) {
          <div class="dg-detail-row">
            <div class="dg-detail-label">Reference</div>
            <div class="dg-detail-value">
              <a class="dg-detail-text" [href]="$safeNavigationMigration(pkg?.sourceUrl)" target="_blank" rel="noopener noreferrer">Open advisory</a>
            </div>
          </div>
        }
        <div class="dg-detail-row">
          <div class="dg-detail-label">Added</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ $safeNavigationMigration(pkg?.createdAt) | date: 'medium' }}</span></div>
        </div>
        @if (pkg?.overrideReason) {
          <div class="dg-detail-row is-stacked">
            <div class="dg-detail-label">Override justification</div>
            <div class="dg-detail-value dg-detail-prose">{{ pkg?.overrideReason }}</div>
          </div>
        }
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Close</button>
    </div>
  `,
})
export class MaliciousViewDialogComponent {
  pkg = inject(MODAL_PKG, { optional: true }) as MaliciousPackage | null;
  activeModal = inject(NgbActiveModal);

  get allowed(): boolean {
    return this.pkg?.overrideStatus === 'ALLOW';
  }

  get ecosystem(): string {
    return ecosystemLabel(this.pkg?.ecosystem);
  }
}
