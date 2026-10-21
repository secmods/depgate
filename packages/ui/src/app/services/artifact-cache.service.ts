import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export type ArtifactCacheState = 'ok' | 'off' | 'error';

export interface ArtifactCachePod {
  pod: string;
  state: ArtifactCacheState;
  enabled?: boolean;
  available?: boolean;
  lastError: string | null;
  sizeBytes: number;
  maxSizeBytes: number;
  /** The disk has less free space than the size limit, so the limit in force is lower. */
  limitedByDisk?: boolean;
  files: number;
  maxFiles: number;
  hits24h: number;
  misses24h: number;
  updatedAt: string;
}

export interface ArtifactCacheLimits {
  /** Null: no size set anywhere, so the cache cannot be switched on. */
  maxSizeGb: number | null;
  maxFiles: number;
  maxAgeDays: number;
  maxIdleDays: number;
  maxFileMb: number;
}

export type ArtifactCacheLimitField = keyof ArtifactCacheLimits;

/** A number sets the field; null goes back to the ARTIFACT_CACHE_* variable. */
export type ArtifactCacheLimitsPatch = Partial<Record<ArtifactCacheLimitField, number | null>>;

export interface ArtifactCacheStatus {
  /** Switched on, on the pod that answered: the saved setting, or else ARTIFACT_CACHE_ENABLED. */
  enabled: boolean;
  /** A size per pod is set, so the cache can be switched on. */
  available: boolean;
  /** ARTIFACT_CACHE_ENABLED on the pod that answered. */
  environmentEnabled: boolean;
  /** Saved in Settings; null follows ARTIFACT_CACHE_ENABLED. */
  setting: boolean | null;
  /** ARTIFACT_CACHE_DIR; not changeable in Settings. */
  dir: string;
  /** In force: saved values over the environment. */
  limits: ArtifactCacheLimits;
  environmentLimits: ArtifactCacheLimits;
  /** Saved in Settings; a missing field follows the environment. */
  savedLimits: Partial<Record<ArtifactCacheLimitField, number>>;
  pods: ArtifactCachePod[];
  /** False: Redis is down and only the pod that answered is listed. */
  redisAvailable: boolean;
}

export type ArtifactCachePurge = { ecosystem: string; package: string; version?: string } | { all: true };

export interface ArtifactCachePurgeResult {
  files: number;
  bytes: number;
  pods: number;
}

@Injectable({ providedIn: 'root' })
export class ArtifactCacheService {
  private base = '/api/artifact-cache';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  status(): Observable<ArtifactCacheStatus> {
    return this.http.get<ArtifactCacheStatus>(`${this.base}/status`, { headers: this.headers() });
  }

  /** Applies on every pod within seconds. `enabled: null` follows ARTIFACT_CACHE_ENABLED again. */
  updateSettings(body: { enabled?: boolean | null; limits?: ArtifactCacheLimitsPatch }): Observable<ArtifactCacheStatus> {
    return this.http.put<ArtifactCacheStatus>(`${this.base}/settings`, body, { headers: this.headers() });
  }

  purge(body: ArtifactCachePurge): Observable<ArtifactCachePurgeResult> {
    return this.http.post<ArtifactCachePurgeResult>(`${this.base}/purge`, body, { headers: this.headers() });
  }
}
