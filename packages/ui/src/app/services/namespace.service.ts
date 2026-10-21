import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

/** A remote of one ecosystem and whether it may serve reserved names. */
export interface NamespaceRemote {
  id: string;
  key: string;
  /** `npm/acme-artifactory`. */
  label: string;
  url: string;
  source: 'public' | 'internal';
  isEnabled: boolean;
  looksPublic: boolean;
}

export interface NamespacePatternResult {
  pattern: string;
  error: string | null;
}

export type NamespaceOutcome = 'unrestricted' | 'internal' | 'blocked' | 'monitor';

/** Whether a name is reserved, by which policy and pattern, and which remotes would serve it. */
export interface NamespaceCheck {
  ecosystem: string;
  name: string;
  canonicalName: string;
  repository: string;
  reserved: boolean;
  outcome: NamespaceOutcome;
  reason: string | null;
  policy: { id: string; name: string; mode: 'enforce' | 'monitor'; pattern: string } | null;
  servingRemotes: string[];
  internalRemotes: string[];
  publicRemotesSkipped: string[];
}

/** A reserved internal name that also exists on the public registry. */
export interface NamespaceCollision {
  id: string;
  ecosystem: string;
  name: string;
  firstSeenAt: string;
  lastCheckedAt: string;
  publicLatestVersion: string | null;
}

export interface NamespaceCandidate {
  ecosystem: string;
  name: string;
  repository?: string;
  reservedNamespaces: string[];
  publicPackages: string[];
  /** Remotes allowed to serve the names; empty for every internal remote. */
  allowedRemotes?: string[];
  mode?: 'enforce' | 'monitor';
  repositoryIds?: string[];
}

@Injectable({ providedIn: 'root' })
export class NamespaceService {
  private base = '/api/admin';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  remotes(ecosystem: string): Observable<NamespaceRemote[]> {
    return this.http.get<NamespaceRemote[]>(`${this.base}/namespaces/remotes`, {
      headers: this.headers(),
      params: new HttpParams().set('ecosystem', ecosystem),
    });
  }

  validate(ecosystem: string, patterns: string[]): Observable<{ results: NamespacePatternResult[]; goNoSumDb: string | null }> {
    return this.http.post<{ results: NamespacePatternResult[]; goNoSumDb: string | null }>(
      `${this.base}/namespaces/validate`,
      { ecosystem, patterns },
      { headers: this.headers() }
    );
  }

  /** "Try a name" for a policy that is being written: checks only that policy. */
  tryName(candidate: NamespaceCandidate): Observable<NamespaceCheck> {
    return this.http.post<NamespaceCheck>(`${this.base}/namespaces/check`, candidate, { headers: this.headers() });
  }

  /** The same against the saved policies. */
  check(ecosystem: string, name: string, repository = 'all'): Observable<NamespaceCheck> {
    return this.http.get<NamespaceCheck>(`${this.base}/namespaces/check`, {
      headers: this.headers(),
      params: new HttpParams().set('ecosystem', ecosystem).set('name', name).set('repository', repository),
    });
  }

  collisions(policyId: string): Observable<NamespaceCollision[]> {
    return this.http.get<NamespaceCollision[]>(`${this.base}/policies/${policyId}/collisions`, { headers: this.headers() });
  }
}
