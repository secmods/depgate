import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface MaliciousPackage {
  id: string;
  name: string;
  ecosystem: string;
  reason: string | null;
  sourceUrl: string | null;
  source: string;
  versionRange: string | null;
  overrideStatus: 'BLOCK' | 'ALLOW';
  overrideReason: string | null;
  createdAt: string;
}

export interface SyncStatus {
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  phase?: string;
  ecosystem?: string;
  fetched?: number;
  added?: number;
  total?: number;
  removed?: number;
  error?: string;
  mode?: string;
}

export interface MaliciousFeedState {
  watermark: string;
  schemaVersion: string;
  upstreamRepo: string | null;
  upstreamCommit: string | null;
  changesSince: string;
  changesWindowDays: number;
  totalRecords: number;
  appliedAt: string;
  ecosystems: Record<string, { records: number; maxModified: string | null; changesRecords: number }>;
}

export interface MaliciousMetadata {
  lastSyncAt: string | null;
  syncStatus?: SyncStatus | null;
  feed?: MaliciousFeedState | null;
}

export interface MaliciousListResponse {
  items: MaliciousPackage[];
  total: number;
}

export interface SyncResult {
  added: number;
  removed: number;
  total: number;
}

export interface SyncStartResponse {
  started: boolean;
}

@Injectable({ providedIn: 'root' })
export class MaliciousService {
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
    name?: string;
    source?: 'all' | 'custom' | 'feed';
    status?: 'BLOCK' | 'ALLOW';
    limit?: number;
    offset?: number;
  } = {}): Observable<MaliciousListResponse> {
    let httpParams = new HttpParams();
    if (params.ecosystem) httpParams = httpParams.set('ecosystem', params.ecosystem);
    if (params.name) httpParams = httpParams.set('name', params.name);
    if (params.source) httpParams = httpParams.set('source', params.source);
    if (params.status) httpParams = httpParams.set('status', params.status);
    if (params.limit != null) httpParams = httpParams.set('limit', params.limit.toString());
    if (params.offset != null) httpParams = httpParams.set('offset', params.offset.toString());

    return this.http.get<MaliciousListResponse>(`${this.base}/admin/malicious-packages`, {
      headers: this.headers(),
      params: httpParams,
    });
  }

  getMetadata(): Observable<MaliciousMetadata> {
    return this.http.get<MaliciousMetadata>(`${this.base}/admin/malicious-packages/metadata`, {
      headers: this.headers(),
    });
  }

  setOverride(id: string, overrideStatus: 'BLOCK' | 'ALLOW', overrideReason?: string): Observable<MaliciousPackage> {
    return this.http.put<MaliciousPackage>(
      `${this.base}/admin/malicious-packages/${id}/override`,
      { overrideStatus, overrideReason: overrideReason || undefined },
      { headers: this.headers() }
    );
  }

  create(name: string, ecosystem: string, versionRange?: string): Observable<MaliciousPackage> {
    return this.http.post<MaliciousPackage>(
      `${this.base}/admin/malicious-packages`,
      { name, ecosystem, versionRange: versionRange || undefined },
      { headers: this.headers() }
    );
  }

  update(id: string, data: { name?: string; ecosystem?: string; versionRange?: string | null }): Observable<MaliciousPackage> {
    return this.http.put<MaliciousPackage>(
      `${this.base}/admin/malicious-packages/${id}`,
      data,
      { headers: this.headers() }
    );
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/malicious-packages/${id}`, {
      headers: this.headers(),
    });
  }

  /** Starts sync in background. Returns 202 immediately. Poll getMetadata() for progress. */
  sync(): Observable<SyncStartResponse> {
    return this.http.post<SyncStartResponse>(`${this.base}/admin/malicious-packages/sync`, {}, {
      headers: this.headers(),
    });
  }
}
