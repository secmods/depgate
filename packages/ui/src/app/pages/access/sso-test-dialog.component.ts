import { Component, OnDestroy, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { JsonPipe } from '@angular/common';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { MODAL_DATA } from '../../tokens';
import { SsoService, TestResult } from '../../services/sso.service';

export interface SsoTestDialogData {
  providerName: string;
  /** SAML sends attributes and a NameID, OIDC sends claims. */
  protocol?: 'oidc' | 'saml';
  ticket: string;
  startUrl: string;
  /** False when the browser blocked the pop-up; the dialog then offers a link. */
  popupOpened: boolean;
}

const POLL_MS = 1000;
const GIVE_UP_MS = 5 * 60_000;

/**
 * Shows what a test sign-in returned (requirements_sso.md R5): the claims, each check, and what a
 * real sign-in would do. The sign-in itself runs in a pop-up; this dialog polls for its result.
 */
@Component({
  selector: 'app-sso-test-dialog',
  standalone: true,
  imports: [JsonPipe],
  styles: [`
    .checks { list-style: none; margin: 0; padding: 0; }
    .checks li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--color-border); font-size: 0.875rem; }
    .checks li:last-child { border-bottom: none; }
    .checks .material-symbols-outlined { font-size: 18px; margin-top: 1px; }
    .check-ok { color: var(--color-success, #16a34a); }
    .check-bad { color: var(--color-danger, #dc2626); }
    .claims { max-height: 260px; overflow: auto; font-size: 0.75rem; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">Test sign-in: {{ data.providerName }}</h5>
        <p class="dg-dialog-description">Sign in as the person you want to check. Nobody is signed in to DepGate.</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      @if (!result) {
        @if (timedOut) {
          <div class="dg-callout is-warning" role="status">
            <span class="material-symbols-outlined">timer_off</span>
            <span>No result after 5 minutes. Close this dialog and test again.</span>
          </div>
        } @else {
          <div class="d-flex align-items-center gap-3" role="status">
            <span class="dg-spinner"></span>
            <span class="text-sm">Waiting for the sign-in in the other window…</span>
          </div>
          @if (!data.popupOpened) {
            <p class="text-sm mt-3">The browser blocked the pop-up.
              <a [href]="data.startUrl" target="_blank" rel="opener" style="color: var(--color-primary, #6366f1)">Open the sign-in window</a>.
            </p>
          }
        }
      } @else if (result.status === 'done') {
        <div class="dg-callout mb-3" [class.is-success]="result.ok" [class.is-danger]="!result.ok" role="status" data-testid="sso-test-outcome">
          <span class="material-symbols-outlined">{{ result.ok ? 'check_circle' : 'block' }}</span>
          <span>{{ result.outcome }}</span>
        </div>
        @if (result.error) {
          <p class="text-sm text-danger mb-3" data-testid="sso-test-error">{{ result.error }}</p>
        }
        <ul class="checks" data-testid="sso-test-checks">
          @for (check of result.checks; track check.label) {
            <li>
              <span class="material-symbols-outlined" [class.check-ok]="check.ok" [class.check-bad]="!check.ok">{{ check.ok ? 'check' : 'close' }}</span>
              <div><strong>{{ check.label }}</strong><div class="dg-text-variant">{{ check.detail }}</div></div>
            </li>
          }
        </ul>
        @if (result.claims) {
          <p class="form-label mt-3">{{ data.protocol === 'saml' ? 'Attributes received' : 'Claims received' }}</p>
          <pre class="dg-code claims" data-testid="sso-test-claims">{{ result.claims | json }}</pre>
        }
      }
    </div>
    <div class="modal-footer">
      <button type="button" class="dg-btn dg-btn-primary" (click)="activeModal.close()">Done</button>
    </div>
  `,
})
export class SsoTestDialogComponent implements OnInit, OnDestroy {
  activeModal = inject(NgbActiveModal);
  data = inject<SsoTestDialogData>(MODAL_DATA);
  private sso = inject(SsoService);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = Date.now();

  result: TestResult | null = null;
  timedOut = false;

  ngOnInit(): void {
    this.poll();
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private poll(): void {
    this.timer = setTimeout(() => {
      this.sso.testResult(this.data.ticket).subscribe({
        next: (res) => {
          if (res.status === 'done') {
            this.result = res;
            return;
          }
          this.next();
        },
        error: () => this.next(),
      });
    }, POLL_MS);
  }

  private next(): void {
    if (Date.now() - this.startedAt > GIVE_UP_MS) {
      this.timedOut = true;
      return;
    }
    this.poll();
  }
}
