import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface AuditLogEntry {
  id: string;
  requesterIp: string | null;
  requester: string | null;
  userAgent: string | null;
  ecosystem: string;
  packageName: string;
  resolvedVersion: string | null;
  /** Repository key the request went through; null for administrative events. */
  repository?: string | null;
  decision: string;
  policyId: string | null;
  policyName: string | null;
  conditionReasons: string[] | null;
  metadata: Record<string, string> | null;
  createdAt: string;
}

export interface AuditLogResponse {
  items: AuditLogEntry[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class AuditService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(params: {
    ecosystem?: string;
    /** Repository key the request went through, e.g. `default`. */
    repository?: string;
    package?: string;
    decision?: string;
    /** password, oidc or saml: how a LOGIN_* event signed in. */
    method?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Observable<AuditLogResponse> {
    let httpParams = new HttpParams();
    if (params.ecosystem) httpParams = httpParams.set('ecosystem', params.ecosystem);
    if (params.package) httpParams = httpParams.set('package', params.package);
    if (params.decision) httpParams = httpParams.set('decision', params.decision);
    if (params.repository) httpParams = httpParams.set('repository', params.repository);
    if (params.method) httpParams = httpParams.set('method', params.method);
    if (params.from) httpParams = httpParams.set('from', params.from);
    if (params.to) httpParams = httpParams.set('to', params.to);
    if (params.limit != null) httpParams = httpParams.set('limit', params.limit.toString());
    if (params.offset != null) httpParams = httpParams.set('offset', params.offset.toString());

    return this.http.get<AuditLogResponse>(`${this.base}/admin/audit-logs`, {
      headers: this.headers(),
      params: httpParams,
    });
  }
}
