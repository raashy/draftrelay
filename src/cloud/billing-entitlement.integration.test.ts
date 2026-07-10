import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadCloudConfig } from "./config.js";
import { CloudStore, type CloudActor } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("fresh Stripe entitlement invariants", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const userId = randomUUID();
  const actor: CloudActor = {
    userId,
    name: "Entitlement Test",
    kind: "human",
    label: "billing-integration"
  };
  const store = new CloudStore(pool, loadCloudConfig({
    NODE_ENV: "test",
    APP_URL: "http://localhost:3941",
    DATABASE_URL: databaseUrl!
  }));
  const clientIds = Array.from({ length: 21 }, (_, index) =>
    `entitlement-client-${index + 1}-${userId}`
  );

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Entitlement Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, `entitlement-${userId}@example.com`]
    );
    await pool.query(
      `INSERT INTO subscription (
         id, plan, "referenceId", "stripeCustomerId", "stripeSubscriptionId",
         status, seats, "billingInterval", "stripeSyncedAt"
       ) VALUES ($1::uuid, 'pro', $2, $3, $4, 'active', 1, 'month', CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, `cus_entitlement_${userId}`, `sub_entitlement_${userId}`]
    );
    for (const [index, clientId] of clientIds.entries()) {
      await pool.query(
        `INSERT INTO "oauthClient" (
           "clientId", "redirectUris", "createdAt", "updatedAt", name, disabled
         ) VALUES ($1, '[]'::jsonb, $2, $2, $3, false)`,
        [clientId, new Date(Date.now() + index * 1_000), `Entitlement Client ${index + 1}`]
      );
    }
  });

  afterAll(async () => {
    const memberships = await pool.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_member WHERE user_id = $1::uuid`,
      [userId]
    );
    for (const membership of memberships.rows) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.user_id', $1::uuid::text, true)", [userId]);
        await client.query(
          "SELECT set_config('app.workspace_id', $1::uuid::text, true)",
          [membership.workspace_id]
        );
        await client.query("DELETE FROM workspace WHERE id = $1", [membership.workspace_id]);
        await client.query("COMMIT");
      } catch (error: unknown) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    await pool.query(`DELETE FROM "oauthClient" WHERE "clientId" = ANY($1::text[])`, [clientIds]);
    await pool.query(`DELETE FROM "user" WHERE id = $1::uuid`, [userId]);
    await pool.end();
  });

  it("allows 20 for fresh Stripe Pro, then clamps existing and new clients to Free=3 when stale", async () => {
    for (const clientId of clientIds.slice(0, 20)) {
      await pool.query(
        `INSERT INTO "oauthConsent" (
           "clientId", "userId", scopes, "createdAt", "updatedAt"
         ) VALUES ($1, $2::uuid, '["outputs:read"]'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [clientId, userId]
      );
    }

    const fresh = await store.usage(actor);
    expect(fresh.plan).toBe("pro");
    expect(fresh.activeOAuthClients).toEqual({ used: 20, limit: 20 });
    expect(await store.isOAuthConnectionActive(userId, clientIds[19]!)).toBe(true);
    await expect(pool.query(
      `INSERT INTO "oauthConsent" (
         "clientId", "userId", scopes, "createdAt", "updatedAt"
       ) VALUES ($1, $2::uuid, '["outputs:read"]'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [clientIds[20], userId]
    )).rejects.toMatchObject({
      code: "P0001",
      message: "oauth_client_quota_exceeded",
      detail: "Connected MCP client limit is 20"
    });

    await pool.query(
      `UPDATE subscription
       SET "stripeSyncedAt" = CURRENT_TIMESTAMP - INTERVAL '25 hours'
       WHERE "referenceId" = $1`,
      [userId]
    );

    const stale = await store.usage(actor);
    expect(stale.plan).toBe("free");
    expect(stale.activeOAuthClients).toEqual({ used: 20, limit: 3 });
    expect(await store.isOAuthConnectionActive(userId, clientIds[0]!)).toBe(true);
    expect(await store.isOAuthConnectionActive(userId, clientIds[2]!)).toBe(true);
    expect(await store.isOAuthConnectionActive(userId, clientIds[3]!)).toBe(false);
    await expect(pool.query(
      `INSERT INTO "oauthConsent" (
         "clientId", "userId", scopes, "createdAt", "updatedAt"
       ) VALUES ($1, $2::uuid, '["outputs:read"]'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [clientIds[20], userId]
    )).rejects.toMatchObject({
      code: "P0001",
      message: "oauth_client_quota_exceeded",
      detail: "Connected MCP client limit is 3"
    });
  });

  it("allows a workspace override to raise the durable and ranked client cap to 20", async () => {
    const overrideUserId = randomUUID();
    const overrideActor: CloudActor = {
      userId: overrideUserId,
      name: "Workspace Override Test",
      kind: "human",
      label: "workspace-override-integration"
    };
    const overrideClientIds = Array.from({ length: 21 }, (_, index) =>
      `workspace-override-client-${index + 1}-${overrideUserId}`
    );
    try {
      await pool.query(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES ($1, 'Workspace Override Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [overrideUserId, `workspace-override-${overrideUserId}@example.com`]
      );
      const free = await store.usage(overrideActor);
      expect(free.plan).toBe("free");
      expect(free.activeOAuthClients.limit).toBe(3);

      const tenantClient = await pool.connect();
      let workspaceId: string | undefined;
      try {
        await tenantClient.query("BEGIN");
        await tenantClient.query(
          "SELECT set_config('app.user_id', $1::uuid::text, true)",
          [overrideUserId]
        );
        const membership = await tenantClient.query<{ workspace_id: string }>(
          `SELECT workspace_id FROM workspace_member WHERE user_id = $1::uuid
           ORDER BY created_at, workspace_id LIMIT 1`,
          [overrideUserId]
        );
        workspaceId = membership.rows[0]?.workspace_id;
        expect(workspaceId).toBeDefined();
        await tenantClient.query(
          "SELECT set_config('app.workspace_id', $1::uuid::text, true)",
          [workspaceId]
        );
        await tenantClient.query(
          `UPDATE workspace SET plan = 'enterprise' WHERE id = $1::uuid`,
          [workspaceId]
        );
        await tenantClient.query("COMMIT");
      } catch (error: unknown) {
        await tenantClient.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        tenantClient.release();
      }

      for (const [index, clientId] of overrideClientIds.entries()) {
        await pool.query(
          `INSERT INTO "oauthClient" (
             "clientId", "userId", "redirectUris", "createdAt", "updatedAt", disabled
           ) VALUES ($1, $2::uuid, '[]'::jsonb,
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'), false)`,
          [clientId, overrideUserId, index]
        );
      }
      for (const [index, clientId] of overrideClientIds.slice(0, 20).entries()) {
        await pool.query(
          `INSERT INTO "oauthConsent" (
             "clientId", "userId", scopes, "createdAt", "updatedAt"
           ) VALUES ($1, $2::uuid, '["outputs:read"]'::jsonb,
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
             CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'))`,
          [clientId, overrideUserId, index]
        );
      }

      const overridden = await store.usage(overrideActor);
      expect(overridden.plan).toBe("pro");
      expect(overridden.activeOAuthClients).toEqual({ used: 20, limit: 20 });
      expect(await store.isOAuthConnectionActive(overrideUserId, overrideClientIds[3]!)).toBe(true);
      expect(await store.isOAuthConnectionActive(overrideUserId, overrideClientIds[19]!)).toBe(true);
      await expect(pool.query(
        `INSERT INTO "oauthConsent" (
           "clientId", "userId", scopes, "createdAt", "updatedAt"
         ) VALUES ($1, $2::uuid, '["outputs:read"]'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [overrideClientIds[20], overrideUserId]
      )).rejects.toMatchObject({
        code: "P0001",
        message: "oauth_client_quota_exceeded",
        detail: "Connected MCP client limit is 20"
      });

      await pool.query(`UPDATE "oauthClient" SET disabled = true WHERE "clientId" = $1`, [
        overrideClientIds[0]
      ]);
      expect(await store.isOAuthConnectionActive(overrideUserId, overrideClientIds[0]!)).toBe(false);
      expect(await store.isOAuthConnectionActive(overrideUserId, overrideClientIds[19]!)).toBe(true);
      await pool.query(
        `DELETE FROM "oauthConsent" WHERE "userId" = $1::uuid AND "clientId" = $2`,
        [overrideUserId, overrideClientIds[19]]
      );
      expect(await store.isOAuthConnectionActive(overrideUserId, overrideClientIds[19]!)).toBe(false);
    } finally {
      await pool.query(`DELETE FROM "user" WHERE id = $1::uuid`, [overrideUserId]).catch(() => undefined);
    }
  });
});
