import { Component, Input, ChangeDetectionStrategy } from '@angular/core';

/** Centered card for the pages people reach from an email link, before they are signed in. */
@Component({
  selector: 'app-auth-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="min-h-screen flex items-center justify-center p-6">
      <div class="w-full max-w-[400px]">
        <img src="depgate-logo-light.png" alt="DepGate" class="h-11 w-auto mb-10" />
        <h1 class="dg-page-title" style="font-size: 1.625rem">{{ title }}</h1>
        @if (subtitle) { <p class="dg-page-subtitle">{{ subtitle }}</p> }
        <div class="mt-8"><ng-content /></div>
      </div>
    </div>
  `,
})
export class AuthShellComponent {
  @Input({ required: true }) title = '';
  @Input() subtitle = '';
}
