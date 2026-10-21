import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export type RepositoryType = 'remote' | 'virtual';

/** Only internal remotes may serve names in a reserved internal namespace. */
export type RepositorySource = 'public' | 'internal';

export interface PackageRepositoryRow {
  id: string;
  ecosystem: string;
  key: string;
  type: RepositoryType;
  upstreamUrl: string | null;
  /** Remotes only; null for virtual repositories. */
  source?: RepositorySource | null;
  /** An internal remote whose URL is a well-known public registry. */
  looksPublic?: boolean;
  priority: number;
  isEnabled: boolean;
  isReserved: boolean;
  timeoutMs: number;
  retryCount: number;
  description: string | null;
  clientPath: string;
  memberKeys: string[];
  authConfigured: boolean;
  authType: string | null;
  createdAt: string;
}

export interface RepositoryWritePayload {
  ecosystem?: string;
  key?: string;
  type?: RepositoryType;
  upstreamUrl?: string;
  source?: RepositorySource;
  isEnabled?: boolean;
  timeoutMs?: number;
  retryCount?: number;
  description?: string;
  memberKeys?: string[];
  authType?: 'bearer' | 'basic' | 'header' | null;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}

/** An enabled policy that applies to a repository: limited to it, or to every repository. */
export interface EffectivePolicy {
  id: string;
  name: string;
  decision: 'ALLOW' | 'BLOCK';
  mode: 'enforce' | 'monitor';
  priority: number;
  scope: 'scoped' | 'global';
}

/** What deleting a repository changes. `onlyRepository`: this was the last repository in its scope. */
export interface RepositoryUsage {
  policies: Array<{ id: string; name: string; isEnabled: boolean; onlyRepository: boolean }>;
  exceptions: Array<{ id: string; packageName: string; version: string; onlyRepository: boolean }>;
  waivers: Array<{ id: string; packageName: string; version: string; onlyRepository: boolean }>;
  /** Internal namespace policies that allow this remote; `onlyRemote`: it is the only one they allow. */
  namespacePolicies?: Array<{ id: string; name: string; onlyRemote: boolean }>;
}

@Injectable({ providedIn: 'root' })
export class RepositoryService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(ecosystem?: string): Observable<PackageRepositoryRow[]> {
    let params = new HttpParams();
    if (ecosystem) params = params.set('ecosystem', ecosystem);
    return this.http.get<PackageRepositoryRow[]>(`${this.base}/admin/repositories`, {
      headers: this.headers(),
      params,
    });
  }

  create(data: RepositoryWritePayload): Observable<PackageRepositoryRow> {
    return this.http.post<PackageRepositoryRow>(`${this.base}/admin/repositories`, data, {
      headers: this.headers(),
    });
  }

  update(id: string, data: RepositoryWritePayload): Observable<PackageRepositoryRow> {
    return this.http.put<PackageRepositoryRow>(`${this.base}/admin/repositories/${id}`, data, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/repositories/${id}`, {
      headers: this.headers(),
    });
  }

  policies(id: string): Observable<EffectivePolicy[]> {
    return this.http.get<EffectivePolicy[]>(`${this.base}/admin/repositories/${id}/policies`, {
      headers: this.headers(),
    });
  }

  usage(id: string): Observable<RepositoryUsage> {
    return this.http.get<RepositoryUsage>(`${this.base}/admin/repositories/${id}/usage`, {
      headers: this.headers(),
    });
  }

  test(id: string): Observable<{ ok: boolean; latencyMs: number }> {
    return this.http.post<{ ok: boolean; latencyMs: number }>(
      `${this.base}/admin/repositories/${id}/test`,
      {},
      { headers: this.headers() }
    );
  }
}
