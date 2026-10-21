import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface WebhookTarget {
  id: string;
  url: string;
  secretConfigured: boolean;
  events: string[];
  /** Stored events that are no longer sent (policy_violation, integrity_violation). Saving the webhook removes them. */
  deprecatedEvents?: string[];
  isEnabled: boolean;
  /** Deliveries that failed in a row; the webhook is disabled at `disableAfterFailures`. */
  consecutiveFailures?: number;
  disableAfterFailures?: number;
  lastError?: string | null;
  lastFailureAt?: string | null;
  disabledAutomatically?: boolean;
  disabledAt?: string | null;
  disabledReason?: string | null;
  deprecations?: string[];
  createdAt: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'skipped';

export interface WebhookDelivery {
  id: string;
  eventId: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  payload: Record<string, unknown>;
}

/** Webhook events as the form groups them (requirements_event_streaming.md §8.5). */
export const WEBHOOK_EVENT_GROUPS: Array<{ label: string; events: Array<{ event: string; label: string; isDefault: boolean }> }> = [
  {
    label: 'Packages',
    events: [
      { event: 'package_blocked', label: 'Package blocked', isDefault: true },
    ],
  },
  {
    label: 'Malware and attacks',
    events: [
      { event: 'malware_requested', label: 'Malware requested (blocked or let through)', isDefault: true },
      { event: 'dependency_confusion_blocked', label: 'Dependency confusion blocked', isDefault: true },
    ],
  },
  { label: 'Namespace', events: [{ event: 'namespace_collision', label: 'Namespace collision found', isDefault: false }] },
];

const EVENTS = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.events.map((e) => e.event));

@Injectable({ providedIn: 'root' })
export class WebhookService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(): Observable<WebhookTarget[]> {
    return this.http.get<WebhookTarget[]>(`${this.base}/admin/webhooks`, {
      headers: this.headers(),
    });
  }

  create(data: { url: string; secret?: string; events?: string[]; isEnabled?: boolean }): Observable<WebhookTarget> {
    return this.http.post<WebhookTarget>(`${this.base}/admin/webhooks`, data, {
      headers: this.headers(),
    });
  }

  update(id: string, data: Partial<WebhookTarget>): Observable<WebhookTarget> {
    return this.http.put<WebhookTarget>(`${this.base}/admin/webhooks/${id}`, data, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/webhooks/${id}`, {
      headers: this.headers(),
    });
  }

  /** One test request; not recorded and not counted toward disabling. */
  test(id: string): Observable<{ ok: boolean; statusCode: number | null; error: string | null }> {
    return this.http.post<{ ok: boolean; statusCode: number | null; error: string | null }>(
      `${this.base}/admin/webhooks/${id}/test`,
      {},
      { headers: this.headers() }
    );
  }

  deliveries(id: string, opts: { status?: WebhookDeliveryStatus; limit?: number; offset?: number } = {}): Observable<{ items: WebhookDelivery[]; total: number }> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.limit) params = params.set('limit', String(opts.limit));
    if (opts.offset) params = params.set('offset', String(opts.offset));
    return this.http.get<{ items: WebhookDelivery[]; total: number }>(`${this.base}/admin/webhooks/${id}/deliveries`, {
      headers: this.headers(),
      params,
    });
  }

  redeliver(id: string, deliveryId: string): Observable<{ queued: boolean; deliveryId: string; eventId: string }> {
    return this.http.post<{ queued: boolean; deliveryId: string; eventId: string }>(
      `${this.base}/admin/webhooks/${id}/deliveries/${deliveryId}/redeliver`,
      {},
      { headers: this.headers() }
    );
  }

  redeliverSkipped(id: string): Observable<{ queued: number }> {
    return this.http.post<{ queued: number }>(`${this.base}/admin/webhooks/${id}/redeliver-skipped`, {}, { headers: this.headers() });
  }

  getEvents(): string[] {
    return [...EVENTS];
  }
}
