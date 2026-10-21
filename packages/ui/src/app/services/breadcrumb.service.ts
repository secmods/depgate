import { Injectable, signal } from '@angular/core';

/**
 * A page below a nav item (e.g. one policy's monitoring report) sets its own name here; the
 * header then links the nav item and shows this as the current page. The page clears it on destroy.
 */
@Injectable({ providedIn: 'root' })
export class BreadcrumbService {
  readonly detail = signal<string | null>(null);
}
