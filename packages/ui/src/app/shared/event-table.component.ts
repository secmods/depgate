import { ChangeDetectionStrategy, Component, ContentChild, EventEmitter, Input, Output, TemplateRef, inject } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { EmptyStateComponent } from './empty-state.component';
import { PageChange, PaginationComponent } from './pagination.component';
import { ToastService } from '../services/toast.service';

export interface EventColumn {
  key: string;
  label: string;
  /** e.g. `col-nowrap` */
  cellClass?: string;
}

/**
 * The one table of the three event pages (requirements_event_streaming.md §10.2): rows that expand, pagination,
 * and "Copy as JSON" on an expanded row, which copies the event as a SIEM receives it.
 */
@Component({
  selector: 'app-event-table',
  standalone: true,
  imports: [NgTemplateOutlet, EmptyStateComponent, PaginationComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .chevron { transition: transform 0.15s; }
    .chevron.open { transform: rotate(90deg); }
    .detail { padding: 16px 20px 18px; }
    .detail-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  `],
  template: `
    @if (loading) {
      <div class="dg-loading"><span class="dg-spinner"></span></div>
    } @else if (rows.length === 0) {
      <app-empty-state [icon]="emptyIcon" [title]="emptyTitle" [description]="emptyDescription" />
    } @else {
      <div class="dg-table-wrap">
        <table class="dg-table" [attr.data-testid]="testId">
          <thead>
            <tr>
              <th style="width: 1%"><span class="visually-hidden">Expand</span></th>
              @for (column of columns; track column.key) { <th>{{ column.label }}</th> }
            </tr>
          </thead>
          <tbody>
            @for (row of rows; track row.id) {
              <tr class="is-clickable" [class.is-expanded]="expanded === row" (click)="toggle(row)" [attr.aria-expanded]="expanded === row">
                <td><span class="material-symbols-outlined dg-text-muted chevron" [class.open]="expanded === row" aria-hidden="true">chevron_right</span></td>
                @for (column of columns; track column.key) {
                  <td [class]="column.cellClass ?? ''">
                    <ng-container *ngTemplateOutlet="cellTpl; context: { $implicit: row, column: column.key }" />
                  </td>
                }
              </tr>
              @if (expanded === row) {
                <tr class="is-expanded">
                  <td [attr.colspan]="columns.length + 1" class="p-0">
                    <div class="detail">
                      <ng-container *ngTemplateOutlet="detailTpl; context: { $implicit: row }" />
                      @if (envelopeOf(row); as envelope) {
                        <div class="detail-actions">
                          <button type="button" class="dg-btn dg-btn-secondary dg-btn-sm" (click)="copy(envelope); $event.stopPropagation()" data-testid="copy-json">
                            <span class="material-symbols-outlined">content_copy</span> Copy as JSON
                          </button>
                        </div>
                      }
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
    <app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="rows.length" [storageKey]="storageKey" (pageChange)="pageChange.emit($event)" />
  `,
})
export class EventTableComponent<T extends { id: string; event?: unknown }> {
  @Input({ required: true }) columns: EventColumn[] = [];
  @Input() rows: T[] = [];
  @Input() loading = false;
  @Input() offset = 0;
  @Input() limit = 50;
  @Input() total = 0;
  @Input() storageKey = '';
  @Input() emptyIcon = 'receipt_long';
  @Input() emptyTitle = 'No entries match these filters';
  @Input() emptyDescription = '';
  @Input() testId = '';
  @Output() pageChange = new EventEmitter<PageChange>();

  @ContentChild('cell', { static: true }) cellTpl!: TemplateRef<{ $implicit: T; column: string }>;
  @ContentChild('detail', { static: true }) detailTpl!: TemplateRef<{ $implicit: T }>;

  expanded: T | null = null;
  private toast = inject(ToastService);

  toggle(row: T): void {
    this.expanded = this.expanded === row ? null : row;
  }

  envelopeOf(row: T): unknown {
    return row.event ?? null;
  }

  async copy(envelope: unknown): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(envelope, null, 2));
      this.toast.success('Event copied as JSON');
    } catch {
      this.toast.error('Could not copy to the clipboard');
    }
  }
}
