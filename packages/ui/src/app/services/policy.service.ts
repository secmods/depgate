import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';
import type { RepositoryRef } from '../shared/repository-scope';

export interface PolicyConditions {
  ecosystem?: string[];
  packageBlockList?: string[];
  /** License rule, block mode: these licenses are blocked. */
  licenseDenyList?: string[];
  /** License rule, allow-only mode: every other license is blocked. */
  licenseAllowList?: string[];
  /** Allow-only mode: let packages with no license information through. */
  allowUnknownLicense?: boolean;
  versionRange?: string;
  releaseAgeMinDays?: number;
  releaseAgeMaxHours?: number;
  cveBlockList?: string[];
  /** Vulnerability rule: match a vulnerability whose CVSS base score is at least this (0.1–10, one decimal). */
  cvssMin?: number;
  /** A vulnerability with neither a CVSS vector nor a severity label: ignore (default) or match. */
  cvssUnknown?: 'match' | 'ignore';
  /** Vulnerability rule: match only a vulnerability whose EPSS score is at least this (fraction 0–1). */
  epssMin?: number;
  /** Vulnerability rule, alternative to epssMin: EPSS percentile at least this (fraction 0–1). */
  epssPercentileMin?: number;
  /** A vulnerability with no EPSS score: match (default) or ignore. */
  epssUnknown?: 'match' | 'ignore';
  /** Internal namespace rule: remote IDs allowed to serve the names; empty for every internal remote. */
  allowedRemotes?: string[];
  /** Release stages to match: prerelease, dev, snapshot, pseudo. */
  releaseTypes?: string[];
  /** Internal namespace rule: names served only from internal remotes. One ecosystem per policy. */
  reservedNamespaces?: string[];
  /** Names (or globs) in the reserved namespaces that may come from public registries. */
  publicPackages?: string[];
  /** Project health (OpenSSF Scorecard): block when the overall score is below this (0–10). */
  scorecardMinScore?: number;
  /** Project health, Advanced: block when a listed check scores below its minimum. */
  scorecardChecks?: Array<{ name: string; minScore: number }>;
  /** Project health: a package with no Scorecard result. Default allow. */
  scorecardUnknown?: 'allow' | 'block';
  /** Project health: the Scorecard lookup failed. Default allow. */
  scorecardUnavailable?: 'allow' | 'block';
}

/** enforce applies the decision; monitor (Block only) records what it would block. */
export type PolicyMode = 'enforce' | 'monitor';

export interface Policy {
  id: string;
  name: string;
  description: string | null;
  decision: 'ALLOW' | 'BLOCK';
  conditions: PolicyConditions;
  priority: number;
  isEnabled: boolean;
  mode?: PolicyMode;
  /** When monitoring started, or when the policy was last switched to enforce. */
  modeChangedAt?: string | null;
  /** Repositories the policy applies to. Empty: every repository. */
  repositoryIds?: string[];
  repositories?: RepositoryRef[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyPage {
  items: Policy[];
  total: number;
  enabled: number;
  disabled: number;
  monitoring?: number;
}

@Injectable({ providedIn: 'root' })
export class PolicyService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(
    params: { limit?: number; offset?: number; repositoryId?: string; scope?: 'scoped' | 'all' } = {}
  ): Observable<PolicyPage> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    if (params.repositoryId) query.set('repositoryId', params.repositoryId);
    if (params.scope) query.set('scope', params.scope);
    const qs = query.toString();
    return this.http.get<PolicyPage>(
      `${this.base}/admin/policies${qs ? `?${qs}` : ''}`,
      { headers: this.headers() },
    );
  }

  get(id: string): Observable<Policy> {
    return this.http.get<Policy>(`${this.base}/admin/policies/${id}`, {
      headers: this.headers(),
    });
  }

  create(data: Partial<Policy>): Observable<Policy> {
    return this.http.post<Policy>(`${this.base}/admin/policies`, data, {
      headers: this.headers(),
    });
  }

  update(id: string, data: Partial<Policy>): Observable<Policy & { recheck?: boolean }> {
    return this.http.put<Policy & { recheck?: boolean }>(`${this.base}/admin/policies/${id}`, data, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/policies/${id}`, {
      headers: this.headers(),
    });
  }
}
