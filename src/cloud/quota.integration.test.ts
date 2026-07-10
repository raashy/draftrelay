import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { SecretPatternLimitError } from "../server/errors.js";
import { MAX_CUSTOM_SECRET_PATTERNS } from "../server/security.js";
import { loadCloudConfig } from "./config.js";
import { CloudStore, type CloudActor } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

async function insertUser(pool: Pool, userId: string, label: string): Promise<void> {
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [userId, label, `${label.toLowerCase().replaceAll(" ", "-")}-${randomUUID()}@example.com`]
  );
}

async function rollbackAndRelease(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
}

integration("durable quota concurrency", () => {
  it("allows only three free OAuth clients under simultaneous consent inserts", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const userId = randomUUID();
    const clientIds = Array.from({ length: 4 }, () => `quota-${randomUUID()}`);
    const clients: PoolClient[] = [];
    try {
      await insertUser(pool, userId, "OAuth Quota Test");
      for (const clientId of clientIds) {
        await pool.query(
          `INSERT INTO "oauthClient" (
             "clientId", "userId", "redirectUris", "createdAt", "updatedAt"
           ) VALUES ($1, $2, '["http://127.0.0.1/callback"]'::jsonb,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [clientId, userId]
        );
      }

      clients.push(...await Promise.all(clientIds.map(() => pool.connect())));
      await Promise.all(clients.map((client) => client.query("BEGIN")));

      const results = await Promise.allSettled(clients.map(async (client, index) => {
        try {
          await client.query(
            `WITH synchronized AS MATERIALIZED (SELECT pg_sleep(0.1))
             INSERT INTO "oauthConsent" (
               "clientId", "userId", "scopes", "createdAt", "updatedAt"
             )
             SELECT $1, $2, '["outputs:read"]'::jsonb,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             FROM synchronized`,
            [clientIds[index], userId]
          );
          await client.query("COMMIT");
          return clientIds[index];
        } catch (error: unknown) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }));

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        reason: expect.objectContaining({
          code: "P0001",
          message: expect.stringContaining("oauth_client_quota_exceeded")
        })
      });
      const count = await pool.query<{ count: string }>(
        `SELECT count(DISTINCT "clientId")::text AS count
         FROM "oauthConsent" WHERE "userId" = $1`,
        [userId]
      );
      expect(Number(count.rows[0]?.count)).toBe(3);
    } finally {
      await Promise.all(clients.map((client) => rollbackAndRelease(client)));
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]).catch(() => undefined);
      await pool.end();
    }
  });

  it("clamps previously connected Pro clients when the account returns to Free", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const userId = randomUUID();
    const clientIds = Array.from({ length: 4 }, (_, index) =>
      `downgrade-${index + 1}-${randomUUID()}`
    );
    const store = new CloudStore(pool, loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://localhost:3941",
      DATABASE_URL: databaseUrl!
    }));
    try {
      await insertUser(pool, userId, "OAuth Downgrade Test");
      await pool.query(
        `INSERT INTO subscription (
           id, plan, "referenceId", status, "stripeSyncedAt"
         ) VALUES ($1, 'pro', $2, 'active', CURRENT_TIMESTAMP)`,
        [randomUUID(), userId]
      );
      for (const [index, clientId] of clientIds.entries()) {
        await pool.query(
          `INSERT INTO "oauthClient" (
             "clientId", "userId", "redirectUris", "createdAt", "updatedAt", disabled
           ) VALUES ($1, $2, '["http://127.0.0.1/callback"]'::jsonb,
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'), false)`,
          [clientId, userId, index]
        );
        await pool.query(
          `INSERT INTO "oauthConsent" (
             "clientId", "userId", scopes, "createdAt", "updatedAt"
           ) VALUES ($1, $2, '["outputs:read"]'::jsonb,
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'))`,
          [clientId, userId, index]
        );
      }

      expect(await Promise.all(
        clientIds.map((clientId) => store.isOAuthConnectionActive(userId, clientId))
      )).toEqual([true, true, true, true]);

      await pool.query(
        `UPDATE subscription SET status = 'canceled', "stripeSyncedAt" = CURRENT_TIMESTAMP
         WHERE "referenceId" = $1`,
        [userId]
      );
      expect(await Promise.all(
        clientIds.map((clientId) => store.isOAuthConnectionActive(userId, clientId))
      )).toEqual([true, true, true, false]);

      await pool.query(
        `UPDATE "oauthClient" SET disabled = true WHERE "clientId" = $1`,
        [clientIds[0]]
      );
      expect(await Promise.all(
        clientIds.map((clientId) => store.isOAuthConnectionActive(userId, clientId))
      )).toEqual([false, true, true, true]);
    } finally {
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]).catch(() => undefined);
      await pool.end();
    }
  });

  it("enforces the 50-pattern project ceiling in PostgreSQL and the cloud store", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const userId = randomUUID();
    const actor: CloudActor = {
      userId,
      name: "Pattern Quota Test",
      kind: "human",
      label: "integration-test"
    };
    const store = new CloudStore(pool, loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://localhost:3941",
      DATABASE_URL: databaseUrl!
    }));
    let workspaceId: string | undefined;
    const client = await pool.connect();
    try {
      await insertUser(pool, userId, "Pattern Quota Test");
      await store.listSecretPatterns(actor, "Quota project");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1::uuid::text, true)", [userId]);
      const membership = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_member WHERE user_id = $1",
        [userId]
      );
      workspaceId = membership.rows[0]?.workspace_id;
      expect(workspaceId).toBeDefined();
      await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      const project = await client.query<{ id: string }>(
        "SELECT id FROM project WHERE workspace_id = $1 AND normalized_name = 'quota project'",
        [workspaceId]
      );
      const projectId = project.rows[0]?.id;
      expect(projectId).toBeDefined();
      const spareProject = await client.query<{ id: string }>(
        `INSERT INTO project (workspace_id, name)
         VALUES ($1, 'Spare project') RETURNING id`,
        [workspaceId]
      );
      const spareProjectId = spareProject.rows[0]?.id;
      expect(spareProjectId).toBeDefined();
      const movablePattern = await client.query<{ id: string }>(
        `INSERT INTO project_secret_pattern (
           workspace_id, project_id, label, pattern_kind, pattern, severity
         ) VALUES ($1, $2, 'Movable', 'literal', 'movable-secret', 'high')
         RETURNING id`,
        [workspaceId, spareProjectId]
      );
      const movablePatternId = movablePattern.rows[0]?.id;
      expect(movablePatternId).toBeDefined();

      for (let index = 0; index < MAX_CUSTOM_SECRET_PATTERNS; index += 1) {
        await client.query(
          `INSERT INTO project_secret_pattern (
             workspace_id, project_id, label, pattern_kind, pattern, severity
           ) VALUES ($1, $2, $3, 'literal', $4, 'high')`,
          [workspaceId, projectId, `Pattern ${index + 1}`, `secret-${index + 1}`]
        );
      }
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      await expect(client.query(
        `UPDATE project_secret_pattern SET project_id = $1
         WHERE workspace_id = $2 AND id = $3`,
        [projectId, workspaceId, movablePatternId]
      )).rejects.toMatchObject({
        code: "P0001",
        message: expect.stringContaining("secret_pattern_quota_exceeded")
      });
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      await expect(client.query(
        `INSERT INTO project_secret_pattern (
           workspace_id, project_id, label, pattern_kind, pattern, severity
         ) VALUES ($1, $2, 'Pattern 51', 'literal', 'secret-51', 'high')`,
        [workspaceId, projectId]
      )).rejects.toMatchObject({
        code: "P0001",
        message: expect.stringContaining("secret_pattern_quota_exceeded")
      });
      await client.query("ROLLBACK");

      await expect(store.addSecretPattern(actor, "Quota project", {
        label: "Pattern 51",
        patternKind: "literal",
        pattern: "secret-51",
        severity: "high"
      })).rejects.toBeInstanceOf(SecretPatternLimitError);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      if (workspaceId) {
        const cleanup = await pool.connect();
        try {
          await cleanup.query("BEGIN");
          await cleanup.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
          await cleanup.query("DELETE FROM workspace WHERE id = $1", [workspaceId]);
          await cleanup.query("COMMIT");
        } catch {
          await cleanup.query("ROLLBACK").catch(() => undefined);
        } finally {
          cleanup.release();
        }
      }
      await pool.query('DELETE FROM "user" WHERE id = $1', [userId]).catch(() => undefined);
      await pool.end();
    }
  });
});
