import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { ExceptionService } from '../../services/exception.service';
import { ToastService } from '../../services/toast.service';
import { ECOSYSTEMS, ecosystemLabel } from '../../shared/status';
import { VersionConstraintsComponent } from '../../shared/version-constraints.component';
import { PackagePrefill, WaiverVersionConstraint, buildVersion, hasInvalidVersion, parseVersion } from '../waivers/waiver-version';
import { toDatetimeLocal } from '../waivers/request-waiver-dialog.component';
import { MODAL_DATA } from '../../tokens';
import { RepositoryScopeComponent } from '../../shared/repository-scope.component';

@Component({
  selector: 'app-add-exception-dialog',
  standalone: true,
  imports: [FormsModule, VersionConstraintsComponent, RepositoryScopeComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Add exception</h5>
        <p class="dg-dialog-description">Allows the package despite policy until the expiry date.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-field">
        <label class="form-label" for="exception-ecosystem">Ecosystem</label>
        <select id="exception-ecosystem" class="form-select" [(ngModel)]="ecosystem" required>
          @for (e of ecosystems; track e) {
            <option [value]="e">{{ label(e) }}</option>
          }
        </select>
      </div>
      <div class="dg-field">
        <label class="form-label" for="exception-package-name">Package name</label>
        <input id="exception-package-name" class="form-control" [(ngModel)]="packageName" required autocomplete="off" />
      </div>
      <div class="dg-field">
        <label class="form-label">Versions <span class="dg-optional">(optional)</span></label>
        <app-version-constraints [constraints]="versionConstraints" idPrefix="exception" [ecosystem]="ecosystem" />
      </div>
      <app-repository-scope idPrefix="exception" [ecosystems]="[ecosystem]" [selectedIds]="repositoryIds"
        [prefillKey]="prefillKey" (selectedIdsChange)="repositoryIds = $event" (modeChange)="scopeMode = $event"
        help="Limit the exception to some repositories, or let the package through everywhere." />
      <div class="dg-field">
        <label class="form-label" for="exception-expires">Expires</label>
        <input id="exception-expires" type="datetime-local" class="form-control" [(ngModel)]="expiresAtStr" required />
        @if (expiresAtStr && !futureExpiry()) {
          <span class="dg-form-help text-danger">Choose a date in the future.</span>
        }
      </div>
      <div class="dg-field">
        <label class="form-label" for="exception-reason">Reason <span class="dg-optional">(optional)</span></label>
        <textarea id="exception-reason" class="form-control" [(ngModel)]="reason" rows="2"
          placeholder="Why is this package needed? Recorded in the Decision Ledger."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="submit()" [disabled]="submitting || !valid()">
        {{ submitting ? 'Creating…' : 'Create' }}
      </button>
    </div>
  `,
})
export class AddExceptionDialogComponent {
  activeModal = inject(NgbActiveModal);
  private data = inject(MODAL_DATA) as { ecosystems: string[]; prefill?: PackagePrefill } | null;
  private exceptionService = inject(ExceptionService);
  private toast = inject(ToastService);

  ecosystems: string[] = this.data?.ecosystems ?? [...ECOSYSTEMS];
  ecosystem = this.data?.prefill?.ecosystem ?? 'npm';
  packageName = this.data?.prefill?.packageName ?? '';
  versionConstraints: WaiverVersionConstraint[] = parseVersion(this.data?.prefill?.version);
  expiresAtStr = '';
  reason = '';
  repositoryIds: string[] = [];
  scopeMode: 'all' | 'selected' = 'all';
  prefillKey = this.data?.prefill?.repository ?? '';
  submitting = false;

  constructor() {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    this.expiresAtStr = toDatetimeLocal(d);
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  futureExpiry(): boolean {
    const d = new Date(this.expiresAtStr);
    return !isNaN(d.getTime()) && d > new Date();
  }

  valid(): boolean {
    if (hasInvalidVersion(this.versionConstraints, this.ecosystem)) return false;
    if (this.scopeMode === 'selected' && this.repositoryIds.length === 0) return false;
    return !!this.ecosystem && !!this.packageName.trim() && !!this.expiresAtStr.trim() && this.futureExpiry();
  }

  submit(): void {
    if (!this.valid() || this.submitting) return;
    this.submitting = true;
    this.exceptionService
      .create({
        packageName: this.packageName.trim(),
        ecosystem: this.ecosystem,
        version: buildVersion(this.versionConstraints),
        expiresAt: new Date(this.expiresAtStr).toISOString(),
        reason: this.reason.trim() || undefined,
        repositoryIds: this.repositoryIds,
      })
      .subscribe({
        next: () => this.activeModal.close(true),
        error: (err) => {
          this.submitting = false;
          this.toast.error(err.error?.error ?? 'Could not create the exception');
        },
      });
  }
}
