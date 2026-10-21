import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface ApiKey {
  id: string;
  name: string;
  role: string;
  namespace: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  requestCount: string;
  createdAt: string;
}

export interface CreateApiKeyResponse {
  id: string;
  name: string;
  role: string;
  key: string;
  expiresAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class ApiKeyService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  list(): Observable<ApiKey[]> {
    return this.http.get<ApiKey[]>(`${this.base}/admin/api-keys`, {
      headers: this.headers(),
    });
  }

  create(data: { name: string; role: string; namespace?: string; expiresInDays?: number }): Observable<CreateApiKeyResponse> {
    return this.http.post<CreateApiKeyResponse>(`${this.base}/admin/api-keys`, data, {
      headers: this.headers(),
    });
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/api-keys/${id}`, {
      headers: this.headers(),
    });
  }
}
