# Cloud database migrations

These are forward-only PostgreSQL migrations for the hosted application. They do not modify the local SQLite schema.

Run from the repository root with a dedicated migration-owner connection:

```bash
MIGRATION_DATABASE_URL=postgres://... pnpm db:migrate
```

The packaged command uses `dist/cloud/migrate.js`; build a source checkout before running it. Contributors who have not built yet can use `pnpm db:migrate:source`. The runner applies files matching `NNNN_name.sql` in version order, records a SHA-256 checksum, and holds a PostgreSQL advisory lock. Changed, missing, or back-filled migration history is rejected; add a new forward migration instead of editing an applied file.

Each file runs in one transaction. Do not put explicit transaction statements or `CREATE INDEX CONCURRENTLY` in a migration.

Tenant application tables have forced row-level security using the transaction-local `app.workspace_id` setting. The hosted request/store layer must set it only from a validated web session or OAuth grant:

```sql
BEGIN;
SELECT set_config('app.workspace_id', '00000000-0000-0000-0000-000000000000', true);
-- tenant queries
COMMIT;
```

The runtime database role must not be a superuser, table owner, or have `BYPASSRLS`. Authentication tables and `webhook_event` are service-owned and intentionally outside tenant RLS; restrict them with database grants and application boundaries.
