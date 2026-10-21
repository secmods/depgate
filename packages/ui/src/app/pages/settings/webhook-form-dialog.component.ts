import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { WEBHOOK_EVENT_GROUPS, WebhookService } from '../../services/webhook.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-webhook-form-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Add webhook</h5>
        <p class="dg-dialog-description">DepGate sends a JSON POST to this URL for each selected event.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="dg-field">
        <label class="form-label" for="webhook-url">Endpoint URL</label>
        <input id="webhook-url" class="form-control" type="url" [(ngModel)]="url" placeholder="https://hooks.example.com/depgate" autocomplete="off" />
        @if (url.trim() && !validUrl()) {
          <span class="dg-form-help text-danger">Enter a full http:// or https:// URL.</span>
        }
      </div>
      <div class="dg-field">
        <label class="form-label" for="webhook-secret">Signing secret <span class="dg-optional">(optional)</span></label>
        <input id="webhook-secret" type="password" class="form-control" [(ngModel)]="secret" autocomplete="new-password" />
        <span class="dg-form-help">When set, each request carries an HMAC signature so your endpoint can verify it.</span>
      </div>
      <div class="dg-field">
        <span class="form-label d-block">Events</span>
        @for (g of groups; track g.label) {
          <p class="dg-section-label mt-2 mb-1">{{ g.label }}</p>
          @for (e of g.events; track e.event) {
            <div class="form-check">
              <input class="form-check-input" type="checkbox" [id]="'evt-' + e.event" [(ngModel)]="selectedEvents[e.event]" [ngModelOptions]="{ standalone: true }" [attr.data-testid]="'webhook-event-' + e.event" />
              <label class="form-check-label" [for]="'evt-' + e.event">{{ e.label }} <span class="font-mono text-xs dg-text-muted">{{ e.event }}</span></label>
            </div>
          }
        }
      </div>
      <div class="form-check">
        <input class="form-check-input" type="checkbox" [(ngModel)]="isEnabled" id="webhookEnabled" />
        <label class="form-check-label" for="webhookEnabled">Send events now</label>
      </div>
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Cancel</button>
      <button type="button" class="dg-btn dg-btn-primary" (click)="save()" [disabled]="!validUrl() || !anyEvent() || saving">
        {{ saving ? 'Creating…' : 'Create' }}
      </button>
    </div>
  `,
})
export class WebhookFormDialogComponent {
  url = '';
  secret = '';
  isEnabled = true;
  saving = false;
  readonly groups = WEBHOOK_EVENT_GROUPS;
  events: string[] = [];
  selectedEvents: Record<string, boolean> = {};

  activeModal = inject(NgbActiveModal);
  private webhookService = inject(WebhookService);
  private toast = inject(ToastService);

  constructor() {
    this.events = this.webhookService.getEvents();
    // A new webhook gets package_blocked and the two new alert events (§8.5).
    for (const group of WEBHOOK_EVENT_GROUPS) for (const e of group.events) this.selectedEvents[e.event] = e.isDefault;
  }

  validUrl(): boolean {
    try {
      const parsed = new URL(this.url.trim());
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  }

  anyEvent(): boolean {
    return this.events.some((e) => this.selectedEvents[e]);
  }

  save(): void {
    if (!this.validUrl() || this.saving) return;
    const events = this.events.filter((e) => this.selectedEvents[e]);
    this.saving = true;
    this.webhookService
      .create({
        url: this.url.trim(),
        secret: this.secret.trim() || undefined,
        events: events.length ? events : undefined,
        isEnabled: this.isEnabled,
      })
      .subscribe({
        next: () => {
          this.toast.success('Webhook added');
          this.activeModal.close(true);
        },
        error: (err) => {
          this.saving = false;
          this.toast.error(err.error?.error ?? 'Could not add the webhook');
        },
      });
  }
}
