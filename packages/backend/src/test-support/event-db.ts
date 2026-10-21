import type { DataSource } from 'typeorm';
import { AuditEvent } from '../db/entities/AuditEvent.js';
import { DecisionLedgerEntry } from '../db/entities/DecisionLedgerEntry.js';
import { flushLedger } from '../services/events/record.js';

/**
 * A DataSource stand-in that keeps what the event writers store: Decision Ledger rows (batched multi-row
 * inserts) and Audit Log rows. `flush()` writes the ledger buffer, as the 1-second timer would.
 */
export function fakeEventDb(extra: Record<string, unknown> = {}): {
  db: DataSource;
  ledger: DecisionLedgerEntry[];
  audit: AuditEvent[];
  inserts: number;
  flush: () => Promise<void>;
  failNext: (err: Error) => void;
} {
  const ledger: DecisionLedgerEntry[] = [];
  const audit: AuditEvent[] = [];
  let failure: Error | null = null;
  const state = { inserts: 0 };
  const db = {
    createQueryBuilder: () => {
      let target: unknown = null;
      let rows: unknown[] = [];
      const qb = {
        insert: () => qb,
        into: (entity: unknown) => {
          target = entity;
          return qb;
        },
        values: (values: unknown[]) => {
          rows = values;
          return qb;
        },
        orIgnore: () => qb,
        execute: async () => {
          if (failure) {
            const err = failure;
            failure = null;
            throw err;
          }
          state.inserts += 1;
          if (target === DecisionLedgerEntry) ledger.push(...(rows as DecisionLedgerEntry[]));
          if (target === AuditEvent) audit.push(...(rows as AuditEvent[]));
          return { identifiers: [] };
        },
      };
      return qb;
    },
    getRepository: (entity: unknown) => ({
      insert: async (row: AuditEvent) => {
        if (entity === AuditEvent) audit.push(row);
      },
      create: (row: unknown) => row,
      save: async (row: unknown) => row,
    }),
    query: async () => [],
    ...extra,
  } as unknown as DataSource;
  return {
    db,
    ledger,
    audit,
    get inserts() {
      return state.inserts;
    },
    flush: () => flushLedger(db),
    failNext: (err: Error) => {
      failure = err;
    },
  };
}
