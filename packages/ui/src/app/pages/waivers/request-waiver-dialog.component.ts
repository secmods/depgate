import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { WaiverRequest, WaiverService } from '../../services/waiver.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';
import { PackagePrefill, WaiverVersionConstraint, buildVersion, hasInvalidVersion, parseVersion } from './waiver-version';
import { VersionConstraintsComponent } from '../../shared/version-constraints.component';
import { ECOSYSTEMS, ecosystemLabel } from '../../shared/status';
import { RepositoryScopeComponent } from '../../shared/repository-scope.component';

@Component({
  selector: 'app-request-waiver-dialog',
  standalone: true,
  imports: [FormsModule, VersionConstraintsComponent, RepositoryScopeComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ editing ? 'Edit waiver request' : 'Request waiver' }}</h5>
        <p class="dg-dialog-description">
          {{ editing
            ? 'A rejected request goes back to pending when you save.'
            : 'The package stays blocked until security approves. The reviewer can change the expiry.' }}
        </p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-field">
        <label class="form-label" for="waiver-ecosystem">Ecosystem</label>
        <select id="waiver-ecosystem" class="form-select" [(ngModel)]="ecosystem" required>
          @for (e of ecosystems; track e) {
            <option [value]="e">{{ label(e) }}</option>
          }
        </select>
      </div>
      <div class="dg-field">
        <label class="form-label" for="waiver-package-name">Package name</label>
        <input id="waiver-package-name" class="form-control" [(ngModel)]="packageName" required autocomplete="off" />
      </div>
      <div class="dg-field">
        <label class="form-label">Versions <span class="dg-optional">(optional)</span></label>
        <app-version-constraints [constraints]="versionConstraints" idPrefix="waiver" [ecosystem]="ecosystem" />
      </div>
      <app-repository-scope idPrefix="waiver" [ecosystems]="[ecosystem]" [selectedIds]="repositoryIds"
        [prefillKey]="prefillKey" (selectedIdsChange)="repositoryIds = $event"
        (modeChange)="scopeMode = $event"
        help="Where you need the package. Security may change it when they approve." />
      <div class="dg-field">
        <label class="form-label" for="waiver-expires">Needed until</label>
        <input id="waiver-expires" type="datetime-local" class="form-control" [(ngModel)]="expiresAtStr" required />
        @if (expiresAtStr && !futureExpiry()) {
          <span class="dg-form-help text-danger">Choose a date in the future.</span>
        }
      </div>
      <div class="dg-field">
        <label class="form-label" for="waiver-reason">Reason</label>
        <textarea id="waiver-reason" class="form-control" [(ngModel)]="reason" rows="3" required
          placeholder="What do you need it for, and why is it safe?"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="submit()" [disabled]="submitting || !valid()">
        {{ submitting ? 'Saving…' : (editing ? 'Update' : 'Submit request') }}
      </button>
    </div>
  `,
})
export class RequestWaiverDialogComponent {
  activeModal = inject(NgbActiveModal);
  private data = inject(MODAL_DATA) as { ecosystems: string[]; waiver?: WaiverRequest; prefill?: PackagePrefill };
  private waiverService = inject(WaiverService);
  private toast = inject(ToastService);

  ecosystems: string[] = this.data?.ecosystems ?? [...ECOSYSTEMS];
  editing = this.data?.waiver ?? null;
  ecosystem = this.editing?.ecosystem ?? this.data?.prefill?.ecosystem ?? 'npm';
  packageName = this.editing?.packageName ?? this.data?.prefill?.packageName ?? '';
  versionConstraints: WaiverVersionConstraint[] = parseVersion(this.editing?.version ?? this.data?.prefill?.version);
  expiresAtStr = '';
  reason = this.editing?.reason ?? '';
  repositoryIds: string[] = (this.editing?.repositories ?? []).map((ref) => ref.id);
  scopeMode: 'all' | 'selected' = this.repositoryIds.length ? 'selected' : 'all';
  prefillKey = this.editing ? '' : (this.data?.prefill?.repository ?? '');
  submitting = false;

  constructor() {
    if (this.editing?.requestedExpiresAt) {
      this.expiresAtStr = toDatetimeLocal(new Date(this.editing.requestedExpiresAt));
      return;
    }
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
    if (!this.ecosystem || !this.packageName.trim() || !this.reason.trim() || !this.expiresAtStr.trim()) return false;
    if (hasInvalidVersion(this.versionConstraints, this.ecosystem)) return false;
    if (this.scopeMode === 'selected' && this.repositoryIds.length === 0) return false;
    return this.futureExpiry();
  }

  submit(): void {
    if (!this.valid() || this.submitting) return;
    this.submitting = true;
    const body = {
      packageName: this.packageName.trim(),
      ecosystem: this.ecosystem,
      version: buildVersion(this.versionConstraints),
      expiresAt: new Date(this.expiresAtStr).toISOString(),
      reason: this.reason.trim(),
      repositoryIds: this.repositoryIds,
    };
    const request = this.editing
      ? this.waiverService.update(this.editing.id, body)
      : this.waiverService.create(body);
    request
      .subscribe({
        next: () => this.activeModal.close(true),
        error: (err) => {
          this.submitting = false;
          this.toast.error(err.error?.error ?? 'Request failed');
        },
      });
  }
}

export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

