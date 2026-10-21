import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export type CheckStatus =
  | 'allowed'
  | 'blocked'
  | 'unknown';

export type ReleaseType = 'stable' | 'prerelease' | 'dev' | 'snapshot' | 'pseudo' | 'unknown';

export type IncompleteReason = 'cve' | 'license' | 'published' | 'scorecard' | 'timeout';

/** The OpenSSF Scorecard of one version, as the Project health rule reads it. */
export interface ProjectHealth {
  version: string;
  status: 'found' | 'unknown' | 'unavailable' | 'not-applicable' | 'disabled';
  /** unknown: no-repository, unsupported-host or not-scanned. not-applicable: internal-remote or private-name. */
  reason?: string;
  project?: string;
  via?: 'registry' | 'deps.dev';
  provenance?: string;
  scoreVia?: 'scorecard' | 'deps.dev';
  date?: string;
  overall?: number;
  checks?: Array<{ name: string; score: number }>;
}

export interface CheckedVersion {
  version: string;
  /** Index in the newest-first list. */
  position: number;
  status: CheckStatus;
  policyName?: string;
  /** Repositories the deciding policy is limited to, e.g. `npm/prod`; absent when it applies everywhere. */
  policyScope?: string[];
  reasons: string[];
  releaseType: ReleaseType;
  publishedAt?: string;
  /**
   * `cvss.version` is null when the score stands in for the advisory's severity label (no CVSS vector).
   * `epss`: the highest EPSS among the vulnerability's CVE ids; null when none has a score.
   */
  vulnerabilities?: Array<{
    id: string;
    severity: string;
    cvss?: { score: number; version: '4.0' | '3.1' | '3.0' | null } | null;
    cves?: string[];
    epss?: { score: number; percentile: number } | null;
  }>;
  exception?: { expiresAt: string };
  allowedAfter?: string;
  incomplete?: IncompleteReason[];
  requested?: boolean;
  isDefault?: boolean;
  waiverPending?: boolean;
  malicious?: boolean;
  /** Versions asked for only. null: none declared; absent: could not be loaded. */
  license?: string | null;
  /** Allowed now, but a policy in monitor mode would block it once enforced. */
  monitoring?: Array<{ policyId: string; policyName: string; reasons: string[] }>;
}

/** The internal namespace rule's view of the package on the checked repository. */
export interface PackageNamespace {
  reserved: true;
  mode: 'enforce' | 'monitor';
  policyId: string;
  policy: string;
  pattern: string;
  internalRemotes: string[];
  publicRemotesSkipped: string[];
  outcome: 'internal' | 'blocked' | 'notFound' | 'monitor';
}

export interface PackageCheckResult {
  ecosystem: string;
  package: string;
  repository: string;
  checkedAt: string;
  checkedAgainst: string[];
  /** Remotes the repository searches, in order, e.g. `npm/acme-private`. */
  searchOrder?: string[];
  /** The remote that served the package's metadata, when known, e.g. `npm/default`. */
  servedBy?: string | null;
  totalVersions: number;
  evaluated: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** `license`: null when none is declared; absent when it could not be loaded. */
  recommended: { version: string; releaseType: ReleaseType; publishedAt?: string; license?: string | null } | null;
  packageNotice: { kind: 'malware' | 'policy' | 'namespace'; message: string; policyName?: string } | null;
  /** Set when an internal namespace policy reserves the name. */
  namespace?: PackageNamespace | null;
  /** Set when a Project health (Scorecard) policy covers the ecosystem. */
  projectHealth?: ProjectHealth | null;
  /** Day of the EPSS scores shown with the vulnerabilities. */
  epssDate?: string | null;
  missingVersions: string[];
  versions: CheckedVersion[];
}

export interface PackageCheckRequest {
  ecosystem: string;
  package: string;
  repository?: string;
  versions?: string[];
  offset?: number;
  limit?: number;
  showDev?: boolean;
}

@Injectable({ providedIn: 'root' })
export class PackageCheckService {
  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  check(body: PackageCheckRequest): Observable<PackageCheckResult> {
    const token = this.auth.getToken();
    return this.http.post<PackageCheckResult>('/api/package-check', body, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }
}
