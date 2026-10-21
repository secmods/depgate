import { describe, expect, it } from 'vitest';
import type { Policy } from '../../services/policy.service';
import { reorderPolicies } from './policies-reorder';

function policy(id: string, priority: number): Policy {
  return {
    id,
    name: id,
    description: null,
    decision: 'BLOCK',
    conditions: {},
    priority,
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  };
}

describe('reorderPolicies', () => {
  it('moves a policy to the top and keeps priorities strictly increasing', () => {
    const result = reorderPolicies(
      [policy('a', 0), policy('b', 1), policy('c', 5)],
      2,
      0,
    );
    expect(result.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(result.map((item) => item.priority)).toEqual([0, 1, 5]);
  });

  it('moves a policy down', () => {
    const result = reorderPolicies(
      [policy('a', 0), policy('b', 1), policy('c', 5)],
      0,
      2,
    );
    expect(result.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(result.map((item) => item.priority)).toEqual([0, 1, 5]);
  });

  it('assigns distinct priorities when every policy shares the same priority', () => {
    const result = reorderPolicies(
      [policy('a', 0), policy('b', 0), policy('c', 0)],
      2,
      0,
    );
    expect(result.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(result.map((item) => item.priority)).toEqual([0, 1, 2]);
  });

  it('leaves the list unchanged when the drop target is the same row', () => {
    const list = [policy('a', 0), policy('b', 1)];
    expect(reorderPolicies(list, 1, 1)).toBe(list);
  });
});
