import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { ecosystemLabel } from './status';

@Component({
  selector: 'app-eco-tag',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="dg-eco">{{ label }}</span>`,
})
export class EcoTagComponent {
  @Input({ required: true }) ecosystem: string | null | undefined = '';

  get label(): string {
    return ecosystemLabel(this.ecosystem);
  }
}
