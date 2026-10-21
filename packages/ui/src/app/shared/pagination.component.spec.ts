import 'zone.js';
import 'zone.js/testing';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { ComponentFixture, TestBed, getTestBed } from '@angular/core/testing';
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from '@angular/platform-browser-dynamic/testing';
import { PageChange, PaginationComponent, pageItems, savedPageSize } from './pagination.component';

const testBed = getTestBed();
if (!(testBed as { platform: unknown }).platform) {
  testBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
    teardown: { destroyAfterEach: true },
  });
}

@Component({
  standalone: true,
  imports: [PaginationComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `<app-pagination [offset]="offset" [limit]="limit" [total]="total" [count]="count" storageKey="spec-list" (pageChange)="onPage($event)" />`,
})
class HostComponent {
  offset = 0;
  limit = 20;
  total = 1000;
  count = 20;
  changes: PageChange[] = [];
  onPage(change: PageChange): void {
    this.changes.push(change);
    this.offset = change.offset;
    this.limit = change.limit;
    this.count = Math.min(change.limit, this.total - change.offset);
  }
}

describe('pageItems', () => {
  it('lists every page when there are seven or fewer', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the first, the last and the neighbours, with gaps between', () => {
    expect(pageItems(1, 50)).toEqual([1, 2, 3, 4, 5, 'gap', 50]);
    expect(pageItems(25, 50)).toEqual([1, 'gap', 24, 25, 26, 'gap', 50]);
    expect(pageItems(50, 50)).toEqual([1, 'gap', 46, 47, 48, 49, 50]);
    expect(pageItems(5, 50)).toEqual([1, 'gap', 4, 5, 6, 'gap', 50]);
    expect(pageItems(4, 8)).toEqual([1, 2, 3, 4, 5, 'gap', 8]);
  });

  it('never shows a gap that hides a single page, and always shows the current, first and last page', () => {
    for (let pages = 1; pages <= 40; pages++) {
      for (let page = 1; page <= pages; page++) {
        const items = pageItems(page, pages);
        expect(items).toContain(page);
        expect(items[0]).toBe(1);
        expect(items.at(-1)).toBe(pages);
        items.forEach((item, i) => {
          if (item !== 'gap') return;
          expect((items[i + 1] as number) - (items[i - 1] as number)).toBeGreaterThan(2);
        });
      }
    }
  });
});

describe('PaginationComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  const el = () => fixture.nativeElement as HTMLElement;
  const button = (label: string) => el().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

  beforeEach(async () => {
    try { localStorage.clear(); } catch { /* no storage */ }
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('shows the range, the page numbers and first/last', () => {
    expect(el().querySelector('[data-testid="pagination-range"]')!.textContent).toContain('1–20');
    expect(el().textContent).toContain('1,000');
    expect(button('First page').disabled).toBe(true);
    expect(button('Last page').disabled).toBe(false);
    expect(button('Page 1').getAttribute('aria-current')).toBe('page');
    expect(button('Page 50')).not.toBeNull();
  });

  it('jumps straight to a page by number, by Last, and by the page box', () => {
    button('Page 50').click();
    fixture.detectChanges();
    expect(host.changes.at(-1)).toEqual({ offset: 980, limit: 20 });
    expect(button('Next page').disabled).toBe(true);

    button('First page').click();
    fixture.detectChanges();
    expect(host.offset).toBe(0);

    const jump = el().querySelector('[data-testid="pagination-jump"]') as HTMLInputElement;
    jump.value = '33';
    jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(host.changes.at(-1)).toEqual({ offset: 640, limit: 20 });

    jump.value = '999';
    jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host.changes.at(-1)).toEqual({ offset: 980, limit: 20 });
  });

  it('changes the rows per page, keeps the first row on screen, and remembers the choice', () => {
    button('Page 4').click();
    fixture.detectChanges();
    expect(host.offset).toBe(60);

    const select = el().querySelector('[data-testid="pagination-size"]') as HTMLSelectElement;
    select.value = '50';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    // Row 61 is on page 2 of 50.
    expect(host.changes.at(-1)).toEqual({ offset: 50, limit: 50 });
    expect(savedPageSize('spec-list', 20)).toBe(50);
    expect(savedPageSize('another-list', 20)).toBe(20);
  });

  it('hides page buttons when everything fits on one page', () => {
    host.total = 12;
    host.count = 12;
    fixture.detectChanges();
    expect(button('Next page')).toBeNull();
    expect(el().querySelector('[data-testid="pagination-size"]')).not.toBeNull();
    expect(el().querySelector('[data-testid="pagination-jump"]')).toBeNull();
  });
});
