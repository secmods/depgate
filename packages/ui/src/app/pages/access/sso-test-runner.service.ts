import { Injectable, Injector, inject } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { MODAL_DATA } from '../../tokens';
import { ToastService } from '../../services/toast.service';
import { SsoProvider, SsoService } from '../../services/sso.service';
import { SsoTestDialogComponent, SsoTestDialogData } from './sso-test-dialog.component';

/**
 * Runs a test sign-in for a saved provider (requirements_sso.md R5): a pop-up signs in at the provider,
 * and a dialog shows what came back. Call `run` straight from a click so pop-up blockers allow it.
 */
@Injectable({ providedIn: 'root' })
export class SsoTestRunner {
  private sso = inject(SsoService);
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private toast = inject(ToastService);

  /** Resolves when the result dialog closes, so the caller can refresh the provider's last error and success. */
  run(provider: Pick<SsoProvider, 'id' | 'name'> & Partial<Pick<SsoProvider, 'type'>>): Promise<void> {
    const popup = window.open('', 'depgate-sso-test', 'popup,width=520,height=720');
    return new Promise((resolve) => {
      this.sso.startTest(provider.id).subscribe({
        next: ({ ticket, startUrl }) => {
          if (popup) popup.location.href = new URL(startUrl, window.location.origin).href;
          const data: SsoTestDialogData = { providerName: provider.name, protocol: provider.type, ticket, startUrl, popupOpened: Boolean(popup) };
          const ref = this.modal.open(SsoTestDialogComponent, {
            size: 'lg',
            scrollable: true,
            injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: data }], parent: this.injector }),
          });
          ref.closed.subscribe(() => resolve());
          ref.dismissed.subscribe(() => resolve());
        },
        error: (err) => {
          popup?.close();
          this.toast.error(err.error?.error ?? 'Could not start the test');
          resolve();
        },
      });
    });
  }
}
