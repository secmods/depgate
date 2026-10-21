import { Component, Injectable, InjectionToken, Injector, inject, ChangeDetectionStrategy } from '@angular/core';
import { NgbActiveModal, NgbModal } from '@ng-bootstrap/ng-bootstrap';

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Primary button text. */
  confirmText: string;
  tone?: 'danger' | 'primary' | 'success';
}

const CONFIRM_OPTIONS = new InjectionToken<ConfirmOptions>('CONFIRM_OPTIONS');

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="d-flex align-items-start gap-3 min-w-0">
        <span class="dg-stat-icon" [class]="'dg-stat-icon tone-' + iconTone" aria-hidden="true">
          <span class="material-symbols-outlined">{{ icon }}</span>
        </span>
        <div class="min-w-0">
          <h5 class="modal-title">{{ options.title }}</h5>
          <p class="dg-dialog-description">{{ options.message }}</p>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn" [class]="'dg-btn ' + buttonClass" (click)="activeModal.close(true)" data-testid="confirm-accept">
        {{ options.confirmText }}
      </button>
    </div>
  `,
})
export class ConfirmDialogComponent {
  activeModal = inject(NgbActiveModal);
  options = inject(CONFIRM_OPTIONS);

  get tone(): 'danger' | 'primary' | 'success' {
    return this.options.tone ?? 'danger';
  }

  get iconTone(): string {
    return this.tone === 'danger' ? 'danger' : this.tone === 'success' ? 'success' : 'brand';
  }

  get icon(): string {
    return this.tone === 'danger' ? 'warning' : this.tone === 'success' ? 'check_circle' : 'help';
  }

  get buttonClass(): string {
    return this.tone === 'danger' ? 'dg-btn-danger' : this.tone === 'success' ? 'dg-btn-success' : 'dg-btn-primary';
  }
}

/** In-app replacement for window.confirm(). Resolves true only when the user confirms. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private modal = inject(NgbModal);
  private injector = inject(Injector);

  confirm(options: ConfirmOptions): Promise<boolean> {
    const ref = this.modal.open(ConfirmDialogComponent, {
      centered: true,
      windowClass: 'dg-confirm-window',
      injector: Injector.create({ providers: [{ provide: CONFIRM_OPTIONS, useValue: options }], parent: this.injector }),
    });
    return ref.result.then(
      (value) => value === true,
      () => false,
    );
  }
}
