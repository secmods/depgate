import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  login(email: string, password: string): Observable<{ token: string; registryToken: string }> {
    return this.http.post<{ token: string; registryToken: string }>(`${this.base}/auth/login`, {
      email,
      password,
    });
  }

  forgotPassword(email: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/auth/forgot-password`, { email });
  }

  tokenInfo(token: string): Observable<{ email: string; purpose: 'invite' | 'reset' }> {
    return this.http.get<{ email: string; purpose: 'invite' | 'reset' }>(`${this.base}/auth/token-info`, { params: { token } });
  }

  setPassword(token: string, password: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.base}/auth/set-password`, { token, password });
  }
}
