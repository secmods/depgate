import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { statusLabel, statusTone, Tone } from './status';

/** The one way to render a status or decision value. */
@Component({
  selector: 'app-status-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="dg-pill" [class]="'dg-pill dg-pill-' + resolvedTone">
      <span class="dg-pill-dot" aria-hidden="true"></span>{{ label || resolvedLabel }}
    </span>
  `,
})
export class StatusPillComponent {
  @Input({ required: true }) value: string | null | undefined = '';
  @Input() label = '';
  @Input() tone: Tone | null = null;

  get resolvedTone(): Tone {
    return this.tone ?? statusTone(this.value);
  }

  get resolvedLabel(): string {
    return statusLabel(this.value);
  }
}
