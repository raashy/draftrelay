import { fileURLToPath } from "node:url";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { CloudConfig } from "./config.js";
import { readMigrationFiles, type MigrationFile } from "./migrate.js";

export type CloudDatabase = Pool;

export interface CloudDatabaseRole {
  name: string;
  canLogin: boolean;
  isSuperuser: boolean;
  bypassRls: boolean;
  rowSecurityEnabled: boolean;
  ownsPublicTables: boolean;
}

const TENANT_TABLES = [
  "workspace",
  "workspace_member",
  "project",
  "project_secret_pattern",
  "output_item",
  "output_revision",
  "output_provenance",
  "referenced_file",
  "secret_finding",
  "output_representation",
  "output_event",
  "workspace_entitlement",
  "usage_counter",
  "audit_event"
] as const;

interface AppliedMigrationRow extends QueryResultRow {
  version: number;
  name: string;
  checksum: string;
}

interface TenantTableSafetyRow extends QueryResultRow {
  tableName: string;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  hasTenantPolicy: boolean;
  policyPermissive: boolean | null;
  policyCommand: string | null;
  policyPublicOnly: boolean | null;
  policyUsing: string | null;
  policyWithCheck: string | null;
}

interface TenantPolicySafetyRow extends QueryResultRow {
  tableName: string;
  policyName: string;
  policyPermissive: boolean;
  policyCommand: string;
  policyPublicOnly: boolean;
  policyUsing: string | null;
  policyWithCheck: string | null;
}

export class CloudSchemaSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudSchemaSafetyError";
  }
}

export function createCloudDatabase(config: CloudConfig): CloudDatabase {
  return new Pool({
    connectionString: config.databaseUrl,
    application_name: "draftrelay-cloud",
    max: config.environment === "test" ? 4 : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
    allowExitOnIdle: config.environment === "test"
  });
}

export async function inspectCloudDatabaseRole(
  database: CloudDatabase
): Promise<CloudDatabaseRole> {
  const result = await database.query<{
    name: string;
    canLogin: boolean;
    isSuperuser: boolean;
    bypassRls: boolean;
    rowSecurity: string;
    ownsPublicTables: boolean;
  }>(
    `SELECT roles.rolname AS name,
       roles.rolcanlogin AS "canLogin",
       roles.rolsuper AS "isSuperuser",
       roles.rolbypassrls AS "bypassRls",
       current_setting('row_security') AS "rowSecurity",
       EXISTS (
         SELECT 1 FROM pg_class relation
         WHERE relation.relowner = roles.oid
           AND relation.relnamespace = 'public'::regnamespace
           AND relation.relkind IN ('r', 'p')
       ) AS "ownsPublicTables"
     FROM pg_roles roles
     WHERE roles.rolname = current_user`
  );
  const role = result.rows[0];
  if (!role) throw new Error("Could not inspect the PostgreSQL runtime role");
  return {
    name: role.name,
    canLogin: role.canLogin,
    isSuperuser: role.isSuperuser,
    bypassRls: role.bypassRls,
    rowSecurityEnabled: role.rowSecurity === "on",
    ownsPublicTables: role.ownsPublicTables
  };
}

export function databaseRoleSafetyIssue(role: CloudDatabaseRole): string | undefined {
  if (!role.canLogin) return "the runtime database role cannot log in";
  if (role.isSuperuser) return "the runtime database role is a PostgreSQL superuser";
  if (role.bypassRls) return "the runtime database role has BYPASSRLS";
  if (!role.rowSecurityEnabled) return "row_security is disabled for the runtime database role";
  if (role.ownsPublicTables) return "the runtime database role owns application tables";
  return undefined;
}

