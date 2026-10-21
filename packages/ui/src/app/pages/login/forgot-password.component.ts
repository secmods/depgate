import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AuthShellComponent } from '../../shared/auth-shell.component';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [FormsModule, RouterLink, AuthShellComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <app-auth-shell title="Reset your password" subtitle="Enter your email and we will send you a link to choose a new password.">
      @if (sent) {
        <div class="dg-callout is-success mb-4" role="status">
          <span class="material-symbols-outlined">mark_email_read</span>
          <span>If that address has an account, we have sent it a link. It expires soon and works once.</span>
        </div>
      } @else {
        <form (ngSubmit)="submit()" novalidate>
          <div class="dg-field">
            <label class="form-label" for="email">Email</label>
            <input id="email" name="email" type="email" class="dg-input" style="width: 100%; height: 44px"
              [(ngModel)]="email" autocomplete="email" autofocus required />
          </div>
          @if (error) {
            <div class="dg-callout is-danger mb-4" role="alert"><span class="material-symbols-outlined">error</span><span>{{ error }}</span></div>
          }
          <button type="submit" class="dg-btn dg-btn-primary dg-btn-lg dg-btn-block mt-2" [disabled]="loading">
            @if (loading) { <span class="dg-spinner is-sm on-brand" aria-hidden="true"></span> Sending… } @else { Send reset link }
          </button>
        </form>
      }
      <p class="mt-6 text-sm"><a routerLink="/login" style="color: var(--color-primary, #6366f1)">Back to sign in</a></p>
    </app-auth-shell>
  `,
})
export class ForgotPasswordComponent {
  email = '';
  loading = false;
  sent = false;
  error = '';

  private api = inject(ApiService);

  submit(): void {
    if (!this.email.trim()) {
      this.error = 'Enter your email.';
      return;
    }
    this.loading = true;
    this.error = '';
    this.api.forgotPassword(this.email.trim()).subscribe({
      next: () => { this.loading = false; this.sent = true; },
      error: () => { this.loading = false; this.error = 'Could not send the request. Try again.'; },
    });
  }
}
