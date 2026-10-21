import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface RegistryCreatePayload {
  ecosystem: string;
  url: string;
  priority?: number;
  timeoutMs?: number;
  retryCount?: number;
  authType?: 'bearer' | 'basic' | 'header' | null;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}

export interface RegistryUpdatePayload {
  url?: string;
  priority?: number;
  isEnabled?: boolean;
  timeoutMs?: number;
  retryCount?: number;
  authType?: 'bearer' | 'basic' | 'header' | null;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}

export interface UpstreamRegistry {
  id: string;
  ecosystem: string;
  url: string;
  priority: number;
  isEnabled: boolean;
  timeoutMs: number;
  retryCount: number;
  authConfigured: boolean;
  authType?: string | null;
  /** Masked username from backend when auth is configured (basic). Display only. */
  usernameMasked?: string | null;
  /** Masked password from backend when auth is configured (basic). Display only. */
  passwordMasked?: string | null;
  /** Masked token from backend when auth is configured (bearer). Display only. */
  tokenMasked?: string | null;
  headerNameMasked?: string | null;
  headerValueMasked?: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class UpstreamRegistryService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(ecosystem?: string): Observable<UpstreamRegistry[]> {
    let params = new HttpParams();
    if (ecosystem) params = params.set('ecosystem', ecosystem);
    return this.http.get<UpstreamRegistry[]>(`${this.base}/admin/upstream-registries`, {
      headers: this.headers(),
      params,
    });
  }

  create(data: RegistryCreatePayload): Observable<UpstreamRegistry> {
    return this.http.post<UpstreamRegistry>(`${this.base}/admin/upstream-registries`, data, {
      headers: this.headers(),
    });
  }

  update(id: string, data: RegistryUpdatePayload): Observable<{ id: string }> {
    return this.http.put<{ id: string }>(`${this.base}/admin/upstream-registries/${id}`, data, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/upstream-registries/${id}`, {
      headers: this.headers(),
    });
  }

  test(id: string): Observable<{ ok: boolean; latencyMs: number }> {
    return this.http.post<{ ok: boolean; latencyMs: number }>(
      `${this.base}/admin/upstream-registries/${id}/test`,
      {},
      { headers: this.headers() }
    );
  }

  testConnection(payload: {
    ecosystem: string;
    url: string;
    timeoutMs?: number;
    authType?: string | null;
    authToken?: string;
    authUsername?: string;
    authPassword?: string;
    authHeaderName?: string;
    authHeaderValue?: string;
  }): Observable<{ ok: boolean; latencyMs: number }> {
    return this.http.post<{ ok: boolean; latencyMs: number }>(
      `${this.base}/admin/upstream-registries/test-connection`,
      payload,
      { headers: this.headers() }
    );
  }
}