export async function assertCloudSchemaSafety(
  database: Pick<CloudDatabase, "query">,
  expectedMigrations: Pick<MigrationFile, "version" | "name" | "checksum">[]
): Promise<void> {
  const applied = await database.query<AppliedMigrationRow>(
    "SELECT version, name, checksum FROM cloud_schema_migration ORDER BY version"
  );
  if (applied.rows.length !== expectedMigrations.length) {
    throw new CloudSchemaSafetyError("The cloud migration history is not current for this build");
  }
  for (let index = 0; index < expectedMigrations.length; index += 1) {
    const expected = expectedMigrations[index]!;
    const actual = applied.rows[index];
    if (
      actual === undefined ||
      actual.version !== expected.version ||
      actual.name !== expected.name ||
      actual.checksum !== expected.checksum
    ) {
      throw new CloudSchemaSafetyError(
        `Cloud migration ${String(expected.version).padStart(4, "0")}_${expected.name} does not match this build`
      );
    }
  }

  const safety = await database.query<TenantTableSafetyRow>(
    `SELECT relation.relname AS "tableName",
       relation.relrowsecurity AS "rowSecurity",
       relation.relforcerowsecurity AS "forceRowSecurity",
       policy.oid IS NOT NULL AS "hasTenantPolicy",
       policy.polpermissive AS "policyPermissive",
       policy.polcmd AS "policyCommand",
       policy.polroles = ARRAY[0::oid] AS "policyPublicOnly",
       pg_get_expr(policy.polqual, policy.polrelid) AS "policyUsing",
       pg_get_expr(policy.polwithcheck, policy.polrelid) AS "policyWithCheck"
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     LEFT JOIN pg_policy policy
       ON policy.polrelid = relation.oid
      AND policy.polname = CASE
        WHEN relation.relname = 'workspace' THEN 'workspace_tenant_policy'
        ELSE relation.relname || '_tenant_policy'
      END
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
       AND relation.relname = ANY($1::text[])
     ORDER BY relation.relname`,
    [[...TENANT_TABLES]]
  );
  const byName = new Map(safety.rows.map((row) => [row.tableName, row]));
  for (const tableName of TENANT_TABLES) {
    const table = byName.get(tableName);
    if (!table) {
      throw new CloudSchemaSafetyError(`Required tenant table ${tableName} is missing`);
    }
    const workspaceColumn = tableName === "workspace" ? "id" : "workspace_id";
    const expectedPredicate =
      `(${workspaceColumn} = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)`;
    if (
      !table.rowSecurity ||
      !table.forceRowSecurity ||
      !table.hasTenantPolicy ||
      table.policyPermissive !== true ||
      table.policyCommand !== "*" ||
      table.policyPublicOnly !== true ||
      table.policyUsing !== expectedPredicate ||
      table.policyWithCheck !== expectedPredicate
    ) {
      throw new CloudSchemaSafetyError(
        `Tenant isolation is not forced with the exact expected policy on ${tableName}`
      );
    }
  }

  const policies = await database.query<TenantPolicySafetyRow>(
    `SELECT relation.relname AS "tableName",
       policy.polname AS "policyName",
       policy.polpermissive AS "policyPermissive",
       policy.polcmd AS "policyCommand",
       policy.polroles = ARRAY[0::oid] AS "policyPublicOnly",
       pg_get_expr(policy.polqual, policy.polrelid) AS "policyUsing",
       pg_get_expr(policy.polwithcheck, policy.polrelid) AS "policyWithCheck"
     FROM pg_policy policy
     JOIN pg_class relation ON relation.oid = policy.polrelid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY($1::text[])
     ORDER BY relation.relname, policy.polname`,
    [[...TENANT_TABLES]]
  );
  const expectedPolicies = new Map<string, Omit<TenantPolicySafetyRow, "tableName" | "policyName">>();
  for (const tableName of TENANT_TABLES) {
    const workspaceColumn = tableName === "workspace" ? "id" : "workspace_id";
    const predicate =
      `(${workspaceColumn} = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)`;
    expectedPolicies.set(`${tableName}:${tableName}_tenant_policy`, {
      policyPermissive: true,
      policyCommand: "*",
      policyPublicOnly: true,
      policyUsing: predicate,
      policyWithCheck: predicate
    });
  }
  expectedPolicies.set("workspace_member:workspace_member_self_lookup_policy", {
    policyPermissive: true,
    policyCommand: "r",
    policyPublicOnly: true,
    policyUsing:
      "(user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)",
    policyWithCheck: null
  });

  if (policies.rows.length !== expectedPolicies.size) {
    throw new CloudSchemaSafetyError("The tenant RLS policy set is not exact for this build");
  }
  for (const policy of policies.rows) {
    const key = `${policy.tableName}:${policy.policyName}`;
    const expected = expectedPolicies.get(key);
    if (
      !expected ||
      policy.policyPermissive !== expected.policyPermissive ||
      policy.policyCommand !== expected.policyCommand ||
      policy.policyPublicOnly !== expected.policyPublicOnly ||
      policy.policyUsing !== expected.policyUsing ||
      policy.policyWithCheck !== expected.policyWithCheck
    ) {
      throw new CloudSchemaSafetyError(`Tenant RLS policy ${key} is not exact for this build`);
    }
    expectedPolicies.delete(key);
  }
  if (expectedPolicies.size > 0) {
    throw new CloudSchemaSafetyError("A required tenant RLS policy is missing");
  }
}

export async function createCloudSchemaAttestor(
  database: CloudDatabase,
  migrationDirectory = fileURLToPath(new URL("../../migrations", import.meta.url))
): Promise<() => Promise<void>> {
  const expectedMigrations = await readMigrationFiles(migrationDirectory);
  const attest = () => assertCloudSchemaSafety(database, expectedMigrations);
  await attest();
  return attest;
}

export async function withTransaction<T>(
  database: CloudDatabase,
  run: (client: PoolClient) => Promise<T>,
  options: { isolationLevel?: "REPEATABLE READ" } = {}
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query(
      options.isolationLevel === undefined
        ? "BEGIN"
        : `BEGIN ISOLATION LEVEL ${options.isolationLevel}`
    );
    const value = await run(client);
    await client.query("COMMIT");
    return value;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const cloudDatabaseInternals = { TENANT_TABLES };

export async function one<T extends QueryResultRow>(
  client: Pick<PoolClient, "query"> | CloudDatabase,
  text: string,
  values: unknown[] = []
): Promise<T | undefined> {
  const result = await client.query<T>(text, values);
  return result.rows[0];
}
