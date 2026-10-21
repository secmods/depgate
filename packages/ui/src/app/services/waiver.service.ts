import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import type { RepositoryRef } from '../shared/repository-scope';

export type WaiverStatus = 'pending' | 'approved' | 'rejected';

export interface WaiverRequest {
  id: string;
  packageName: string;
  ecosystem: string;
  version: string;
  requestedExpiresAt: string;
  approvedExpiresAt: string | null;
  reason: string;
  status: WaiverStatus;
  requestedBy: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  exceptionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  /** Repositories the waiver is for. Empty: every repository. */
  repositoryIds?: string[];
  repositories?: RepositoryRef[];
}

@Injectable({ providedIn: 'root' })
export class WaiverService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(params: { status?: WaiverStatus; ecosystem?: string; package?: string; limit?: number; offset?: number } = {}): Observable<{ items: WaiverRequest[]; total: number }> {
    let httpParams = new HttpParams();
    if (params.status) httpParams = httpParams.set('status', params.status);
    if (params.ecosystem) httpParams = httpParams.set('ecosystem', params.ecosystem);
    if (params.package) httpParams = httpParams.set('package', params.package);
    if (params.limit != null) httpParams = httpParams.set('limit', String(params.limit));
    if (params.offset != null) httpParams = httpParams.set('offset', String(params.offset));
    return this.http.get<{ items: WaiverRequest[]; total: number }>(`${this.base}/waiver-requests`, {
      headers: this.headers(),
      params: httpParams,
    });
  }

  create(body: {
    packageName: string;
    ecosystem: string;
    version: string;
    expiresAt: string;
    reason: string;
    repositoryIds?: string[];
  }): Observable<WaiverRequest> {
    return this.http.post<WaiverRequest>(`${this.base}/waiver-requests`, body, {
      headers: this.headers(),
    });
  }

  update(
    id: string,
    body: {
      packageName: string;
      ecosystem: string;
      version: string;
      expiresAt: string;
      reason: string;
      repositoryIds?: string[];
    }
  ): Observable<WaiverRequest> {
    return this.http.patch<WaiverRequest>(`${this.base}/waiver-requests/${id}`, body, {
      headers: this.headers(),
    });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/waiver-requests/${id}`, {
      headers: this.headers(),
    });
  }

  approve(
    id: string,
    body: { expiresAt: string; reviewNote?: string; repositoryIds?: string[] }
  ): Observable<WaiverRequest> {
    return this.http.post<WaiverRequest>(`${this.base}/waiver-requests/${id}/approve`, body, {
      headers: this.headers(),
    });
  }

  reject(id: string, body: { reviewNote?: string } = {}): Observable<WaiverRequest> {
    return this.http.post<WaiverRequest>(`${this.base}/waiver-requests/${id}/reject`, body, {
      headers: this.headers(),
    });
  }
}
