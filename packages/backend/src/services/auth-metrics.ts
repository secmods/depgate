import { Counter, type Metric } from 'prom-client';

export const loginsTotal = new Counter({
  name: 'depgate_logins_total',
  help: 'Sign-in attempts by method (password, oidc, saml) and result (success, or the failure reason)',
  labelNames: ['method', 'result'],
  registers: [],
});

/** Failed sign-ins beyond the per-IP cap are counted here instead of written to the Decision Ledger. */
export const loginAuditDroppedTotal = new Counter({
  name: 'depgate_login_audit_dropped_total',
  help: 'Failed sign-ins not written to the Decision Ledger because one IP passed the per-minute cap',
  labelNames: ['method'],
  registers: [],
});

export const AUTH_METRICS: Metric[] = [loginsTotal, loginAuditDroppedTotal];
