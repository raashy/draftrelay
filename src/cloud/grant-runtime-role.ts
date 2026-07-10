import path from "node:path";
import { pathToFileURL } from "node:url";

import { Pool, type QueryResultRow } from "pg";

const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

interface RoleRow extends QueryResultRow {
  roleName: string;
  canLogin: boolean;
  isSuperuser: boolean;
  bypassRls: boolean;
  ownsPublicTables: boolean;
}

interface OwnerRow extends QueryResultRow {
  ownerName: string;
  databaseName: string;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function grantRuntimeRole(
  database: Pool,
  runtimeRole: string
): Promise<void> {
  if (!ROLE_PATTERN.test(runtimeRole)) {
    throw new Error("RUNTIME_DATABASE_ROLE must be a lowercase PostgreSQL identifier");
  }

  const role = await database.query<RoleRow>(
    `SELECT rolname AS "roleName", rolcanlogin AS "canLogin",
       rolsuper AS "isSuperuser", rolbypassrls AS "bypassRls",
       EXISTS (
         SELECT 1 FROM pg_class relation
         WHERE relation.relowner = pg_roles.oid
           AND relation.relnamespace = 'public'::regnamespace
           AND relation.relkind IN ('r', 'p')
       ) AS "ownsPublicTables"
     FROM pg_roles WHERE rolname = $1`,
    [runtimeRole]
  );
  const target = role.rows[0];
  if (!target) throw new Error(`Runtime database role ${runtimeRole} does not exist`);
  if (!target.canLogin) throw new Error(`Runtime database role ${runtimeRole} cannot log in`);
  if (target.isSuperuser || target.bypassRls) {
    throw new Error(`Runtime database role ${runtimeRole} must not bypass row-level security`);
  }
  if (target.ownsPublicTables) {
    throw new Error(`Runtime database role ${runtimeRole} must not own application tables`);
  }

  const ownerResult = await database.query<OwnerRow>(
    `SELECT current_user AS "ownerName", current_database() AS "databaseName"`
  );
  const owner = ownerResult.rows[0];
  if (!owner) throw new Error("Could not inspect the migration-owner connection");

  const roleIdentifier = quoteIdentifier(runtimeRole);
  const ownerIdentifier = quoteIdentifier(owner.ownerName);
  const databaseIdentifier = quoteIdentifier(owner.databaseName);

  await database.query("BEGIN");
  try {
    await database.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`);
    await database.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`);
    await database.query(`REVOKE CREATE ON SCHEMA public FROM ${roleIdentifier}`);
    await database.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleIdentifier}`
    );
    await database.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${roleIdentifier}`
    );
    await database.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdentifier}`
    );
    await database.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdentifier} IN SCHEMA public ` +
        `GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roleIdentifier}`
    );
    await database.query(`REVOKE ALL ON TABLE cloud_schema_migration FROM ${roleIdentifier}`);
    await database.query(`GRANT SELECT ON TABLE cloud_schema_migration TO ${roleIdentifier}`);
    await database.query("COMMIT");
  } catch (error: unknown) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const HELP = `Usage: pnpm db:grant-runtime

Environment:
  MIGRATION_DATABASE_URL  PostgreSQL URL for the migration-owner role (required)
  RUNTIME_DATABASE_ROLE   Existing non-owner login role (default: draftrelay_app)
`;

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const databaseUrl = env.MIGRATION_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required");
  const runtimeRole = env.RUNTIME_DATABASE_ROLE?.trim() || "draftrelay_app";
  const database = new Pool({
    connectionString: databaseUrl,
    application_name: "draftrelay-runtime-role-grant",
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000
  });
  try {
    await grantRuntimeRole(database, runtimeRole);
    process.stdout.write(`Granted runtime access to ${runtimeRole}.\n`);
    return 0;
  } finally {
    await database.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(path.resolve(invokedPath)).href === import.meta.url
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Runtime-role grant failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

export const runtimeRoleInternals = { ROLE_PATTERN, quoteIdentifier };
