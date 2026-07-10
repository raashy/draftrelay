import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { IdempotencyConflictError } from "../server/errors.js";
import { loadCloudConfig } from "./config.js";
import { CloudStore, type CloudActor } from "./store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.runIf(Boolean(databaseUrl));

integration("CloudStore PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 3 });
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const emailSuffix = randomUUID();
  const actor: CloudActor = {
    userId,
    name: "Store Test",
    kind: "agent",
    label: "integration-test"
  };
  const otherActor: CloudActor = {
    userId: otherUserId,
    name: "Other Test",
    kind: "human",
    label: "integration-test"
  };
  const store = new CloudStore(pool, loadCloudConfig({
    NODE_ENV: "test",
    APP_URL: "http://localhost:3941",
    DATABASE_URL: databaseUrl!,
    FREE_DAILY_SAVES: "500",
    FREE_MONTHLY_SAVES: "500"
  }));

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, 'Store Test', $2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($3, 'Other Test', $4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, `store-${emailSuffix}@example.com`, otherUserId, `other-${emailSuffix}@example.com`]
    );
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      const memberships = await pool.query<{ workspace_id: string }>(
        `BEGIN;
         SELECT set_config('app.user_id', $1::uuid::text, true);
         SELECT workspace_id FROM workspace_member WHERE user_id = $1::uuid;`,
        [id]
      ).catch(() => ({ rows: [] as Array<{ workspace_id: string }> }));
      await pool.query("ROLLBACK").catch(() => undefined);
      for (const membership of memberships.rows) {
        await pool.query("BEGIN");
        await pool.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [membership.workspace_id]);
        await pool.query("DELETE FROM workspace WHERE id = $1", [membership.workspace_id]);
        await pool.query("COMMIT");
      }
    }
    await pool.query("DELETE FROM \"user\" WHERE id = ANY($1::uuid[])", [[userId, otherUserId]]);
    await pool.end();
  });

  it("creates, isolates, revises, transforms, records use, and reports quota usage", async () => {
    const created = await store.create(actor, {
      title: "Release update",
      contentMarkdown: "# Ready\n\nAll focused checks passed.",
      kind: "summary",
      project: "Launch",
      tags: ["release"],
      idempotencyKey: "integration-create-1"
    });
    expect(created.currentRevision).toBe(1);
    expect(created.project).toBe("Launch");

    const replay = await store.create(actor, {
      title: "Release update",
      contentMarkdown: "# Ready\n\nAll focused checks passed.",
      kind: "summary",
      project: "Launch",
      tags: ["release"],
      idempotencyKey: "integration-create-1"
    });
    expect(replay.id).toBe(created.id);
    await expect(store.create(actor, {
      title: "Must not reuse a key for changed content",
      contentMarkdown: "Duplicate",
      idempotencyKey: "integration-create-1"
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await store.get(otherActor, created.id)).toBeUndefined();

    const revised = await store.createRevision(actor, created.id, {
      contentMarkdown: "# Ready\n\nAll checks passed. Staging is next.",
      baseRevision: 1,
      changeNote: "Added next step",
      idempotencyKey: "integration-revise-1"
    });
    expect(revised.currentRevision).toBe(2);
    await expect(store.createRevision(actor, created.id, {
      contentMarkdown: "# Ready\n\nAll checks passed. Staging is next.",
      baseRevision: 1,
      changeNote: "Added next step",
      idempotencyKey: "integration-revise-1"
    })).resolves.toMatchObject({ currentRevision: 2 });
    await expect(store.createRevision(actor, created.id, {
      contentMarkdown: "Changed retry payload",
      baseRevision: 1,
      idempotencyKey: "integration-revise-1"
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await store.listRevisions(actor, created.id)).toHaveLength(2);

    const representation = await store.getRepresentation(actor, created.id, "slack");
    expect(representation.copyAllowed).toBe(true);
    expect(representation.markdownText).toContain("*Ready*");
    const copied = await store.recordCopy(actor, created.id, {
      representationId: representation.id,
      destination: "slack",
      clientEventId: "integration-copy-1"
    });
    expect(copied.status).toBe("copied");
    await expect(store.recordCopy(actor, created.id, {
      representationId: representation.id,
      destination: "slack",
      format: "markdown",
      clientEventId: "integration-copy-1"
    })).rejects.toBeInstanceOf(IdempotencyConflictError);

    const listed = await store.list(actor, { archived: "all", project: "Launch" });
    expect(listed.items.map((item) => item.id)).toContain(created.id);
    expect(listed.facets.projects).toContainEqual({ value: "Launch", count: 1 });

    const usage = await store.usage(actor);
    expect(usage.plan).toBe("free");
    expect(usage.monthlySaves.used).toBe(2);
    expect(usage.storedItems.used).toBe(1);

    const exported = await store.exportData(actor) as {
      workspaceMembers: Array<{ user_id: string }>;
      items: Array<{ id: string }>;
      revisions: Array<{ item_id: string }>;
      representations: Array<{ id: string }>;
      entitlements: unknown[];
    };
    expect(exported.workspaceMembers).toContainEqual(expect.objectContaining({ user_id: userId }));
    expect(exported.items).toContainEqual(expect.objectContaining({ id: created.id }));
    expect(exported.revisions).toContainEqual(expect.objectContaining({ item_id: created.id }));
    expect(exported.representations).toContainEqual(expect.objectContaining({ id: representation.id }));
    expect(exported.entitlements).toEqual([]);

    for (let request = 0; request < 60; request += 1) {
      await store.consumeMcpRequest(actor);
    }
    await expect(store.consumeMcpRequest(actor)).rejects.toMatchObject({
      name: "QuotaExceededError",
      metric: "requestsPerMinute",
      limit: 60
    });
  });

  it("re-scans the current project policy before allowing a representation to be copied", async () => {
    const blocked = await store.create(actor, {
      title: "Policy shift",
      contentMarkdown: "credential-value-for-later",
      project: "Escalated policy"
    });
    await store.addSecretPattern(actor, "Escalated policy", {
      label: "Escalated credential",
      patternKind: "literal",
      pattern: "credential-value-for-later",
      severity: "high"
    });
    await expect(store.getRepresentation(actor, blocked.id, "plain")).resolves.toMatchObject({
      copyAllowed: false,
      blockReasons: expect.arrayContaining([expect.stringContaining("credential")])
    });

    const warned = await store.create(actor, {
      title: "Warning shift",
      contentMarkdown: "warning-value-for-later",
      project: "Warning policy"
    });
    await store.addSecretPattern(actor, "Warning policy", {
      label: "New warning",
      patternKind: "literal",
      pattern: "warning-value-for-later",
      severity: "medium"
    });
    const warningRepresentation = await store.getRepresentation(actor, warned.id, "plain");
    expect(warningRepresentation).toMatchObject({
      copyAllowed: false,
      blockReasons: expect.arrayContaining(["Secret warnings must be acknowledged before copying."])
    });
    const refreshed = await store.get(actor, warned.id);
    const findingId = refreshed?.secretFindings[0]?.id;
    expect(findingId).toBeDefined();
    await store.acknowledgeFinding(actor, warned.id, findingId!);
    await expect(store.getRepresentation(actor, warned.id, "plain")).resolves.toMatchObject({
      copyAllowed: true,
      blockReasons: []
    });
  });

  it("purges stale usage counters within the forced-RLS workspace context", async () => {
    await store.list(actor, { archived: "all" });
    const client = await pool.connect();
    let workspaceId: string;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1::uuid::text, true)", [userId]);
      const membership = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM workspace_member WHERE user_id = $1::uuid",
        [userId]
      );
      workspaceId = membership.rows[0]!.workspace_id;
      await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      await client.query(
        `INSERT INTO usage_counter (workspace_id, metric, period_start, period_end, value)
         VALUES ($1, 'stale-integration-counter', CURRENT_TIMESTAMP - INTERVAL '101 days',
           CURRENT_TIMESTAMP - INTERVAL '100 days', 1)`,
        [workspaceId]
      );
      await client.query("COMMIT");

      await store.get(actor, randomUUID());

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      const remaining = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM usage_counter
         WHERE workspace_id = $1 AND metric = 'stale-integration-counter'`,
        [workspaceId]
      );
      expect(Number(remaining.rows[0]?.count)).toBe(0);
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("paginates beyond the former 250-item cap and keeps complete facet counts", async () => {
    const expected = 255;
    for (let index = 0; index < expected; index += 1) {
      await store.create(actor, {
        title: `Pagination item ${String(index + 1).padStart(3, "0")}`,
        contentMarkdown: `Pagination body ${index + 1}`,
        project: "Large pagination project",
        idempotencyKey: `pagination-${emailSuffix}-${index}`
      });
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(actor, {
        archived: "all",
        project: "Large pagination project",
        limit: 100,
        ...(cursor ? { cursor } : {})
      });
      collected.push(...page.items.map((item) => item.id));
      expect(page.facets.projects).toContainEqual({
        value: "Large pagination project",
        count: expected
      });
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toHaveLength(expected);
    expect(new Set(collected)).toHaveLength(expected);

    await pool.query(
      `INSERT INTO "account" (
         id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
         "idToken", password, "createdAt", "updatedAt"
       ) VALUES ($1, $2, 'credential', $3, 'must-not-export-access-token',
         'must-not-export-refresh-token', 'must-not-export-id-token',
         'must-not-export-password-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), `account-${emailSuffix}`, userId]
    );
    await pool.query(
      `INSERT INTO "session" (
         id, "expiresAt", token, "createdAt", "updatedAt", "ipAddress", "userAgent", "userId"
       ) VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '1 hour', 'must-not-export-session-token',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '203.0.113.55', 'integration browser', $2)`,
      [randomUUID(), userId]
    );
    await pool.query(
      `INSERT INTO passkey (
         id, name, "publicKey", "userId", "credentialID", counter,
         "deviceType", "backedUp", transports, "createdAt", aaguid
       ) VALUES ($1, 'Laptop', 'must-not-export-passkey-public-key', $2, $3,
         0, 'singleDevice', false, 'internal', CURRENT_TIMESTAMP, 'test-aaguid')`,
      [randomUUID(), userId, `credential-${emailSuffix}`]
    );

    const chunks: string[] = [];
    await store.streamExportData(actor, (chunk) => { chunks.push(chunk); });
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk)))).toBeLessThan(2_000_000);
    const streamed = JSON.parse(chunks.join("")) as {
      account: {
        profile: { id: string; email: string };
        linkedAccounts: Array<Record<string, unknown>>;
        sessions: Array<Record<string, unknown>>;
        passkeys: Array<Record<string, unknown>>;
        oauthConnections: Array<Record<string, unknown>>;
        subscriptions: Array<Record<string, unknown>>;
      };
      items: Array<{ project_id: string }>;
    };
    expect(streamed.account.profile.id).toBe(userId);
    expect(streamed.account.profile.email).toContain("store-");
    expect(streamed.account).toMatchObject({
      linkedAccounts: [expect.objectContaining({ providerId: "credential" })],
      sessions: [expect.objectContaining({ userAgent: "integration browser" })],
      passkeys: [expect.objectContaining({ name: "Laptop" })],
      oauthConnections: [],
      subscriptions: []
    });
    expect(streamed.items.length).toBeGreaterThanOrEqual(expected);
    const serialized = chunks.join("");
    expect(serialized).not.toContain("idempotency_fingerprint");
    expect(serialized).not.toContain("must-not-export");
    expect(serialized).not.toContain("203.0.113.55");
  }, 30_000);
});
