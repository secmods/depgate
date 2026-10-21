import { Component, DestroyRef, EventEmitter, Input, OnInit, Output, inject, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';

/** Search box that emits after typing pauses, or at once on Enter. */
@Component({
  selector: 'app-search-input',
  standalone: true,
  host: { class: 'dg-search' },
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <span class="material-symbols-outlined" aria-hidden="true">search</span>
    <input
      class="dg-input"
      type="search"
      [placeholder]="placeholder"
      [attr.aria-label]="placeholder"
      [value]="value"
      (input)="onInput($any($event.target).value)"
      (keydown.enter)="flush()" />
  `,
})
export class SearchInputComponent implements OnInit {
  @Input() placeholder = 'Search';
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();
  @Output() search = new EventEmitter<string>();

  private typed = new Subject<string>();
  private destroyRef = inject(DestroyRef);
  private lastEmitted = '';

  ngOnInit(): void {
    this.lastEmitted = this.value;
    this.typed
      .pipe(debounceTime(350), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((term) => this.emit(term));
  }

  onInput(term: string): void {
    this.value = term;
    this.valueChange.emit(term);
    this.typed.next(term);
  }

  flush(): void {
    this.emit(this.value);
  }

  private emit(term: string): void {
    if (term === this.lastEmitted) return;
    this.lastEmitted = term;
    this.search.emit(term.trim());
  }
}
