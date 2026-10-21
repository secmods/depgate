import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, shareReplay } from 'rxjs';
import { AuthService } from './auth.service';

/** The one event format (requirements_event_streaming.md §6.1): what "Copy as JSON" copies and what a SIEM receives. */
export type EventEnvelope = Record<string, unknown> & { id: string; type: string; time: string };

export interface EventActor {
  kind: string | null;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  authMethod: string | null;
  metadata: Record<string, string>;
}

export interface LedgerRow {
  id: string;
  createdAt: string;
  decision: string;
  malware: boolean;
  ecosystem: string;
  packageName: string;
  version: string | null;
  repository: string | null;
  policyId: string | null;
  policyName: string | null;
  reasons: string[];
  actor: EventActor;
  build: string | null;
  details: Record<string, unknown>;
  event: EventEnvelope;
}

export interface AuditRow {
  id: string;
  createdAt: string;
  type: string;
  feature: string;
  summary: string | null;
  actor: EventActor;
  target: { kind: string | null; id: string | null; name: string | null; ecosystem: string | null; version: string | null; repository: string | null };
  reasons: string[];
  details: Record<string, unknown>;
  event: EventEnvelope;
}

export interface JobRunEvent {
  id: string;
  job: string;
  jobId: string | null;
  trigger: 'scheduled' | 'manual' | 'startup';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  event: EventEnvelope | null;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface JobRunsPage extends Page<JobRunEvent> {
  jobs: string[];
}

export interface CatalogEvent {
  key: string;
  type: string;
  label: string;
  category: 'decision' | 'audit' | 'job';
  severity: 'info' | 'notice' | 'warning' | 'error';
  default: boolean;
  highVolume?: boolean;
}

export interface CatalogFeature {
  feature: string;
  label: string;
  groups: Array<{ tab?: string; events: CatalogEvent[] }>;
}

export interface EventSelection {
  features: string[];
  events: string[];
}

export interface EventCatalog {
  features: CatalogFeature[];
  presets: { recommended: EventSelection; everything: EventSelection };
  webhookEvents: string[];
}

export interface EventsStatus {
  migration: { percent: number; remaining: number } | null;
  purge: {
    date: string;
    ledger: { retentionDays: number; entries: number } | null;
    audit: { retentionDays: number; entries: number } | null;
  } | null;
  retention: { ledgerDays: number; auditDays: number };
}

export type DestinationType = 'splunk' | 'datadog' | 'elastic' | 'sumo' | 'syslog' | 'http' | 'jsonl';

export interface DestinationHealth {
  status: 'healthy' | 'retrying' | 'auth_failed' | 'disabled' | 'idle';
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pausedUntil: string | null;
  sent24h: number;
  dropped24h: Record<string, number>;
  sentTotal: number;
  lagSeconds: number | null;
  lastLoss: { count: number; at: string } | null;
}

export interface StreamDestination {
  id: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  settings: Record<string, string>;
  /** Which secrets are stored. Values are never returned. */
  secrets: Record<string, { set: boolean }>;
  selection: EventSelection;
  createdAt: string | null;
  updatedAt: string | null;
  health?: DestinationHealth | null;
}

export interface DestinationList {
  items: StreamDestination[];
  /** Average events a day over the last 7 days, by decision. */
  volume: Record<string, number>;
  highVolume: { types: string[]; estimatePerDay: number };
}

export interface DestinationInput {
  id?: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string | null>;
  selection: EventSelection;
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  reply: string;
  error?: string;
}

function params(query: Record<string, string | number | null | undefined>): HttpParams {
  let out = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    out = out.set(key, String(value));
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class EventsService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private catalog$: Observable<EventCatalog> | null = null;

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  ledger(query: Record<string, string | number | null | undefined>): Observable<Page<LedgerRow>> {
    return this.http.get<Page<LedgerRow>>('/api/admin/decision-ledger', { headers: this.headers(), params: params(query) });
  }

  auditEvents(query: Record<string, string | number | null | undefined>): Observable<Page<AuditRow>> {
    return this.http.get<Page<AuditRow>>('/api/admin/audit-events', { headers: this.headers(), params: params(query) });
  }

  jobRuns(query: Record<string, string | number | null | undefined>): Observable<JobRunsPage> {
    return this.http.get<JobRunsPage>('/api/admin/job-runs', { headers: this.headers(), params: params(query) });
  }

  /** Static for the life of the page. */
  catalog(): Observable<EventCatalog> {
    this.catalog$ ??= this.http.get<EventCatalog>('/api/admin/events/catalog', { headers: this.headers() }).pipe(shareReplay(1));
    return this.catalog$;
  }

  status(): Observable<EventsStatus> {
    return this.http.get<EventsStatus>('/api/admin/events/status', { headers: this.headers() });
  }

  destinations(): Observable<DestinationList> {
    return this.http.get<DestinationList>('/api/admin/stream-destinations', { headers: this.headers() });
  }

  createDestination(input: DestinationInput): Observable<StreamDestination> {
    return this.http.post<StreamDestination>('/api/admin/stream-destinations', input, { headers: this.headers() });
  }

  updateDestination(id: string, input: Partial<DestinationInput>): Observable<StreamDestination> {
    return this.http.put<StreamDestination>(`/api/admin/stream-destinations/${id}`, input, { headers: this.headers() });
  }

  deleteDestination(id: string): Observable<void> {
    return this.http.delete<void>(`/api/admin/stream-destinations/${id}`, { headers: this.headers() });
  }

  testUnsaved(input: DestinationInput): Observable<TestResult> {
    return this.http.post<TestResult>('/api/admin/stream-destinations/test', input, { headers: this.headers() });
  }

  testSaved(id: string): Observable<TestResult> {
    return this.http.post<TestResult>(`/api/admin/stream-destinations/${id}/test`, {}, { headers: this.headers() });
  }
}
