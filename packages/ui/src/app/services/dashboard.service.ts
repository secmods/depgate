import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface DashboardStats {
  total: number;
  allow: number;
  block: number;
}

export interface PackageCount {
  ecosystem: string;
  packageName: string;
  count: number;
}

export interface EcosystemStats {
  ecosystem: string;
  total: number;
  allow: number;
  block: number;
}

export interface DashboardCharts {
  topPackagesAllowed: PackageCount[];
  topPackagesBlocked: PackageCount[];
  byEcosystem: EcosystemStats[];
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  getStats(range?: '24h' | '7d' | '30d'): Observable<DashboardStats> {
    let params = new HttpParams();
    if (range) params = params.set('range', range);
    return this.http.get<DashboardStats>(`${this.base}/admin/dashboard/stats`, {
      headers: this.headers(),
      params,
    });
  }

  getCharts(range?: '24h' | '7d' | '30d'): Observable<DashboardCharts> {
    let params = new HttpParams();
    if (range) params = params.set('range', range);
    return this.http.get<DashboardCharts>(`${this.base}/admin/dashboard/charts`, {
      headers: this.headers(),
      params,
    });
  }
}
