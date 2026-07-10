import { describe, expect, it, vi } from "vitest";

import {
  assertCloudSchemaSafety,
  CloudSchemaSafetyError,
  cloudDatabaseInternals,
  databaseRoleSafetyIssue,
  inspectCloudDatabaseRole,
  type CloudDatabase,
  type CloudDatabaseRole
} from "./db.js";

const expectedMigrations = [
  { version: 1, name: "initial", checksum: "a".repeat(64) },
  { version: 2, name: "hardening", checksum: "b".repeat(64) }
];

function tenantTableRows(
  overrides: Partial<{
    tableName: string;
    rowSecurity: boolean;
    forceRowSecurity: boolean;
    hasTenantPolicy: boolean;
    policyPermissive: boolean;
    policyCommand: string;
    policyPublicOnly: boolean;
    policyUsing: string;
    policyWithCheck: string;
  }> = {}
) {
  return cloudDatabaseInternals.TENANT_TABLES.map((tableName) => {
    const workspaceColumn = tableName === "workspace" ? "id" : "workspace_id";
    const policyExpression =
      `(${workspaceColumn} = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)`;
    return {
      tableName,
      rowSecurity: true,
      forceRowSecurity: true,
      hasTenantPolicy: true,
      policyPermissive: true,
      policyCommand: "*",
      policyPublicOnly: true,
      policyUsing: policyExpression,
      policyWithCheck: policyExpression,
      ...(overrides.tableName === undefined || overrides.tableName === tableName ? overrides : {})
    };
  });
}

function tenantPolicyRows() {
  const policies = cloudDatabaseInternals.TENANT_TABLES.map((tableName) => {
    const workspaceColumn = tableName === "workspace" ? "id" : "workspace_id";
    const predicate =
      `(${workspaceColumn} = (NULLIF(current_setting('app.workspace_id'::text, true), ''::text))::uuid)`;
    return {
      tableName,
      policyName: `${tableName}_tenant_policy`,
      policyPermissive: true,
      policyCommand: "*",
      policyPublicOnly: true,
      policyUsing: predicate,
      policyWithCheck: predicate as string | null
    };
  });
  policies.push({
    tableName: "workspace_member",
    policyName: "workspace_member_self_lookup_policy",
    policyPermissive: true,
    policyCommand: "r",
    policyPublicOnly: true,
    policyUsing:
      "(user_id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)",
    policyWithCheck: null
  });
  return policies;
}

function safetyDatabase(
  migrationRows: typeof expectedMigrations = expectedMigrations,
  tableRows = tenantTableRows(),
  policyRows = tenantPolicyRows()
) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows: migrationRows })
      .mockResolvedValueOnce({ rows: tableRows })
      .mockResolvedValueOnce({ rows: policyRows })
  } as unknown as Pick<CloudDatabase, "query">;
}

const safeRole: CloudDatabaseRole = {
  name: "draftrelay_app",
  canLogin: true,
  isSuperuser: false,
  bypassRls: false,
  rowSecurityEnabled: true,
  ownsPublicTables: false
};

describe("cloud database role safety", () => {
  it("accepts a login role that cannot bypass RLS", () => {
    expect(databaseRoleSafetyIssue(safeRole)).toBeUndefined();
  });

  it.each([
    [{ ...safeRole, isSuperuser: true }, "superuser"],
    [{ ...safeRole, bypassRls: true }, "BYPASSRLS"],
    [{ ...safeRole, rowSecurityEnabled: false }, "row_security"],
    [{ ...safeRole, ownsPublicTables: true }, "owns application tables"],
    [{ ...safeRole, canLogin: false }, "cannot log in"]
  ] as const)("rejects an unsafe role", (role, reason) => {
    expect(databaseRoleSafetyIssue(role)).toContain(reason);
  });

  it.each([
    ["policyUsing", "true"],
    ["policyWithCheck", "true"],
    ["policyPermissive", false],
    ["policyCommand", "r"],
    ["policyPublicOnly", false]
  ] as const)("rejects an altered tenant policy %s", async (property, value) => {
    const tableName = cloudDatabaseInternals.TENANT_TABLES[1];
    const rows = tenantTableRows({ tableName, [property]: value });
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, rows),
      expectedMigrations
    )).rejects.toThrow(/exact expected policy/);
  });

  it("reads the active role flags from PostgreSQL", async () => {
    const database = {
      query: async () => ({
        rows: [{
          name: "draftrelay_app",
          canLogin: true,
          isSuperuser: false,
          bypassRls: false,
          rowSecurity: "on",
          ownsPublicTables: false
        }]
      })
    } as unknown as CloudDatabase;

    await expect(inspectCloudDatabaseRole(database)).resolves.toEqual(safeRole);
  });
});

describe("cloud schema safety attestation", () => {
  it("accepts exact migrations only when every tenant table has forced RLS", async () => {
    const database = safetyDatabase();

    await expect(assertCloudSchemaSafety(database, expectedMigrations)).resolves.toBeUndefined();
    expect(database.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("relation.relforcerowsecurity"),
      [[...cloudDatabaseInternals.TENANT_TABLES]]
    );
  });

  it("rejects missing, unexpected, or modified migrations", async () => {
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations.slice(0, 1)),
      expectedMigrations
    )).rejects.toBeInstanceOf(CloudSchemaSafetyError);

    await expect(assertCloudSchemaSafety(
      safetyDatabase([
        expectedMigrations[0]!,
        { ...expectedMigrations[1]!, checksum: "c".repeat(64) }
      ]),
      expectedMigrations
    )).rejects.toThrow(/does not match this build/);
  });

  it.each([
    ["rowSecurity", false],
    ["forceRowSecurity", false],
    ["hasTenantPolicy", false]
  ] as const)("rejects tenant tables when %s is disabled", async (property, value) => {
    const tableName = cloudDatabaseInternals.TENANT_TABLES[0];
    const rows = tenantTableRows({ tableName, [property]: value });
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, rows),
      expectedMigrations
    )).rejects.toThrow(/Tenant isolation is not forced/);
  });

  it("rejects a missing tenant table", async () => {
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, tenantTableRows().slice(1)),
      expectedMigrations
    )).rejects.toThrow(/Required tenant table/);
  });

  it("rejects altered, missing, or additional permissive tenant policies", async () => {
    const altered = tenantPolicyRows().map((policy) =>
      policy.policyName === "workspace_member_self_lookup_policy"
        ? { ...policy, policyUsing: "true" }
        : policy
    );
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, tenantTableRows(), altered),
      expectedMigrations
    )).rejects.toThrow(/not exact/);

    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, tenantTableRows(), tenantPolicyRows().slice(1)),
      expectedMigrations
    )).rejects.toThrow(/policy set is not exact/);

    const additional = [...tenantPolicyRows(), {
      ...tenantPolicyRows()[0]!,
      policyName: "unsafe_public_read",
      policyUsing: "true",
      policyWithCheck: null
    }];
    await expect(assertCloudSchemaSafety(
      safetyDatabase(expectedMigrations, tenantTableRows(), additional),
      expectedMigrations
    )).rejects.toThrow(/policy set is not exact/);
  });
});
