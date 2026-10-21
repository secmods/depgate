import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';

export type RangePreset = '24h' | '7d' | '30d' | 'custom' | 'all';

export interface TimeRange {
  preset: RangePreset;
  /** Local calendar days, for the custom range. */
  fromDay: string;
  toDay: string;
}

const HOUR = 3_600_000;

/** The time range of an event page as API bounds: rolling for the presets, whole local days for custom. */
export function rangeBounds(range: TimeRange, now = Date.now()): { from?: string; to?: string } {
  switch (range.preset) {
    case '24h':
      return { from: new Date(now - 24 * HOUR).toISOString() };
    case '7d':
      return { from: new Date(now - 7 * 24 * HOUR).toISOString() };
    case '30d':
      return { from: new Date(now - 30 * 24 * HOUR).toISOString() };
    case 'custom':
      return {
        from: range.fromDay ? new Date(`${range.fromDay}T00:00:00`).toISOString() : undefined,
        to: range.toDay ? new Date(`${range.toDay}T23:59:59.999`).toISOString() : undefined,
      };
    default:
      return {};
  }
}

/** Last 24 h / 7 d / 30 d / custom (§10.2). */
@Component({
  selector: 'app-time-range',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="dg-filter">
      <span>Time</span>
      <select class="dg-select" [ngModel]="range.preset" (ngModelChange)="set({ preset: $event })" data-testid="time-range">
        <option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="all">All time</option>
        <option value="custom">Custom…</option>
      </select>
    </label>
    @if (range.preset === 'custom') {
      <label class="dg-filter">
        <span>From</span>
        <input type="date" class="dg-input" [ngModel]="range.fromDay" (ngModelChange)="set({ fromDay: $event })" [max]="range.toDay || null" />
      </label>
      <label class="dg-filter">
        <span>To</span>
        <input type="date" class="dg-input" [ngModel]="range.toDay" (ngModelChange)="set({ toDay: $event })" [min]="range.fromDay || null" />
      </label>
    }
  `,
  styles: [`:host { display: contents; }`],
})
export class TimeRangeComponent {
  @Input() range: TimeRange = { preset: '7d', fromDay: '', toDay: '' };
  @Output() rangeChange = new EventEmitter<TimeRange>();

  set(patch: Partial<TimeRange>): void {
    this.range = { ...this.range, ...patch };
    this.rangeChange.emit(this.range);
  }
}
