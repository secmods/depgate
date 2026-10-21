import { Component, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { WebhookDelivery, WebhookDeliveryStatus, WebhookService, WebhookTarget } from '../../services/webhook.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';

const STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Retrying',
  delivered: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Settings → Webhooks → Deliveries: what was sent, the retries, and Redeliver. */
@Component({
  selector: 'app-webhook-deliveries-dialog',
  standalone: true,
  imports: [DatePipe, JsonPipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Deliveries</h5>
        <p class="dg-dialog-description font-mono text-xs dg-cell-truncate">{{ webhook.url }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      <div class="d-flex align-items-center gap-2 mb-3">
        <label class="form-label mb-0" for="delivery-status">Status</label>
        <select id="delivery-status" class="form-select form-select-sm" style="width: 160px" [(ngModel)]="status" (ngModelChange)="load()" data-testid="delivery-status-filter">
          <option value="">All</option>
          @for (s of statuses; track s) { <option [value]="s">{{ label(s) }}</option> }
        </select>
        <button type="button" class="dg-btn dg-btn-ghost dg-btn-sm ms-auto" (click)="load()">
          <span class="material-symbols-outlined">refresh</span> Refresh
        </button>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else if (items.length === 0) {
        <p class="dg-form-help" data-testid="deliveries-empty">No deliveries yet. Events this webhook is subscribed to appear here.</p>
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table" data-testid="deliveries-table">
            <thead><tr><th>Time</th><th>Event</th><th>Status</th><th>Attempts</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (row of items; track row.id) {
                <tr [attr.data-testid]="'delivery-' + row.status">
                  <td class="text-xs">{{ row.createdAt | date: 'MMM d, HH:mm:ss' }}</td>
                  <td>
                    <span class="dg-tag">{{ row.event }}</span>
                    <span class="dg-cell-sub font-mono" [title]="row.eventId">{{ row.eventId.slice(0, 13) }}…</span>
                  </td>
                  <td>
                    <span class="dg-chip" [class.dg-chip-success]="row.status === 'delivered'" [class.dg-chip-danger]="row.status === 'failed'"
                      [class.dg-chip-warning]="row.status === 'pending'">{{ label(row.status) }}</span>
                    @if (row.lastError) { <span class="dg-cell-sub">{{ row.lastError }}</span> }
                    @if (row.status === 'pending' && row.nextAttemptAt) { <span class="dg-cell-sub">Next try {{ row.nextAttemptAt | date: 'HH:mm:ss' }}</span> }
                  </td>
                  <td>{{ row.attempts }}</td>
                  <td class="col-actions">
                    <div class="dg-row-actions">
                      <button type="button" class="dg-icon-btn" (click)="toggle(row.id)" title="Show payload" aria-label="Show payload">
                        <span class="material-symbols-outlined">data_object</span>
                      </button>
                      <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="redeliver(row)" [disabled]="!webhook.isEnabled || busy === row.id"
                        data-testid="delivery-redeliver">Redeliver</button>
                    </div>
                  </td>
                </tr>
                @if (open === row.id) {
                  <tr><td colspan="5"><pre class="dg-code text-xs mb-0">{{ row.payload | json }}</pre></td></tr>
                }
              }
            </tbody>
          </table>
        </div>
        <span class="dg-form-help d-block mt-2">{{ total }} deliveries · kept 30 days · the payload is shown as sent, without the signature.</span>
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.close(true)">Close</button>
    </div>
  `,
})
export class WebhookDeliveriesDialogComponent implements OnInit {
  activeModal = inject(NgbActiveModal);
  private webhooks = inject(WebhookService);
  private toast = inject(ToastService);
  webhook = (inject(MODAL_DATA) as { webhook: WebhookTarget }).webhook;

  readonly statuses: WebhookDeliveryStatus[] = ['delivered', 'pending', 'failed', 'skipped'];
  status: WebhookDeliveryStatus | '' = '';
  items: WebhookDelivery[] = [];
  total = 0;
  loading = true;
  open: string | null = null;
  busy: string | null = null;

  ngOnInit(): void {
    this.load();
  }

  label(status: WebhookDeliveryStatus): string {
    return STATUS_LABELS[status];
  }

  load(): void {
    this.loading = true;
    this.webhooks.deliveries(this.webhook.id, { status: this.status || undefined, limit: 100 }).subscribe({
      next: (page) => {
        this.items = page.items;
        this.total = page.total;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        this.toast.error(err.error?.error ?? 'Could not load deliveries');
      },
    });
  }

  toggle(id: string): void {
    this.open = this.open === id ? null : id;
  }

  redeliver(row: WebhookDelivery): void {
    this.busy = row.id;
    this.webhooks.redeliver(this.webhook.id, row.id).subscribe({
      next: () => {
        this.busy = null;
        this.toast.success('Redelivery queued with the same event ID');
        setTimeout(() => this.load(), 800);
      },
      error: (err) => {
        this.busy = null;
        this.toast.error(err.error?.error ?? 'Could not redeliver');
      },
    });
  }
}
