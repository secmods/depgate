import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { DecimalPipe } from '@angular/common';

export interface PageChange {
  offset: number;
  limit: number;
}

export const PAGE_SIZES = [10, 20, 50, 100] as const;

const STORAGE_PREFIX = 'dg-page-size:';

/** Rows per page this browser last chose for a list, or the fallback. Only a convenience: storage may be unavailable. */
export function savedPageSize(key: string, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_PREFIX + key));
    return (PAGE_SIZES as readonly number[]).includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function savePageSize(key: string, size: number): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(size));
  } catch {
    /* private window or blocked storage: the choice lasts until the page is left */
  }
}

/** Page numbers to show, with `gap` where pages are skipped: 1 … 4 5 6 … 20. */
export function pageItems(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 4) [2, 3, 4, 5].forEach((p) => shown.add(p));
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2, pages - 1].forEach((p) => shown.add(p));
  const sorted = [...shown].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const items: Array<number | 'gap'> = [];
  sorted.forEach((p, i) => {
    const before = i > 0 ? sorted[i - 1] : p - 1;
    // A gap that would hide a single page shows that page instead.
    if (p - before === 2) items.push(before + 1);
    else if (p - before > 2) items.push('gap');
    items.push(p);
  });
  return items;
}

/**
 * The pager under every list: rows per page, page numbers, first/last, and a page box for long lists.
 * Emits the new offset and limit; the list loads that page.
 */
@Component({
  selector: 'app-pagination',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .pager-group { display: flex; align-items: center; gap: 6px; }
    .pager-select { height: 28px; padding: 0 24px 0 8px; font-size: 0.75rem; }
    .pager-page {
      min-width: 28px; height: 28px; padding: 0 6px; border-radius: 6px; border: 1px solid transparent;
      background: transparent; color: var(--color-on-surface); font-size: 0.75rem; font-variant-numeric: tabular-nums; cursor: pointer;
    }
    .pager-page:hover { background: var(--color-surface-variant, rgba(99, 102, 241, 0.08)); }
    .pager-page.is-current { background: var(--brand-soft-strong, rgba(99, 102, 241, 0.14)); color: var(--brand-text, #4f46e5); font-weight: 700; border-color: var(--brand, #6366f1); }
    .pager-gap { min-width: 16px; text-align: center; }
    .pager-jump { width: 64px; height: 28px; padding: 0 6px; font-size: 0.75rem; }
    .pager-controls { flex-wrap: wrap; gap: 8px 16px; }
  `],
  template: `
    @if (total > 0) {
      <div class="dg-pagination" data-testid="pagination">
        <span data-testid="pagination-range">
          Showing <strong>{{ offset + 1 | number }}–{{ offset + count | number }}</strong> of <strong>{{ total | number }}</strong>
        </span>
        <div class="dg-pagination-controls pager-controls">
          <label class="pager-group">
            Rows per page
            <select class="dg-select pager-select" [value]="limit" (change)="setLimit($any($event.target).value)" data-testid="pagination-size"
              aria-label="Rows per page">
              @for (size of sizes; track size) {
                <option [value]="size" [selected]="size === limit">{{ size }}</option>
              }
            </select>
          </label>

          @if (pages > 1) {
            <nav class="pager-group" aria-label="Pages">
              <button type="button" class="dg-icon-btn" [disabled]="page === 1" (click)="goTo(1)" aria-label="First page" title="First page">
                <span class="material-symbols-outlined">first_page</span>
              </button>
              <button type="button" class="dg-icon-btn" [disabled]="page === 1" (click)="goTo(page - 1)" aria-label="Previous page" title="Previous page">
                <span class="material-symbols-outlined">chevron_left</span>
              </button>
              @for (item of items; track $index) {
                @if (item === 'gap') {
                  <span class="pager-gap" aria-hidden="true">…</span>
                } @else {
                  <button type="button" class="pager-page" [class.is-current]="item === page" [attr.aria-current]="item === page ? 'page' : null"
                    [attr.aria-label]="'Page ' + item" (click)="goTo(item)">{{ item | number }}</button>
                }
              }
              <button type="button" class="dg-icon-btn" [disabled]="page === pages" (click)="goTo(page + 1)" aria-label="Next page" title="Next page">
                <span class="material-symbols-outlined">chevron_right</span>
              </button>
              <button type="button" class="dg-icon-btn" [disabled]="page === pages" (click)="goTo(pages)" aria-label="Last page" title="Last page">
                <span class="material-symbols-outlined">last_page</span>
              </button>
            </nav>
          }

          @if (pages > 7) {
            <label class="pager-group">
              Go to page
              <input #jump type="number" class="dg-input pager-jump" min="1" [max]="pages" [placeholder]="page" data-testid="pagination-jump"
                aria-label="Go to page" (keydown.enter)="jumpTo(jump)" (change)="jumpTo(jump)" />
            </label>
          }
        </div>
      </div>
    }
  `,
})
export class PaginationComponent {
  @Input() offset = 0;
  @Input() limit = 20;
  @Input() total = 0;
  /** Rows on the current page. */
  @Input() count = 0;
  /** Remembers the rows-per-page choice under this name in the browser. Read it back with savedPageSize(). */
  @Input() storageKey = '';
  @Output() pageChange = new EventEmitter<PageChange>();

  get sizes(): number[] {
    const sizes: number[] = [...PAGE_SIZES];
    return sizes.includes(this.limit) ? sizes : [...sizes, this.limit].sort((a, b) => a - b);
  }

  get page(): number {
    return Math.floor(this.offset / Math.max(1, this.limit)) + 1;
  }

  get pages(): number {
    return Math.max(1, Math.ceil(this.total / Math.max(1, this.limit)));
  }

  get items(): Array<number | 'gap'> {
    return pageItems(this.page, this.pages);
  }

  goTo(page: number): void {
    const target = Math.min(Math.max(1, Math.floor(page)), this.pages);
    if (target === this.page) return;
    this.pageChange.emit({ offset: (target - 1) * this.limit, limit: this.limit });
  }

  jumpTo(input: HTMLInputElement): void {
    const page = Number(input.value);
    input.value = '';
    if (Number.isFinite(page) && page >= 1) this.goTo(page);
  }

  /** Keeps the first row on screen: it lands on whichever page of the new size holds it. */
  setLimit(value: string | number): void {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit === this.limit) return;
    if (this.storageKey) savePageSize(this.storageKey, limit);
    this.pageChange.emit({ offset: Math.floor(this.offset / limit) * limit, limit });
  }
}
