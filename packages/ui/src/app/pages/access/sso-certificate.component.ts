import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { DatePipe } from '@angular/common';
import { CertificateInfo, daysUntil } from '../../services/sso.service';

/** One X.509 certificate: subject, issuer, SHA-256 fingerprint and expiry, warned 30 days ahead (requirements_sso.md R3). */
@Component({
  selector: 'app-sso-certificate',
  standalone: true,
  imports: [DatePipe],
  styles: [`
    :host { display: block; }
    .cert { border: 1px solid var(--color-border); border-radius: var(--radius, 8px); padding: 8px 10px; font-size: 0.8125rem; min-width: 0; }
    .cert.is-warn { border-color: var(--color-warning-border, #f59e0b); background: var(--color-warning-bg, rgba(245, 158, 11, 0.06)); }
    .cert.is-bad { border-color: var(--color-danger, #dc2626); background: rgba(220, 38, 38, 0.05); }
    .head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
    .subject { font-weight: 600; overflow-wrap: anywhere; }
    .facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 2px 10px; margin: 6px 0 0; }
    .facts dt { color: var(--color-on-surface-variant); font-weight: 500; }
    .facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.75rem; }
    .expiry-warn { color: var(--color-warning-text, #b45309); font-weight: 600; }
    .expiry-bad { color: var(--color-danger, #dc2626); font-weight: 600; }
  `],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    @if (info) {
      <div class="cert" [class.is-warn]="!info.expired && info.expiresSoon" [class.is-bad]="info.expired" data-testid="sso-certificate">
        <div class="head">
          <span class="subject">{{ label ? label + ': ' : '' }}{{ info.subject }}</span>
          <ng-content />
        </div>
        <dl class="facts">
          <dt>Issuer</dt><dd>{{ info.issuer }}</dd>
          <dt>SHA-256</dt><dd class="mono">{{ info.fingerprint }}</dd>
          <dt>Expires</dt>
          <dd>
            {{ info.notAfter | date: 'mediumDate' }}
            @if (info.expired) { <span class="expiry-bad" data-testid="sso-cert-expired">· expired</span> }
            @else if (info.expiresSoon) { <span class="expiry-warn" data-testid="sso-cert-expiring">· in {{ days }} days</span> }
          </dd>
        </dl>
      </div>
    } @else {
      <div class="cert is-bad"><span class="subject">{{ label ? label + ': ' : '' }}This certificate could not be read.</span><ng-content /></div>
    }
  `,
})
export class SsoCertificateComponent {
  @Input() info: CertificateInfo | null = null;
  @Input() label = '';

  get days(): number {
    return this.info ? Math.max(0, daysUntil(this.info.notAfter)) : 0;
  }
}
