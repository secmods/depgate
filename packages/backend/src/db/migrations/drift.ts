import type { DataSource } from 'typeorm';

/**
 * Schema drift (requirements_schema_migrations.md C1, D2, P5): what TypeORM would change to bring the
 * database in line with the entities. Empty means the migrations and the entities agree. Nothing is
 * executed: the schema builder runs in SQL-memory mode.
 */
export async function schemaDriftSql(db: DataSource): Promise<string[]> {
  // TypeORM 1.1 exposes the schema builder on the driver.
  const sql = await db.driver.createSchemaBuilder().log();
  return sql.upQueries.map((q) => q.query);
}

/** The tables TypeORM cannot declare (UNIQUE NULLS NOT DISTINCT); the drift test checks them against an expected list. */
export const RAW_TABLES = ['decision_counts_hourly', 'package_counts_hourly', 'package_usage', 'summary_flushes', 'event_migration'] as const;

export interface RawTableShape {
  columns: string[];
  constraints: string[];
  indexes: string[];
}

/**
 * A raw table as the database has it, in a form that is easy to compare: one line per column
 * (name, type, nullability, default), one per constraint definition, one per index definition.
 */
export async function describeRawTable(db: DataSource, table: string): Promise<RawTableShape | null> {
  const [exists]: { present: boolean }[] = await db.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table]);
  if (!exists?.present) return null;
  const columns: { line: string }[] = await db.query(
    `SELECT column_name || ' ' || data_type
            || COALESCE('(' || character_maximum_length || ')', '')
            || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE '' END
            || COALESCE(' default ' || column_default, '') AS line
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  );
  const constraints: { line: string }[] = await db.query(
    `SELECT conname || ' ' || pg_get_constraintdef(oid) AS line
       FROM pg_constraint
      WHERE conrelid = to_regclass($1)
        AND contype <> 'n' -- PostgreSQL 18 lists NOT NULL here, 15 to 17 do not; the column lines carry it
      ORDER BY conname`,
    [table]
  );
  const indexes: { line: string }[] = await db.query(
    `SELECT indexdef AS line FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = $1
      ORDER BY indexname`,
    [table]
  );
  return {
    columns: columns.map((c) => c.line),
    constraints: constraints.map((c) => c.line),
    indexes: indexes.map((i) => i.line.replace(/ ON [^ ]+\./, ' ON ')),
  };
}
