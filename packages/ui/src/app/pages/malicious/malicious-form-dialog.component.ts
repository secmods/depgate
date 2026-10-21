import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MaliciousService, MaliciousPackage } from '../../services/malicious.service';
import { ToastService } from '../../services/toast.service';
import { ecosystemLabel } from '../../shared/status';
import { VersionConstraintsComponent } from '../../shared/version-constraints.component';
import { WaiverVersionConstraint, buildVersion, hasInvalidVersion, parseVersion } from '../waivers/waiver-version';
import { MODAL_DATA } from '../../tokens';

const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'crates.io', 'rubygems'];

@Component({
  selector: 'app-malicious-form-dialog',
  standalone: true,
  imports: [FormsModule, VersionConstraintsComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ editing ? 'Edit malware entry' : 'Add malware entry' }}</h5>
        <p class="dg-dialog-description">Custom entries block like feed entries.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-field">
        <label class="form-label" for="malicious-ecosystem">Ecosystem</label>
        <select id="malicious-ecosystem" class="form-select" [(ngModel)]="ecosystem" [disabled]="editing">
          @for (e of ecosystems; track e) {
            <option [value]="e">{{ label(e) }}</option>
          }
        </select>
      </div>
      <div class="dg-field">
        <label class="form-label" for="malicious-name">Package name</label>
        <input id="malicious-name" class="form-control" [(ngModel)]="name" [readonly]="editing" autocomplete="off" />
      </div>
      <div class="dg-field">
        <label class="form-label">Versions <span class="dg-optional">(optional)</span></label>
        <app-version-constraints [constraints]="versionConstraints" idPrefix="malicious" [ecosystem]="ecosystem" />
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="save()" [disabled]="saving || !name.trim() || !ecosystem || invalidVersions()">
        {{ saving ? (editing ? 'Updating…' : 'Creating…') : (editing ? 'Update' : 'Create') }}
      </button>
    </div>
  `,
})
export class MaliciousFormDialogComponent {
  editing = false;
  id = '';
  name = '';
  ecosystem = 'npm';
  versionConstraints: WaiverVersionConstraint[] = [];
  ecosystems = ECOSYSTEMS;
  saving = false;

  activeModal = inject(NgbActiveModal);
  private malicious = inject(MaliciousService);
  private toast = inject(ToastService);
  private data = inject(MODAL_DATA, { optional: true }) as { editing: boolean; pkg?: MaliciousPackage } | undefined;

  constructor() {
    this.editing = this.data?.editing === true;
    const pkg = this.data?.pkg;
    if (pkg) {
      this.id = pkg.id;
      this.name = pkg.name;
      this.ecosystem = pkg.ecosystem;
      this.versionConstraints = parseVersion(pkg.versionRange ?? '');
    }
  }

  label(ecosystem: string): string {
    return ecosystemLabel(ecosystem);
  }

  invalidVersions(): boolean {
    return hasInvalidVersion(this.versionConstraints, this.ecosystem);
  }

  save(): void {
    if (this.saving || !this.name.trim() || this.invalidVersions()) return;
    const built = buildVersion(this.versionConstraints);
    const versionRange = built === '*' ? undefined : built;
    this.saving = true;
    const request = this.editing
      ? this.malicious.update(this.id, { versionRange: versionRange ?? null })
      : this.malicious.create(this.name.trim(), this.ecosystem, versionRange);
    request.subscribe({
      next: () => {
        this.toast.success(this.editing ? `Updated ${this.name}` : `Added ${this.name.trim()}`);
        this.activeModal.close(true);
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? (this.editing ? 'Update failed' : 'Create failed'));
      },
    });
  }
}
