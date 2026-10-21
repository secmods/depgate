import { Component, Input, OnChanges, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ExceptionEntry, ExceptionService } from '../../services/exception.service';
import { ToastService } from '../../services/toast.service';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EcoTagComponent } from '../../shared/eco-tag.component';
import { versionText } from '../policies/policy-rules';

/** A policy's approvals: exceptions that stop only this policy from matching (MON-E6). */
@Component({
  selector: 'app-approved-packages',
  standalone: true,
  imports: [DatePipe, EcoTagComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <p class="dg-section-label">Approved packages</p>
    @if (loading) {
      <div class="dg-loading py-3"><span class="dg-spinner"></span></div>
    } @else if (items.length === 0) {
      <p class="dg-empty mb-3" data-testid="approved-empty">None yet. Approved packages keep installing after the policy is enforced.</p>
    } @else {
      <div class="dg-table-wrap mb-3">
        <table class="dg-table" data-testid="approved-packages">
          <thead>
            <tr>
              <th>Package</th>
              <th>Versions</th>
              <th>Expires</th>
              <th>Approved by</th>
              <th>Reason</th>
              <th class="col-actions"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            @for (row of items; track row.id) {
              <tr>
                <td>
                  <span class="dg-cell-primary">{{ row.packageName }}</span>
                  <app-eco-tag [ecosystem]="row.ecosystem" />
                </td>
                <td><span class="dg-tag">{{ versions(row.version) }}</span></td>
                <td class="col-nowrap" [class.text-danger]="expired(row)">{{ row.expiresAt | date: 'MMM d, y' }}</td>
                <td>{{ row.approvedBy }}</td>
                <td><span class="dg-cell-truncate" [title]="row.reason ?? ''">{{ row.reason || '—' }}</span></td>
                <td class="col-actions">
                  @if (canRevoke) {
                    <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="revoke(row)" [disabled]="busy === row.id">Revoke</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class ApprovedPackagesComponent implements OnChanges {
  @Input({ required: true }) policyId = '';
  @Input() canRevoke = true;
  items: ExceptionEntry[] = [];
  loading = false;
  busy: string | null = null;

  private exceptions = inject(ExceptionService);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  ngOnChanges(): void {
    this.load();
  }

  load(): void {
    if (!this.policyId) return;
    this.loading = true;
    this.exceptions.list({ appliesTo: this.policyId, limit: 200 }).subscribe({
      next: (page) => {
        this.items = page.items;
        this.loading = false;
      },
      error: () => {
        this.items = [];
        this.loading = false;
      },
    });
  }

  versions(spec: string): string {
    return spec === '*' ? 'All versions' : versionText(spec);
  }

  expired(row: ExceptionEntry): boolean {
    return Date.parse(row.expiresAt) <= Date.now();
  }

  async revoke(row: ExceptionEntry): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Revoke approval?',
      message: `${row.packageName} will be blocked by this policy again once it is enforced.`,
      confirmText: 'Revoke',
    });
    if (!ok) return;
    this.busy = row.id;
    this.exceptions.delete(row.id).subscribe({
      next: () => {
        this.busy = null;
        this.items = this.items.filter((item) => item.id !== row.id);
        this.toast.success(`Revoked the approval for ${row.packageName}`);
      },
      error: (err) => {
        this.busy = null;
        this.toast.error(err.error?.error ?? 'Revoke failed');
      },
    });
  }
}
