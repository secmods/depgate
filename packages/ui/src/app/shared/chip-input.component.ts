import { Component, ElementRef, EventEmitter, Input, Output, ViewChild, ChangeDetectionStrategy } from '@angular/core';

/**
 * A list typed as chips: comma, space or Enter adds what was typed, × removes a chip. A chip
 * `errorOf` flags is shown in red with the reason as its title. Pasted text becomes chips at
 * once, except a last part still being typed. That part is reported through `draftChange`, so a
 * summary can show it before the field loses focus.
 */
@Component({
  selector: 'app-chip-input',
  standalone: true,
  template: `
    <div class="chip-box" [attr.data-testid]="testId">
      @for (value of values; track value) {
        <span class="dg-chip gap-1" [class.dg-chip-danger]="errorOf(value)" [title]="errorOf(value) || value">
          {{ value }}
          <button type="button" class="chip-remove" [attr.aria-label]="'Remove ' + value" (click)="remove(value)">
            <span class="material-symbols-outlined">close</span>
          </button>
        </span>
      }
      <input #text [id]="inputId" class="chip-text" (input)="onDraft(text.value)"
        (keydown.enter)="add(); $event.preventDefault()" (keydown)="onKey($event)" (blur)="add()"
        [placeholder]="values.length ? '' : placeholder" autocomplete="off" />
    </div>
    @for (value of values; track value) {
      @if (errorOf(value); as error) {
        <span class="dg-form-help text-danger d-block">{{ value }}: {{ error }}</span>
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .chip-box {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      min-height: 38px; padding: 5px 6px; border: 1px solid var(--color-border); border-radius: var(--radius);
      background: var(--color-surface);
    }
    .chip-box:focus-within { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
    .chip-text { flex: 1 1 160px; min-width: 120px; border: 0; outline: none; background: transparent; font-size: 0.875rem; color: var(--color-on-surface); }
    .chip-remove { display: inline-grid; place-items: center; padding: 0; border: none; background: transparent; color: inherit; opacity: 0.6; cursor: pointer; }
    .chip-remove:hover { opacity: 1; }
    .chip-remove .material-symbols-outlined { font-size: 14px; }
  `],
})
export class ChipInputComponent {
  @Input() values: string[] = [];
  @Input() inputId = '';
  @Input() placeholder = '';
  @Input() testId = '';
  /** Why a value is invalid; empty when it is fine. */
  @Input() errorOf: (value: string) => string = () => '';
  @Output() valuesChange = new EventEmitter<string[]>();
  @Output() draftChange = new EventEmitter<string>();

  @ViewChild('text') private text?: ElementRef<HTMLInputElement>;

  /** What is typed but not yet a chip. Set through `setDraft`, which also updates the box. */
  draft = '';

  /** Text with a separator in it, such as a paste, becomes chips up to the last separator. */
  onDraft(text: string): void {
    if (!/[\s,]/.test(text)) {
      this.draft = text;
      this.draftChange.emit(text);
      return;
    }
    const rest = /[\s,]$/.test(text) ? '' : (text.split(/[\s,]+/).pop() ?? '');
    this.draft = text.slice(0, text.length - rest.length);
    this.add();
    this.setDraft(rest);
    this.draftChange.emit(rest);
  }

  onKey(event: KeyboardEvent): void {
    if (event.key !== ',' && event.key !== ' ') return;
    event.preventDefault();
    this.add();
  }

  add(): void {
    const typed = splitList(this.draft).filter((value, i, all) => !this.values.includes(value) && all.indexOf(value) === i);
    if (this.draft) {
      this.setDraft('');
      this.draftChange.emit('');
    }
    if (typed.length === 0) return;
    this.values = [...this.values, ...typed];
    this.valuesChange.emit(this.values);
  }

  private setDraft(text: string): void {
    this.draft = text;
    if (this.text) this.text.nativeElement.value = text;
  }

  remove(value: string): void {
    this.values = this.values.filter((item) => item !== value);
    this.valuesChange.emit(this.values);
  }
}

/** `a, b c` → `['a', 'b', 'c']`. */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
