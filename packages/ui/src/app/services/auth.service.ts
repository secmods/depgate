import { Injectable } from '@angular/core';

const TOKEN_KEY = 'depgate_token';
const REGISTRY_TOKEN_KEY = 'depgate_registry_token';

const API_KEY_PREFIXES = ['dgk_', 'osk_'];

function isApiKey(token: string): boolean {
  return API_KEY_PREFIXES.some((prefix) => token.startsWith(prefix));
}

type TokenClaims = { role?: string; username?: string; type?: string; exp?: number };

@Injectable({ providedIn: 'root' })
export class AuthService {
  getToken(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  setSession(token: string, registryToken: string): void {
    this.setToken(token);
    if (registryToken) sessionStorage.setItem(REGISTRY_TOKEN_KEY, registryToken);
  }

  getRegistryToken(): string | null {
    return sessionStorage.getItem(REGISTRY_TOKEN_KEY);
  }

  clearToken(): void {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(REGISTRY_TOKEN_KEY);
  }

  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;
    if (isApiKey(token)) return true;
    return this.claims() !== null;
  }

  getRole(): string | null {
    return canonicalRole(this.claims()?.role);
  }

  getUsername(): string | null {
    return this.claims()?.username ?? null;
  }

  isSecurity(): boolean {
    return this.getRole() === 'Security';
  }

  isUser(): boolean {
    return this.getRole() === 'User';
  }

  homeRoute(): string {
    return this.isUser() ? '/registry' : '/dashboard';
  }

  private claims(): TokenClaims | null {
    const token = this.getToken();
    if (!token || isApiKey(token)) return null;
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      const claims = JSON.parse(json) as TokenClaims;
      if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) {
        this.clearToken();
        return null;
      }
      return claims;
    } catch {
      return null;
    }
  }
}

export function canonicalRole(role: string | null | undefined): string | null {
  if (role === 'Admin' || role === 'Security') return 'Security';
  if (role === 'Viewer' || role === 'User') return 'User';
  if (role === 'ServiceAccount') return 'ServiceAccount';
  return role ?? null;
}
