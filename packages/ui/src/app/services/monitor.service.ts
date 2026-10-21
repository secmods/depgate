import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import { PolicyConditions, PolicyService } from './policy.service';

export type MonitorStatus = 'will_block' | 'partly' | 'approved';
export type MonitorStatusFilter = MonitorStatus | 'all';
export type LastSeenWithin = '7d' | '30d' | '90d' | 'all';
export type ApprovalScope = 'any' | 'versions';

export interface MonitorPolicy {
  id: string;
  name: string;
  description: string | null;
  conditions: PolicyConditions;
  isEnabled: boolean;
  priority: number;
  mode: 'enforce' | 'monitor';
  modeChangedAt: string | null;
  packages: number;
  versions: number;
  downloads: number;
  willBlock: number;
  approved: number;
  partlyApproved: number;
  approvable: boolean;
  approvalScope: ApprovalScope | null;
  lastSeenAt: string | null;
  capped: boolean;
  rowLimit: number;
  rechecking: boolean;
  /** While rechecking: how many recorded packages are done. */
  recheckProgress?: { done: number; total: number } | null;
  /** The last recheck failed for good; the report may still list rows the rule no longer matches. */
  recheckFailed?: boolean;
  retentionDays: number;
}

export interface ReasonGroup {
  reasonKey: string;
  packages: number;
  versions: number;
  downloads: number;
  share: number;
  lastSeenAt: string | null;
  reasons: string[];
}

export interface MonitorVersion {
  version: string;
  reasonKey: string;
  reasons: string[];
  downloads: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  approved: boolean;
  approvedUntil: string | null;
}

export interface MonitorPackage {
  ecosystem: string;
  packageName: string;
  versionCount: number;
  versionRange: { min: string; max: string } | null;
  reasonKey: string;
  reasonKeys: string[];
  reasons: string[];
  downloads: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  status: MonitorStatus;
  approvedVersions: number;
  totalVersions: number;
  approvedUntil: string | null;
  alsoMatchedBy: Array<{ policyId: string; policyName: string }>;
  /** Repository keys downloads were seen on. */
  repositories?: string[];
  versions: MonitorVersion[];
}

export interface MonitorImpact {
  policyId: string;
  policyName: string;
  mode: string;
  monitoringSince: string | null;
  daysMonitored: number;
  retentionDays: number;
  packages: number;
  versions: number;
  packagesToBlock: number;
  versionsToBlock: number;
  downloadsToBlock: number;
  downloadsPerDay: number;
  approvedPackages: number;
  partlyApprovedPackages: number;
  approvedVersions: number;
  topReasons: ReasonGroup[];
  lastSeenAt: string | null;
}

export interface PackageQuery {
  policyId: string;
  reasonKey?: string;
  ecosystem?: string;
  status?: MonitorStatusFilter;
  lastSeenWithin?: LastSeenWithin;
  search?: string;
  /** Repository key downloads were seen on. */
  repository?: string;
  sort?: 'downloads' | 'last_seen';
  limit?: number;
  offset?: number;
}

export interface ApproveItem {
  ecosystem: string;
  packageName: string;
  versions: string[];
}

@Injectable({ providedIn: 'root' })
export class MonitorService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private policyService = inject(PolicyService);
  /** Policies that are on and monitoring, for the sidebar badge. */
  readonly monitoringCount = signal(0);

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  policies(status: 'monitoring' | 'enforced' = 'monitoring'): Observable<{ items: MonitorPolicy[] }> {
    return this.http.get<{ items: MonitorPolicy[] }>(`/api/admin/monitor/policies`, {
      headers: this.headers(),
      params: { status },
    });
  }

  /** One policy's summary, monitoring or enforced, for its details page. */
  policy(policyId: string): Observable<MonitorPolicy> {
    return this.http.get<MonitorPolicy>(`/api/admin/monitor/policies/${policyId}`, { headers: this.headers() });
  }

  /** Refreshes the sidebar badge from the policy list's count. Errors are ignored: the badge is only a hint. */
  refreshCount(): void {
    if (!this.auth.isSecurity()) return;
    this.policyService.list({ limit: 1 }).subscribe({
      next: (page) => this.monitoringCount.set(page.monitoring ?? 0),
      error: () => undefined,
    });
  }

  reasons(policyId: string, lastSeenWithin: LastSeenWithin = 'all'): Observable<{ items: ReasonGroup[] }> {
    return this.http.get<{ items: ReasonGroup[] }>(`/api/admin/monitor/policies/${policyId}/reasons`, {
      headers: this.headers(),
      params: { lastSeenWithin },
    });
  }

  impact(policyId: string): Observable<MonitorImpact> {
    return this.http.get<MonitorImpact>(`/api/admin/monitor/policies/${policyId}/impact`, { headers: this.headers() });
  }

  packages(query: PackageQuery): Observable<{ items: MonitorPackage[]; total: number; limit: number; offset: number }> {
    return this.http.get<{ items: MonitorPackage[]; total: number; limit: number; offset: number }>(
      `/api/admin/monitor/packages`,
      { headers: this.headers(), params: toParams(query) },
    );
  }

  exportCsv(query: PackageQuery, granularity: 'package' | 'version'): Observable<Blob> {
    return this.http.get(`/api/admin/monitor/packages.csv`, {
      headers: this.headers(),
      params: toParams({ ...query, limit: undefined, offset: undefined }).set('granularity', granularity),
      responseType: 'blob',
    });
  }

  approve(body: { policyId: string; items: ApproveItem[]; expiresAt: string; reason: string }): Observable<{
    items: Array<{ id: string; action: 'created' | 'widened'; packageName: string; version: string }>;
  }> {
    return this.http.post<{ items: Array<{ id: string; action: 'created' | 'widened'; packageName: string; version: string }> }>(
      `/api/admin/monitor/approve`,
      body,
      { headers: this.headers() },
    );
  }

  recheck(policyId: string): Observable<{ recheck: boolean }> {
    return this.http.post<{ recheck: boolean }>(`/api/admin/monitor/policies/${policyId}/recheck`, {}, { headers: this.headers() });
  }

  restart(policyId: string): Observable<{ cleared: number; modeChangedAt: string | null }> {
    return this.http.post<{ cleared: number; modeChangedAt: string | null }>(
      `/api/admin/monitor/policies/${policyId}/restart`,
      {},
      { headers: this.headers() },
    );
  }
}

function toParams(query: PackageQuery): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params = params.set(key, String(value));
  }
  return params;
}
