import type { DataSource } from 'typeorm';
import { logAudit } from './audit-service.js';
import type { DetachResult } from './repository-scope.js';

/** Audit what deleting a repository did to the policies, exceptions and waivers scoped to it. */
export function auditDetach(
  db: DataSource,
  context: { reqIp: string | null; userAgent: string | null; requester: string | null },
  label: string,
  detached: DetachResult,
  /** Reasons when the repository was not deleted, e.g. `all` leaving every scope (R5). */
  why: { deleted?: string; narrowed?: string; exception?: string; waiver?: string } = {}
): void {
  const base = { requesterIp: context.reqIp, userAgent: context.userAgent, requester: context.requester };
  for (const policy of detached.deletedPolicies) {
    logAudit(db, {
      ...base,
      ecosystem: 'policy',
      packageName: policy.name,
      decision: 'POLICY_DELETED',
      policyId: policy.id,
      policyName: policy.name,
      conditionReasons: [why.deleted ?? `Deleted: it applied only to "${label}"`],
    });
  }
  for (const policy of detached.disabledPolicies) {
    logAudit(db, {
      ...base,
      ecosystem: 'policy',
      packageName: policy.name,
      decision: 'POLICY_UPDATED',
      policyId: policy.id,
      policyName: policy.name,
      conditionReasons: [`Disabled: its only scoped repository "${label}" was deleted`],
    });
  }
  for (const policy of detached.narrowedPolicies) {
    logAudit(db, {
      ...base,
      ecosystem: 'policy',
      packageName: policy.name,
      decision: 'POLICY_UPDATED',
      policyId: policy.id,
      policyName: policy.name,
      conditionReasons: [why.narrowed ?? `Repository "${label}" was deleted and removed from the policy's scope`],
    });
  }
  for (const exception of detached.deletedExceptions) {
    logAudit(db, {
      ...base,
      ecosystem: exception.ecosystem,
      packageName: `${exception.packageName}@${exception.version}`,
      resolvedVersion: exception.version,
      decision: 'EXCEPTION_REVOKED',
      policyId: exception.policyId,
      conditionReasons: [why.exception ?? `Its only repository "${label}" was deleted`],
    });
  }
  for (const waiver of detached.rejectedWaivers) {
    logAudit(db, {
      ...base,
      ecosystem: waiver.ecosystem,
      packageName: `${waiver.packageName}@${waiver.version}`,
      resolvedVersion: waiver.version,
      decision: 'WAIVER_REJECTED',
      conditionReasons: [why.waiver ?? `Its only repository "${label}" was deleted`],
    });
  }
}
