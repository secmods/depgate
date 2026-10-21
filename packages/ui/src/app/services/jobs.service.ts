import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export type QueueName = 'webhooks' | 'scheduled' | 'email' | 'monitor';
export type ScheduledJob =
  | 'namespace-collision-check'
  | 'malicious-feed-sync'
  | 'monitor-retention-purge'
  | 'epss-sync'
  | 'event-retention-purge';

export interface QueueCounts {
  name: QueueName;
  available: boolean;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface JobRunRow {
  id: string;
  trigger: 'scheduled' | 'manual' | 'startup';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface ScheduleRow {
  job: ScheduledJob;
  everyMs: number | null;
  nextRunAt: string | null;
  runs: JobRunRow[];
}

export interface FailedJob {
  queue: QueueName;
  id: string;
  job: string;
  attempts: number;
  maxAttempts: number;
  error: string;
  failedAt: string;
  ids: Record<string, string>;
}

@Injectable({ providedIn: 'root' })
export class JobsService {
  private base = '/api/admin/jobs';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  overview(): Observable<{ available: boolean; queues: QueueCounts[]; schedules: ScheduleRow[] }> {
    return this.http.get<{ available: boolean; queues: QueueCounts[]; schedules: ScheduleRow[] }>(this.base, { headers: this.headers() });
  }

  failed(queue?: QueueName): Observable<{ items: FailedJob[] }> {
    const params = queue ? new HttpParams().set('queue', queue) : undefined;
    return this.http.get<{ items: FailedJob[] }>(`${this.base}/failed`, { headers: this.headers(), params });
  }

  retry(queue: QueueName, id: string): Observable<{ retried: boolean }> {
    return this.http.post<{ retried: boolean }>(`${this.base}/${queue}/${encodeURIComponent(id)}/retry`, {}, { headers: this.headers() });
  }

  discard(queue: QueueName, id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${queue}/${encodeURIComponent(id)}`, { headers: this.headers() });
  }

  runNow(job: ScheduledJob): Observable<{ queued: boolean; jobId: string }> {
    return this.http.post<{ queued: boolean; jobId: string }>(`${this.base}/scheduled/${job}/run`, {}, { headers: this.headers() });
  }
}
