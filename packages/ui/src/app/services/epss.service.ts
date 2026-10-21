import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

/** The EPSS data DepGate holds: synced daily from FIRST's feed (or its GitHub backup) into its own table. */
export interface EpssStatus {
  state: 'idle' | 'running' | 'completed' | 'failed';
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  /** Timestamp from the file, e.g. 2026-10-12T12:00:26Z. */
  scoreDate: string | null;
  modelVersion: string | null;
  rowCount: number | null;
  lastError: string | null;
  /** The feed URL, or the GitHub backup file the scores came from. */
  feedSource: string | null;
  enabled: boolean;
  /** Never synced, or older than EPSS_STALE_AFTER_HOURS. */
  stale: boolean;
  staleAfterHours: number;
}

@Injectable({ providedIn: 'root' })
export class EpssService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private headers(): { [k: string]: string } {
    const token = this.auth.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  status(): Observable<EpssStatus> {
    return this.http.get<EpssStatus>('/api/admin/epss/status', { headers: this.headers() });
  }

  sync(): Observable<{ started: boolean; jobId: string | null }> {
    return this.http.post<{ started: boolean; jobId: string | null }>('/api/admin/epss/sync', {}, { headers: this.headers() });
  }
}
