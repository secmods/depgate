import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface GatewayConfig {
  baseUrl: string;
  sessionTokenDays: number;
  /** Daily check whether reserved internal names exist on public registries. */
  namespaceCollisionCheck?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  getGateway(): Observable<GatewayConfig> {
    return this.http.get<GatewayConfig>(`${this.base}/admin/config/gateway`, {
      headers: this.headers(),
    });
  }

  updateGateway(
    config: Partial<Pick<GatewayConfig, 'sessionTokenDays' | 'namespaceCollisionCheck'>>
  ): Observable<GatewayConfig> {
    return this.http.patch<GatewayConfig>(`${this.base}/admin/config/gateway`, config, {
      headers: this.headers(),
    });
  }
}
