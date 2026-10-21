import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { PackageCount } from '../services/dashboard.service';
import { EcoTagComponent } from '../shared/eco-tag.component';

const BAR_COLORS = {
  allow: 'var(--success-solid)',
  block: 'var(--danger-solid)',
} as const;

/** Ranked list with a magnitude bar per package. */
@Component({
  selector: 'app-top-packages-chart',
  standalone: true,
  imports: [DecimalPipe, EcoTagComponent],
  styles: [`
    :host { display: block; }
    .pkg { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 6px 0; }
    .name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 0.8125rem; font-weight: 500; color: var(--color-on-surface); }
    .name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { font-size: 0.8125rem; font-weight: 600; color: var(--color-on-surface-variant); font-variant-numeric: tabular-nums; }
    .track { grid-column: 1 / -1; height: 6px; border-radius: 999px; background: var(--color-surface-container); overflow: hidden; }
    .bar { height: 100%; border-radius: 999px; transition: width 0.3s; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @for (p of rows; track p.ecosystem + p.packageName) {
      <div class="pkg" [title]="p.ecosystem + '/' + p.packageName + ': ' + (p.count | number)">
        <div class="name">
          <app-eco-tag [ecosystem]="p.ecosystem" />
          <span>{{ p.packageName }}</span>
        </div>
        <span class="count">{{ p.count | number }}</span>
        <div class="track"><div class="bar" [style.width.%]="(p.count / max) * 100" [style.background]="color"></div></div>
      </div>
    }
  `,
})
export class TopPackagesChartComponent {
  @Input() data: PackageCount[] = [];
  @Input() type: 'allow' | 'block' = 'allow';
  @Input() maxCount = 1;
  @Input() limit = 8;

  get rows(): PackageCount[] {
    return this.data.slice(0, this.limit);
  }

  get max(): number {
    return Math.max(1, this.maxCount);
  }

  get color(): string {
    return BAR_COLORS[this.type];
  }
}
