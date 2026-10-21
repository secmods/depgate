# Database migrations

DepGate upgrades its own database schema. This page explains what happens at startup and what it means for an upgrade, and gives contributors the rules for changing the schema. Operators only need the [upgrade procedure](./operations#upgrade).

## How it works

The schema comes from numbered SQL files that ship with every release, one ordered chain that only moves forward. At startup, before the server accepts requests, DepGate:

1. Checks that PostgreSQL is 15 or later and that its migration files are present and unchanged.
2. Opens one transaction and takes a lock, so replicas that start together wait for each other.
3. Reads which migrations the database has run, applies the missing ones in order, and records each one.

If anything fails, the transaction rolls back, the log names the migration and the SQL error, and the process exits. The database is exactly as it was, so the previous version can be started again.

The database records where it stands, so the release you come from never matters: you can skip releases, and a fresh install runs the whole chain.

### When DepGate refuses to start

| Situation | Message |
|---|---|
| A migration file changed after it was applied | `Migration 0003_x has changed since it was applied. This DepGate build is broken; do not use it.` |
| The database was upgraded by a newer DepGate | `The database was upgraded by DepGate 0.3.0 (schema 0007). This is 0.2.0 (schema 0005). Start 0.3.0 or later.` |
| A table is locked by an instance of an older version | `A table is locked by another connection. Stop every DepGate instance running an older version, then start again.` |

Nothing is changed in any of these cases.

### Long migrations

A migration that rewrites a large table runs inside the startup transaction, and DepGate is unavailable until it finishes. The release notes name any migration expected to take more than a minute. The Kubernetes manifests allow 10 minutes for startup; raise the startup probe's `failureThreshold` when the release notes say so. With Compose, nothing interrupts a long migration.

## For contributors

Schema changes are plain SQL files in `packages/backend/migrations/`, named `NNNN_snake_case_name.sql` with contiguous numbers. TypeORM never changes the schema; it is only asked to draft SQL for review.

1. Change the entity. Every index, unique, primary key and foreign key needs an explicit name (`idx_…`, `uq_…`, `pk_…`, `fk_…`) in the entity and in the migration.
2. Create the next file and draft its SQL:

   ```bash
   npm run migration:new add_policy_owner --workspace=@depgate/backend
   npm run migration:draft --workspace=@depgate/backend
   ```

   The draft is printed, never applied. Paste it into the new file and add what TypeORM cannot know, such as a backfill.
3. Start the backend (`npm run dev:backend`); it applies the migration. Run the integration tests, which include a drift test that fails when the entities and the migrations disagree.

Rules that CI enforces:

- A migration on `main` is never edited; a mistake is fixed with a new one.
- Everything runs in one transaction: no `BEGIN` or `COMMIT`, nothing `CONCURRENTLY`, no `VACUUM`, no `ALTER TYPE … ADD VALUE`.
- Plain SQL only, with no dependency on application code.

When two branches add the same number, the one that merges second renumbers its file. A development database that already ran the old number is re-adopted with `npm run db:adopt --workspace=@depgate/backend -- --readopt` (in development only), or reset.

At the 1.0 release the chain is squashed once into a single baseline. From then on it is permanent, and every older release upgrades straight to the latest.
