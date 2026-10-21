import { Component, Injector, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';
import { Router } from '@angular/router';
import { MODAL_DATA } from '../../tokens';
import { ConfirmService } from '../../shared/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/empty-state.component';
import { ToastService } from '../../services/toast.service';
import { SigninSettings, SsoProvider, SsoService, daysUntil } from '../../services/sso.service';
import { SsoProviderViewComponent, SsoProviderViewData, SsoProviderViewResult } from './sso-provider-view.component';

/** Access → Single sign-on: the identity providers people sign in with (requirements_sso.md §5.1). */
@Component({
  selector: 'app-sso-settings',
  standalone: true,
  imports: [DatePipe, EmptyStateComponent],
  styles: [`
    .provider-error { font-size: 0.75rem; color: var(--color-danger, #dc2626); max-width: 48ch; display: block; margin-top: 2px; }
    .cert-warn { font-size: 0.75rem; color: var(--color-warning-text, #b45309); display: block; margin-top: 2px; }
    .name-link { background: none; border: none; padding: 0; text-align: left; cursor: pointer; }
    .name-link:hover .dg-cell-primary { color: var(--brand-text, #4f46e5); text-decoration: underline; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (settings && settings.allowedDomains.length === 0) {
      <div class="dg-callout is-warning mb-3" role="status" data-testid="sso-no-domains">
        <span class="material-symbols-outlined">warning</span>
        <span>Add an allowed domain above before turning a provider on.</span>
      </div>
    }

    <section class="dg-card">
      <div class="dg-card-header">
        <div>
          <h2 class="dg-card-title">Identity providers</h2>
          <span class="dg-card-hint">OpenID Connect and SAML 2.0 providers people can sign in with.</span>
        </div>
        <button type="button" class="dg-btn dg-btn-primary dg-btn-sm" (click)="add()" data-testid="sso-add">
          <span class="material-symbols-outlined">add</span> Add provider
        </button>
      </div>
      @if (loading) {
        <div class="dg-loading"><span class="dg-spinner"></span></div>
      } @else if (providers.length === 0) {
        <app-empty-state icon="key" title="No identity providers" description="Add your company's OpenID Connect or SAML provider." [compact]="true" />
      } @else {
        <div class="dg-table-wrap">
          <table class="dg-table">
            <thead><tr><th>Name</th><th>Type</th><th>Last successful sign-in</th><th>On</th><th class="col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>
              @for (row of providers; track row.id) {
                <tr [attr.data-testid]="'sso-row-' + row.name">
                  <td>
                    <button type="button" class="name-link" (click)="view(row)" [attr.data-testid]="'sso-view-' + row.name">
                      <span class="dg-cell-primary">{{ row.name }}</span>
                      <span class="dg-text-variant text-xs d-block">{{ row.oidc?.issuer ?? row.saml?.idpEntityId }}</span>
                    </button>
                    @if (row.lastError) { <span class="provider-error" [title]="row.lastError">{{ row.lastError }}</span> }
                    @if (row.oidc?.clientSecretUnreadable) { <span class="provider-error">Client secret must be entered again.</span> }
                    @if (row.saml?.spPrivateKeyUnreadable) { <span class="provider-error">SP private key must be generated or uploaded again.</span> }
                    @if (row.certificateExpiresAt; as expires) {
                      @if (daysLeft(expires) < 0) {
                        <span class="provider-error" [attr.data-testid]="'sso-cert-expired-' + row.name">Signing certificate expired {{ expires | date: 'mediumDate' }}.</span>
                      } @else if (daysLeft(expires) < 30) {
                        <span class="cert-warn" [attr.data-testid]="'sso-cert-expiring-' + row.name">Signing certificate expires in {{ daysLeft(expires) }} days.</span>
                      }
                    }
                  </td>
                  <td><span class="dg-tag">{{ row.type.toUpperCase() }}</span></td>
                  <td class="dg-text-variant">{{ row.lastSuccessAt ? (row.lastSuccessAt | date: 'medium') : 'Never' }}</td>
                  <td>
                    <button type="button" class="dg-switch" role="switch" [class.is-on]="row.enabled" [attr.aria-checked]="row.enabled"
                      [attr.aria-label]="'Turn ' + row.name + (row.enabled ? ' off' : ' on')" [disabled]="busyId === row.id" (click)="toggle(row)"></button>
                  </td>
                  <td class="col-actions">
                    <button type="button" class="dg-icon-btn" (click)="view(row)" title="View details" aria-label="View provider"><span class="material-symbols-outlined">visibility</span></button>
                    <button type="button" class="dg-icon-btn" (click)="edit(row)" title="Edit" aria-label="Edit provider"><span class="material-symbols-outlined">edit</span></button>
                    <button type="button" class="dg-icon-btn is-danger" (click)="remove(row)" title="Delete" aria-label="Delete provider"><span class="material-symbols-outlined">delete</span></button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>
  `,
})
export class SsoSettingsComponent implements OnInit {
  providers: SsoProvider[] = [];
  settings: SigninSettings | null = null;
  loading = true;
  busyId: string | null = null;

  private sso = inject(SsoService);
  private router = inject(Router);
  private modal = inject(NgbModal);
  private injector = inject(Injector);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  ngOnInit(): void {
    this.load();
  }

  daysLeft(iso: string): number {
    return daysUntil(iso);
  }

  load(): void {
    this.sso.list().subscribe({
      next: (list) => { this.providers = list; this.loading = false; },
      error: (err) => { this.loading = false; this.toast.error(err.error?.error ?? 'Failed to load identity providers'); },
    });
    this.sso.signinSettings().subscribe({ next: (s) => (this.settings = s), error: () => (this.settings = null) });
  }

  add(): void {
    void this.router.navigate(['/access/sso/new']);
  }

  edit(row: SsoProvider): void {
    void this.router.navigate(['/access/sso', row.id, 'edit']);
  }

  toggle(row: SsoProvider): void {
    this.busyId = row.id;
    this.sso.setEnabled(row.id, !row.enabled).subscribe({
      next: (updated) => {
        this.busyId = null;
        this.providers = this.providers.map((p) => (p.id === updated.id ? updated : p));
        this.toast.success(updated.enabled ? `${row.name} is on the login page` : `${row.name} turned off`);
      },
      error: (err) => {
        this.busyId = null;
        this.toast.error(err.error?.error ?? 'Could not change the provider');
        this.load();
      },
    });
  }

  view(row: SsoProvider): void {
    const data: SsoProviderViewData = { provider: row };
    const ref = this.modal.open(SsoProviderViewComponent, {
      size: 'lg',
      scrollable: true,
      injector: Injector.create({ providers: [{ provide: MODAL_DATA, useValue: data }], parent: this.injector }),
    });
    ref.closed.subscribe((result: SsoProviderViewResult) => {
      if (result === 'edit') this.edit(row);
      else if (result === 'changed') this.load();
    });
  }

  async remove(row: SsoProvider): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete identity provider?',
      message: `${row.name} disappears from the login page and its account links are removed. The people stay under Users; those without a password will need an invitation to sign in.`,
      confirmText: 'Delete provider',
    });
    if (!ok) return;
    this.sso.delete(row.id).subscribe({
      next: () => { this.toast.success(`Deleted ${row.name}`); this.load(); },
      error: (err) => this.toast.error(err.error?.error ?? 'Delete failed'),
    });
  }
}
