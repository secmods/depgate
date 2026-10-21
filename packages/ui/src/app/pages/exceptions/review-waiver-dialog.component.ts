import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap';
import { WaiverRequest, WaiverService } from '../../services/waiver.service';
import { ToastService } from '../../services/toast.service';
import { MODAL_DATA } from '../../tokens';
import { toDatetimeLocal } from '../waivers/request-waiver-dialog.component';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { ecosystemLabel, statusLabel } from '../../shared/status';
import { RepositoryScopeComponent } from '../../shared/repository-scope.component';
import { missingIds } from '../../shared/repository-scope';

type ReviewMode = 'view' | 'approve' | 'reject';

@Component({
  selector: 'app-review-waiver-dialog',
  standalone: true,
  imports: [DatePipe, FormsModule, RepositoryScopeComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="modal-header">
      <div class="min-w-0">
        <h5 class="modal-title">{{ title }}</h5>
        <p class="dg-dialog-description">{{ request.packageName }} · {{ ecosystem }} · {{ request.version || '*' }}</p>
      </div>
      <button type="button" class="btn-close" aria-label="Close" (click)="activeModal.dismiss()"></button>
    </div>
    <div class="modal-body">
      @if (mode === 'view') {
        <div class="dg-banner" [class]="'dg-banner ' + bannerClass">
          <span class="dg-banner-icon material-symbols-outlined" aria-hidden="true">{{ bannerIcon }}</span>
          <div class="min-w-0">
            <div class="dg-banner-name">{{ statusText }}</div>
            <p class="dg-banner-copy">{{ bannerCopy }}</p>
          </div>
        </div>
      }

      <div class="dg-detail-list">
        <div class="dg-detail-row">
          <div class="dg-detail-label">Versions</div>
          <div class="dg-detail-value"><span class="dg-chip">{{ request.version && request.version !== '*' ? request.version : 'All versions' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Repositories</div>
          <div class="dg-detail-value" data-testid="waiver-scope">
            @for (ref of request.repositories ?? []; track ref.id) {
              <span class="dg-chip dg-chip-accent">{{ ref.ecosystem }}/{{ ref.key }}</span>
            }
            @if (scopeMissing) {
              <span class="dg-chip dg-chip-warning">Deleted repository</span>
            }
            @if (!(request.repositoryIds ?? []).length) {
              <span class="dg-chip">All repositories</span>
            }
          </div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Requested by</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ request.requestedBy }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Submitted</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ request.createdAt | date: 'medium' }}</span></div>
        </div>
        <div class="dg-detail-row">
          <div class="dg-detail-label">Requested expiry</div>
          <div class="dg-detail-value"><span class="dg-detail-text">{{ request.requestedExpiresAt | date: 'medium' }}</span></div>
        </div>
        @if (request.approvedExpiresAt) {
          <div class="dg-detail-row">
            <div class="dg-detail-label">Approved expiry</div>
            <div class="dg-detail-value"><span class="dg-detail-text">{{ request.approvedExpiresAt | date: 'medium' }}</span></div>
          </div>
        }
        @if (request.reviewedAt) {
          <div class="dg-detail-row">
            <div class="dg-detail-label">Reviewed</div>
            <div class="dg-detail-value">
              <span class="dg-detail-text">{{ request.reviewedAt | date: 'medium' }}@if (request.reviewedBy) { · {{ request.reviewedBy }} }</span>
            </div>
          </div>
        }
        <div class="dg-detail-row is-stacked">
          <div class="dg-detail-label">Reason</div>
          <div class="dg-detail-value dg-detail-prose">{{ request.reason }}</div>
        </div>
        @if (request.reviewNote) {
          <div class="dg-detail-row is-stacked">
            <div class="dg-detail-label">Reviewer note</div>
            <div class="dg-detail-value dg-detail-prose">{{ request.reviewNote }}</div>
          </div>
        }
      </div>

      @if (mode === 'approve') {
        <div class="dg-field mt-4">
          <label class="form-label" for="approve-expires">Exception expires</label>
          <input id="approve-expires" type="datetime-local" class="form-control" [(ngModel)]="expiresAtStr" required />
          <span class="dg-form-help">Defaults to the requested date.</span>
        </div>
        <app-repository-scope idPrefix="approve" [ecosystems]="[request.ecosystem]" [selectedIds]="approveRepositoryIds"
          (selectedIdsChange)="approveRepositoryIds = $event" (modeChange)="approveScopeMode = $event"
          help="Prefilled with what was requested. The exception applies only here." />
      }
      @if (mode !== 'view') {
        <div class="dg-field" [class.mt-4]="mode === 'reject'">
          <label class="form-label" for="review-note">Note to requester <span class="dg-optional">(optional)</span></label>
          <textarea id="review-note" class="form-control" [(ngModel)]="reviewNote" rows="2"></textarea>
        </div>
      }
    </div>
    <div class="modal-footer">
      @if (mode === 'view') {
        @if (ownerActions && request.status !== 'approved') {
          <button type="button" class="dg-btn dg-btn-danger-outline dg-footer-start" (click)="deleteRequest()" [disabled]="submitting">Delete</button>
        }
        @if (!readOnly && request.status === 'pending') {
          <button type="button" class="dg-btn dg-btn-danger-outline dg-footer-start" (click)="mode = 'reject'">Reject</button>
        }
        <button type="button" class="dg-btn dg-btn-secondary" (click)="activeModal.dismiss()">Close</button>
        @if (ownerActions && request.status !== 'approved') {
          <button type="button" class="dg-btn dg-btn-primary" (click)="editRequest()" [disabled]="submitting">Edit</button>
        }
        @if (!readOnly && request.status === 'pending') {
          <button type="button" class="dg-btn dg-btn-success" (click)="mode = 'approve'">Approve</button>
        }
      } @else {
        <button type="button" class="dg-btn dg-btn-secondary" (click)="mode = 'view'" [disabled]="submitting">Back</button>
        @if (mode === 'approve') {
          <button type="button" class="dg-btn dg-btn-success" (click)="submit()"
            [disabled]="submitting || !validExpiry() || (approveScopeMode === 'selected' && !approveRepositoryIds.length)">
            {{ submitting ? 'Approving…' : 'Approve waiver' }}
          </button>
        } @else {
          <button type="button" class="dg-btn dg-btn-danger" (click)="submit()" [disabled]="submitting">
            {{ submitting ? 'Rejecting…' : 'Reject waiver' }}
          </button>
        }
      }
    </div>
  `,
})
export class ReviewWaiverDialogComponent {
  activeModal = inject(NgbActiveModal);
  private data = inject(MODAL_DATA) as { request: WaiverRequest; readOnly?: boolean; ownerActions?: boolean };
  private waiverService = inject(WaiverService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  request = this.data.request;
  readOnly = this.data.readOnly === true;
  ownerActions = this.data.ownerActions === true;
  mode: ReviewMode = 'view';
  expiresAtStr = '';
  reviewNote = '';
  submitting = false;
  /** The reviewer's choice of repositories, starting from the request. */
  approveRepositoryIds: string[] = (this.request.repositories ?? []).map((ref) => ref.id);
  approveScopeMode: 'all' | 'selected' = this.approveRepositoryIds.length ? 'selected' : 'all';

  get scopeMissing(): boolean {
    return missingIds(this.request.repositoryIds, this.request.repositories).length > 0;
  }

  constructor() {
    this.expiresAtStr = toDatetimeLocal(new Date(this.request.requestedExpiresAt));
  }

  get title(): string {
    if (this.mode === 'approve') return 'Approve waiver';
    if (this.mode === 'reject') return 'Reject waiver';
    return 'Waiver request';
  }

  get ecosystem(): string {
    return ecosystemLabel(this.request.ecosystem);
  }

  get statusText(): string {
    return statusLabel(this.request.status);
  }

  get bannerClass(): string {
    if (this.request.status === 'approved') return 'dg-banner-allow';
    if (this.request.status === 'rejected') return 'dg-banner-block';
    return 'dg-banner-pending';
  }

  get bannerIcon(): string {
    if (this.request.status === 'approved') return 'check_circle';
    if (this.request.status === 'rejected') return 'block';
    return 'schedule';
  }

  get bannerCopy(): string {
    if (this.request.status === 'approved') return 'Approved. An exception now allows this package.';
    if (this.request.status === 'rejected') return 'Rejected. The package stays blocked; the requester can edit and resubmit.';
    return 'Waiting for a security reviewer. The package stays blocked until then.';
  }

  validExpiry(): boolean {
    if (!this.expiresAtStr.trim()) return false;
    const d = new Date(this.expiresAtStr);
    return !isNaN(d.getTime()) && d > new Date();
  }

  editRequest(): void {
    if (this.submitting || this.request.status === 'approved') return;
    this.activeModal.close('edit');
  }

  async deleteRequest(): Promise<void> {
    if (this.submitting || this.request.status === 'approved') return;
    const ok = await this.confirm.confirm({
      title: 'Delete waiver request?',
      message: `Your request for ${this.request.packageName} will be withdrawn. This can't be undone.`,
      confirmText: 'Delete request',
    });
    if (!ok) return;
    this.submitting = true;
    this.waiverService.remove(this.request.id).subscribe({
      next: () => this.activeModal.close('deleted'),
      error: (err) => {
        this.submitting = false;
        this.toast.error(err.error?.error ?? 'Delete failed');
      },
    });
  }

  submit(): void {
    if (this.submitting || this.mode === 'view') return;
    if (this.mode === 'approve' && !this.validExpiry()) return;
    this.submitting = true;
    const note = this.reviewNote.trim() || undefined;
    const call = this.mode === 'approve'
      ? this.waiverService.approve(this.request.id, {
          expiresAt: new Date(this.expiresAtStr).toISOString(),
          reviewNote: note,
          repositoryIds: this.approveRepositoryIds,
        })
      : this.waiverService.reject(this.request.id, { reviewNote: note });
    call.subscribe({
      next: () => this.activeModal.close(this.mode),
      error: (err) => {
        this.submitting = false;
        this.toast.error(err.error?.error ?? 'Review failed');
      },
    });
  }
}
