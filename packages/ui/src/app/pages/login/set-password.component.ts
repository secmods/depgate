import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService } from '../../services/api.service';
import { AuthShellComponent } from '../../shared/auth-shell.component';

/** Opened from an invitation or password reset email. The token in the link proves who they are. */
@Component({
  selector: 'app-set-password',
  standalone: true,
  imports: [FormsModule, RouterLink, AuthShellComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (state === 'checking') {
      <app-auth-shell title="One moment…"><div class="dg-loading"><span class="dg-spinner"></span></div></app-auth-shell>
    } @else if (state === 'invalid') {
      <app-auth-shell title="Link not valid" subtitle="This link has expired or was already used.">
        <p class="text-sm">Request a new one and use it within the time shown in the email.</p>
        <p class="mt-4 text-sm"><a routerLink="/forgot-password" style="color: var(--color-primary, #6366f1)">Send me a new link</a></p>
      </app-auth-shell>
    } @else if (state === 'done') {
      <app-auth-shell title="Password saved" subtitle="You can now sign in with your new password.">
        <a routerLink="/login" class="dg-btn dg-btn-primary dg-btn-lg dg-btn-block">Go to sign in</a>
      </app-auth-shell>
    } @else {
      <app-auth-shell
        [title]="purpose === 'invite' ? 'Set up your account' : 'Choose a new password'"
        [subtitle]="email">
        <form (ngSubmit)="submit()" novalidate>
          <div class="dg-field">
            <label class="form-label" for="password">Password</label>
            <input id="password" name="password" type="password" class="dg-input" style="width: 100%; height: 44px"
              [(ngModel)]="password" autocomplete="new-password" autofocus required />
            <span class="dg-form-help" [class.text-danger]="password.length > 0 && password.length < 8">At least 8 characters.</span>
          </div>
          <div class="dg-field">
            <label class="form-label" for="confirm">Confirm password</label>
            <input id="confirm" name="confirm" type="password" class="dg-input" style="width: 100%; height: 44px"
              [(ngModel)]="confirm" autocomplete="new-password" required />
          </div>
          @if (error) {
            <div class="dg-callout is-danger mb-4" role="alert"><span class="material-symbols-outlined">error</span><span>{{ error }}</span></div>
          }
          <button type="submit" class="dg-btn dg-btn-primary dg-btn-lg dg-btn-block mt-2" [disabled]="saving">
            @if (saving) { <span class="dg-spinner is-sm on-brand" aria-hidden="true"></span> Saving… } @else { Save password }
          </button>
        </form>
      </app-auth-shell>
    }
  `,
})
export class SetPasswordComponent implements OnInit {
  state: 'checking' | 'form' | 'invalid' | 'done' = 'checking';
  purpose: 'invite' | 'reset' = 'reset';
  email = '';
  password = '';
  confirm = '';
  error = '';
  saving = false;

  private token = '';
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') ?? '';
    // Keep the token out of the address bar and browser history once it is read.
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    if (!this.token) {
      this.state = 'invalid';
      return;
    }
    this.api.tokenInfo(this.token).subscribe({
      next: (info) => { this.email = info.email; this.purpose = info.purpose; this.state = 'form'; },
      error: () => (this.state = 'invalid'),
    });
  }

  submit(): void {
    if (this.password.length < 8) {
      this.error = 'Password must be at least 8 characters.';
      return;
    }
    if (this.password !== this.confirm) {
      this.error = 'The two passwords do not match.';
      return;
    }
    this.saving = true;
    this.error = '';
    this.api.setPassword(this.token, this.password).subscribe({
      next: () => { this.saving = false; this.state = 'done'; },
      error: (err) => {
        this.saving = false;
        if (err?.status === 400 && /invalid|expired/i.test(err.error?.error ?? '')) this.state = 'invalid';
        else this.error = err?.error?.error ?? 'Could not save the password. Try again.';
      },
    });
  }
}
