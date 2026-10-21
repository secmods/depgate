import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { AccountService } from '../../services/account.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-create-service-account-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ createdKey ? 'Service account created' : 'Add service account' }}</h5>
        <p class="dg-dialog-description">
          {{ createdKey ? 'Store this key in your CI secret store.' : 'CI tokens from this key last up to 1 day and cannot sign in or change policy.' }}
        </p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="close()"></button>
    </div>
    <div class="modal-body">
      @if (!createdKey) {
        <div class="dg-field">
          <label class="form-label" for="sa-name">Name</label>
          <input id="sa-name" class="form-control" [(ngModel)]="name" placeholder="e.g. github-actions" autocomplete="off" />
        </div>
      } @else {
        <div class="dg-callout is-warning mb-3">
          <span class="material-symbols-outlined">warning</span>
          <span><strong>Copy the key now.</strong> It won't be shown again.</span>
        </div>
        <div class="d-flex align-items-start gap-2">
          <pre class="dg-code flex-grow-1" style="white-space: pre-wrap; word-break: break-all">{{ createdKey }}</pre>
          <button type="button" class="dg-icon-btn" (click)="copy()" title="Copy key" aria-label="Copy key">
            <span class="material-symbols-outlined">content_copy</span>
          </button>
        </div>
      }
    </div>
    <div class="modal-footer">
      @if (!createdKey) {
        <button type="button" class="dg-btn dg-btn-secondary" (click)="close()">Cancel</button>
        <button type="button" class="dg-btn dg-btn-primary" (click)="create()" [disabled]="!name.trim() || saving">
          {{ saving ? 'Creating…' : 'Create' }}
        </button>
      } @else {
        <button type="button" class="dg-btn dg-btn-primary" (click)="close()">Done</button>
      }
    </div>
  `,
})
export class CreateServiceAccountDialogComponent {
  name = '';
  createdKey: string | null = null;
  saving = false;

  activeModal = inject(NgbActiveModal);
  private accounts = inject(AccountService);
  private toast = inject(ToastService);

  close(): void {
    if (this.createdKey) this.activeModal.close(true);
    else this.activeModal.dismiss();
  }

  copy(): void {
    if (!this.createdKey) return;
    navigator.clipboard.writeText(this.createdKey).then(
      () => this.toast.success('Key copied to clipboard'),
      () => this.toast.error('Could not copy. Select the key and copy it manually.'),
    );
  }

  create(): void {
    if (this.saving) return;
    this.saving = true;
    this.accounts.createServiceAccount(this.name.trim()).subscribe({
      next: (res) => {
        this.createdKey = res.key;
        this.saving = false;
      },
      error: (err) => {
        this.saving = false;
        this.toast.error(err.error?.error ?? 'Create failed');
      },
    });
  }
}
