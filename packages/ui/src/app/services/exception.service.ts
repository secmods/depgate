import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import type { RepositoryRef } from '../shared/repository-scope';

export interface ExceptionEntry {
  id: string;
  packageName: string;
  ecosystem: string;
  version: string;
  expiresAt: string;
  reason: string | null;
  approvedBy: string;
  createdAt: string;
  /** null: covers every policy. Set: an approval for that policy only, from the Monitoring page. */
  policyId?: string | null;
  policyName?: string | null;
  /** Repositories the exception applies to. Empty: every repository. */
  repositoryIds?: string[];
  repositories?: RepositoryRef[];
}

/** all: exceptions for every policy (the default). scoped: every policy's approvals. any: both. Otherwise one policy's approvals. */
export type ExceptionScope = 'all' | 'scoped' | 'any' | string;

@Injectable({ providedIn: 'root' })
export class ExceptionService {
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
    package?: string;
    expired?: 'true' | 'false';
    appliesTo?: ExceptionScope;
    repositoryId?: string;
    limit?: number;
    offset?: number;
  } = {}): Observable<{ items: ExceptionEntry[]; total: number; active: number; expired: number }> {
    let httpParams = new HttpParams();
    if (params.appliesTo) httpParams = httpParams.set('appliesTo', params.appliesTo);
    if (params.ecosystem) httpParams = httpParams.set('ecosystem', params.ecosystem);
    if (params.package) httpParams = httpParams.set('package', params.package);
    if (params.expired) httpParams = httpParams.set('expired', params.expired);
    if (params.repositoryId) httpParams = httpParams.set('repositoryId', params.repositoryId);
    if (params.limit != null) httpParams = httpParams.set('limit', String(params.limit));
    if (params.offset != null) httpParams = httpParams.set('offset', String(params.offset));

    return this.http.get<{ items: ExceptionEntry[]; total: number; active: number; expired: number }>(`${this.base}/admin/exceptions`, {
      headers: this.headers(),
      params: httpParams,
    });
  }

  create(body: {
    packageName: string;
    ecosystem: string;
    version: string;
    expiresAt: string;
    reason?: string;
    repositoryIds?: string[];
  }): Observable<ExceptionEntry> {
    return this.http.post<ExceptionEntry>(`${this.base}/admin/exceptions`, body, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/exceptions/${id}`, {
      headers: this.headers(),
    });
  }
}
