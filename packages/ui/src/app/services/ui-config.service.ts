import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';

/** Deployment settings from .env, which the server writes into index.html as meta tags. */
@Injectable({ providedIn: 'root' })
export class UiConfigService {
  private document = inject(DOCUMENT);

  /** DOCS_URL, or empty when it is unset (and under ng serve, which does not fill the tags in). */
  readonly docsUrl: string = this.httpUrl(this.meta('depgate-docs-url'));

  private meta(name: string): string {
    return this.document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content.trim() ?? '';
  }

  private httpUrl(value: string): string {
    return /^https?:\/\//i.test(value) ? value : '';
  }
}
