import type { MonitorPolicy } from '../../services/monitor.service';

/** Test fixture: a monitoring license policy, 12 days in. */
export function monitorPolicy(extra: Partial<MonitorPolicy> = {}): MonitorPolicy {
  return {
    id: 'p1', name: 'Approved licenses', description: null, conditions: { licenseAllowList: ['MIT'] }, isEnabled: true,
    priority: 0, mode: 'monitor', modeChangedAt: new Date(Date.now() - 12 * 86_400_000).toISOString(), packages: 2, versions: 3,
    downloads: 40, willBlock: 2, approved: 0, partlyApproved: 0, approvable: true, approvalScope: 'any',
    lastSeenAt: new Date().toISOString(), capped: false, rowLimit: 50000, rechecking: false, recheckProgress: null, recheckFailed: false, retentionDays: 90, ...extra,
  };
}
