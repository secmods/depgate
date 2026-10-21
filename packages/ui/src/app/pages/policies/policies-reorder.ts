import type { Policy } from '../../services/policy.service';

export function reorderPolicies(policies: Policy[], from: number, to: number): Policy[] {
  if (from === to || from < 0 || to < 0 || from >= policies.length || to >= policies.length) {
    return policies;
  }
  const next = [...policies];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  const slots = prioritySlots(policies.map((policy) => policy.priority));
  return next.map((policy, index) => ({ ...policy, priority: slots[index] }));
}

function prioritySlots(priorities: number[]): number[] {
  const sorted = [...priorities].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const slots = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    slots.push(Math.max(sorted[i], slots[i - 1] + 1));
  }
  return slots;
}
