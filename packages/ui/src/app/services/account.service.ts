import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from './auth.service';

export interface AccountUser {
  id: string;
  email: string;
  status: 'invited' | 'active' | 'disabled';
  role: 'User' | 'Security';
  /** `sso` when single sign-on added the person on first sign-in. */
  source: 'local' | 'sso';
  invitePending: boolean;
  hasPassword: boolean;
  /** "Password" and each identity provider the person has signed in with. */
  signInMethods: string[];
  lastLoginAt: string | null;
  lastLoginMethod: 'password' | 'oidc' | 'saml' | null;
  lastLoginProvider: string | null;
  createdAt: string;
}

export interface InviteResult {
  id: string;
  email: string;
  role: 'User' | 'Security';
  emailSent: boolean;
  /** False when no password invitation was sent. */
  invited: boolean;
  /** Present only when the email could not be sent. */
  inviteUrl?: string;
}

export interface MailSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  from: string;
  source: 'ui' | 'environment' | 'none';
}

export interface MailSettingsInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  /** Omit to keep the saved password. */
  password?: string;
}

export interface ServiceAccount {
  id: string;
  name: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedServiceAccount extends ServiceAccount {
  key: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface ListQuery {
  limit: number;
  offset: number;
  /** Part of the email (users) or name (service accounts). */
  search?: string;
}

export interface UserListQuery extends ListQuery {
  source?: AccountUser['source'] | '';
  role?: AccountUser['role'] | '';
  status?: AccountUser['status'] | '';
}

function listParams(query: ListQuery): Record<string, string> {
  return {
    limit: String(query.limit),
    offset: String(query.offset),
    ...(query.search ? { search: query.search } : {}),
  };
}

export interface CiTokenRow {
  id: string;
  name: string;
  metadata: Record<string, string>;
  expiresAt: string;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class AccountService {
  private base = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService
  ) {}

  private headers(): { [k: string]: string } {
    const t = this.auth.getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  listUsers(query: UserListQuery): Observable<Page<AccountUser>> {
    const params: Record<string, string> = listParams(query);
    if (query.source) params['source'] = query.source;
    if (query.role) params['role'] = query.role;
    if (query.status) params['status'] = query.status;
    return this.http.get<Page<AccountUser>>(`${this.base}/admin/users`, { headers: this.headers(), params });
  }

  createUser(body: { email: string; role: 'User' | 'Security'; sendInvite?: boolean }): Observable<InviteResult> {
    return this.http.post<InviteResult>(`${this.base}/admin/users`, body, { headers: this.headers() });
  }

  resendInvite(id: string): Observable<InviteResult> {
    return this.http.post<InviteResult>(`${this.base}/admin/users/${id}/resend-invite`, {}, { headers: this.headers() });
  }

  /** Emails a reset link to a user who has a password. The link is never returned to the admin. */
  sendPasswordReset(id: string): Observable<{ sentTo: string }> {
    return this.http.post<{ sentTo: string }>(`${this.base}/admin/users/${id}/send-reset`, {}, { headers: this.headers() });
  }

  getMailSettings(): Observable<MailSettings> {
    return this.http.get<MailSettings>(`${this.base}/admin/mail-settings`, { headers: this.headers() });
  }

  saveMailSettings(body: MailSettingsInput): Observable<MailSettings> {
    return this.http.put<MailSettings>(`${this.base}/admin/mail-settings`, body, { headers: this.headers() });
  }

  sendTestMail(): Observable<{ sentTo: string }> {
    return this.http.post<{ sentTo: string }>(`${this.base}/admin/mail-settings/test`, {}, { headers: this.headers() });
  }

  /** Change role, disable or enable. Either signs the user out everywhere. */
  updateUser(id: string, body: { role?: 'User' | 'Security'; disabled?: boolean }): Observable<AccountUser> {
    return this.http.patch<AccountUser>(`${this.base}/admin/users/${id}`, body, { headers: this.headers() });
  }

  revokeSessions(id: string): Observable<void> {
    return this.http.post<void>(`${this.base}/admin/users/${id}/revoke-sessions`, {}, { headers: this.headers() });
  }

  deleteUser(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/users/${id}`, { headers: this.headers() });
  }

  listServiceAccounts(query: ListQuery): Observable<Page<ServiceAccount>> {
    return this.http.get<Page<ServiceAccount>>(`${this.base}/admin/service-accounts`, { headers: this.headers(), params: listParams(query) });
  }

  createServiceAccount(name: string): Observable<CreatedServiceAccount> {
    return this.http.post<CreatedServiceAccount>(`${this.base}/admin/service-accounts`, { name }, { headers: this.headers() });
  }

  deleteServiceAccount(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/service-accounts/${id}`, { headers: this.headers() });
  }

  listCiTokens(): Observable<{ items: CiTokenRow[] }> {
    return this.http.get<{ items: CiTokenRow[] }>(`${this.base}/admin/ci-tokens`, { headers: this.headers() });
  }

  revokeCiToken(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/admin/ci-tokens/${id}`, { headers: this.headers() });
  }
}
