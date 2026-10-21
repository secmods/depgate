import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

/** Icon, title, description and an optional projected action. */
@Component({
  selector: 'app-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dg-empty-state" [class.is-compact]="compact">
      <div class="dg-empty-icon"><span class="material-symbols-outlined">{{ icon }}</span></div>
      <p class="dg-empty-title">{{ title }}</p>
      @if (description) {
        <p class="dg-empty-desc">{{ description }}</p>
      }
      <div class="dg-empty-action"><ng-content /></div>
    </div>
  `,
})
export class EmptyStateComponent {
  @Input() icon = 'inbox';
  @Input({ required: true }) title = '';
  @Input() description = '';
  @Input() compact = false;
}
