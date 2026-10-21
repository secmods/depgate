import { Component, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { AuthShellComponent } from '../../shared/auth-shell.component';

/** The pop-up of a provider test lands here. The Settings page shows the result. */
@Component({
  selector: 'app-sso-test-done',
  standalone: true,
  imports: [AuthShellComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <app-auth-shell title="Test finished" subtitle="The result is shown in DepGate Settings. You can close this window.">
      <button type="button" class="dg-btn dg-btn-secondary dg-btn-block" (click)="close()">Close window</button>
    </app-auth-shell>
  `,
})
export class SsoTestDoneComponent implements OnInit {
  ngOnInit(): void {
    setTimeout(() => this.close(), 1500);
  }

  close(): void {
    window.close();
  }
}
