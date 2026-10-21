import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WaiverVersionConstraint, constraintError, versionInputError } from '../pages/waivers/waiver-version';

/**
 * Edits a list of exact versions and version ranges in place.
 * Each dialog keeps its own serialisation; this only owns the UI.
 */
@Component({
  selector: 'app-version-constraints',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @for (vr of constraints; track $index) {
      @if (vr.kind === 'exact') {
        <div class="dg-editor-row" style="grid-template-columns: 1fr 32px">
          <input class="form-control form-control-sm" [(ngModel)]="vr.version" [name]="idPrefix + '-exact-' + $index"
            [class.is-invalid]="invalid(vr.version)" placeholder="Version, e.g. 1.2.3 or 2.0.0-rc.1" aria-label="Version" />
          <button type="button" class="dg-icon-btn is-danger" (click)="remove($index)" title="Remove version" aria-label="Remove version">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>
      } @else {
        <div class="dg-editor-row" style="grid-template-columns: 1fr auto 1fr 32px">
          <input class="form-control form-control-sm" [(ngModel)]="vr.from" [name]="idPrefix + '-from-' + $index"
            [class.is-invalid]="invalid(vr.from)" placeholder="From, e.g. 1.0.0" aria-label="Range start" />
          <span class="dg-text-muted" aria-hidden="true">to</span>
          <input class="form-control form-control-sm" [(ngModel)]="vr.to" [name]="idPrefix + '-to-' + $index"
            [class.is-invalid]="invalid(vr.to)" placeholder="To, e.g. 2.1.0" aria-label="Range end" />
          <button type="button" class="dg-icon-btn is-danger" (click)="remove($index)" title="Remove range" aria-label="Remove range">
            <span class="material-symbols-outlined">delete</span>
          </button>
        </div>
      }
      @if (rowError(vr); as message) {
        <span class="dg-form-help text-danger" [attr.data-testid]="idPrefix + '-version-error-' + $index">{{ message }}</span>
      }
    }
    <div class="dg-editor-actions">
      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addExact()" data-testid="add-exact-version">
        <span class="material-symbols-outlined">add</span>Version
      </button>
      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="addRange()" data-testid="add-version-range">
        <span class="material-symbols-outlined">add</span>Version range
      </button>
    </div>
    <span class="dg-form-help">{{ help }}</span>
  `,
})
export class VersionConstraintsComponent {
  @Input({ required: true }) constraints: WaiverVersionConstraint[] = [];
  @Input() idPrefix = 'version';
  /** Composer also accepts branch versions such as dev-main. */
  @Input() ecosystem = '';
  @Input() help = 'Empty = every version. Ranges include both ends.';

  invalid(value: string): boolean {
    return versionInputError(value, this.ecosystem) != null;
  }

  rowError(item: WaiverVersionConstraint): string | null {
    return constraintError(item, this.ecosystem);
  }

  addExact(): void {
    this.constraints.push({ kind: 'exact', version: '', from: '', to: '' });
  }

  addRange(): void {
    this.constraints.push({ kind: 'range', version: '', from: '', to: '' });
  }

  remove(index: number): void {
    this.constraints.splice(index, 1);
  }
}
