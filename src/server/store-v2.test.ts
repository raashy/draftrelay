import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  CopyBlockedError,
  IdempotencyConflictError,
  ItemStore,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "./store.js";
import { MAX_CUSTOM_SECRET_PATTERNS } from "./security.js";

const stores: ItemStore[] = [];
const temporaryDirectories: string[] = [];

function memoryStore(options: ConstructorParameters<typeof ItemStore>[0] = { databasePath: ":memory:" }) {
  const store = new ItemStore(options);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("v0.2 ItemStore", () => {
  it("caps custom secret patterns per project", () => {
    const store = memoryStore();
    for (let index = 0; index < MAX_CUSTOM_SECRET_PATTERNS; index += 1) {
      store.addSecretPattern("Bounded", {
        label: `Pattern ${index}`,
        patternKind: "literal",
        pattern: `bounded-secret-${index}`,
        severity: "medium"
      });
    }
    expect(store.listSecretPatterns("Bounded")).toHaveLength(MAX_CUSTOM_SECRET_PATTERNS);
    expect(() => store.addSecretPattern("Bounded", {
      label: "One too many",
      patternKind: "literal",
      pattern: "bounded-secret-over-limit",
      severity: "medium"
    })).toThrow(SecretPatternLimitError);
  });

  it("keeps immutable revisions, provenance, lifecycle, and destination copy receipts", () => {
    const store = memoryStore({
      databasePath: ":memory:",
      idGenerator: () => "artifact-1",
      now: () => new Date("2026-07-10T10:00:00.000Z")
    });
    const created = store.create({
      title: "Launch update",
      contentMarkdown: "**Ready.**",
      kind: "reply",
      project: "Website",
      sourceClient: "codex",
      provenance: {
        sourceClient: "codex",
        branch: "feature/outbox",
        commitSha: "abc123",
        referencedFiles: [{ path: "src/server/store.ts", lineStart: 10, lineEnd: 20 }]
      }
    });
    expect(created).toMatchObject({
      status: "new",
      currentRevision: 1,
      revisionCount: 1,
      humanEdited: false,
      provenance: {
        sourceClient: "codex",
        branch: "feature/outbox",
        commitSha: "abc123",
        captureMethod: "client_supplied"
      }
    });

    expect(store.transition(created.id, "reviewed").status).toBe("reviewed");
    const representation = store.getRepresentation(created.id, "plain");
    expect(representation).toMatchObject({
      itemId: created.id,
      destination: "plain",
      plainText: "Ready.",
      copyAllowed: true
    });
    expect(
      store.recordCopy(created.id, {
        representationId: representation.id,
        destination: "plain",
        clientEventId: "copy-1"
      }).status
    ).toBe("copied");
    expect(
      store.recordCopy(created.id, {
        representationId: representation.id,
        destination: "plain",
        clientEventId: "copy-1"
      }).status
    ).toBe("copied");

    const revised = store.createRevision(created.id, {
      contentMarkdown: "**Ready Monday.**",
      changeNote: "Clarified timing",
      baseRevision: 1,
      authorKind: "human"
    });
    expect(revised).toMatchObject({
      contentMarkdown: "**Ready Monday.**",
      currentRevision: 2,
      revisionCount: 2,
      status: "new",
      humanEdited: true
    });
    expect(store.listRevisions(created.id).map((revision) => revision.contentMarkdown)).toEqual([
      "**Ready Monday.**",
      "**Ready.**"
    ]);
    expect(() =>
      store.createRevision(created.id, {
        contentMarkdown: "Stale",
        baseRevision: 1
      })
    ).toThrow(StaleRevisionError);
  });

  it("rejects idempotency keys reused across operations or artifacts", () => {
    const store = memoryStore();
    const first = store.create({
      title: "First",
      contentMarkdown: "First body",
      idempotencyKey: "create-key"
    });
    expect(store.create({
      title: "First",
      contentMarkdown: "First body",
      idempotencyKey: "create-key"
    }).id).toBe(first.id);
    expect(() => store.create({
      title: "Changed create",
      contentMarkdown: "First body",
      idempotencyKey: "create-key"
    })).toThrow(IdempotencyConflictError);
    const second = store.create({ title: "Second", contentMarkdown: "Second body" });

    expect(() => store.createRevision(second.id, {
      contentMarkdown: "Wrong target",
      baseRevision: 1,
      idempotencyKey: "create-key"
    })).toThrow(IdempotencyConflictError);

    const revised = store.createRevision(first.id, {
      contentMarkdown: "First revision",
      baseRevision: 1,
      idempotencyKey: "revision-key"
    });
    expect(store.createRevision(first.id, {
      contentMarkdown: "First revision",
      baseRevision: 1,
      idempotencyKey: "revision-key"
    }).currentRevision).toBe(revised.currentRevision);
    expect(() => store.createRevision(first.id, {
      contentMarkdown: "Changed retry payload",
      baseRevision: 1,
      idempotencyKey: "revision-key"
    })).toThrow(IdempotencyConflictError);
    expect(() => store.create({
      title: "Wrong operation",
      contentMarkdown: "Wrong operation",
      idempotencyKey: "revision-key"
    })).toThrow(IdempotencyConflictError);
    expect(() => store.createRevision(second.id, {
      contentMarkdown: "Wrong item",
      baseRevision: 1,
      idempotencyKey: "revision-key"
    })).toThrow(IdempotencyConflictError);

    const firstRepresentation = store.getRepresentation(first.id, "plain");
    store.recordCopy(first.id, {
      representationId: firstRepresentation.id,
      clientEventId: "copy-key"
    });
    expect(() => store.recordCopy(first.id, {
      representationId: firstRepresentation.id,
      format: "markdown",
      clientEventId: "copy-key"
    })).toThrow(IdempotencyConflictError);
    const secondRepresentation = store.getRepresentation(second.id, "plain");
    expect(() => store.recordCopy(second.id, {
      representationId: secondRepresentation.id,
      clientEventId: "copy-key"
    })).toThrow(IdempotencyConflictError);
  });

  it("rolls back a combined content and project update when the new project policy blocks it", () => {
    const store = memoryStore();
    store.addSecretPattern("Strict", {
      label: "Project credential",
      patternKind: "literal",
      pattern: "forbidden-value",
      severity: "high"
    });
    const item = store.create({
      title: "Original",
      contentMarkdown: "Safe body",
      project: "Open"
    });

    expect(() => store.update(item.id, {
      contentMarkdown: "Contains forbidden-value",
      project: "Strict",
      baseRevision: 1
    })).toThrow(SecretBlockedError);

    expect(store.get(item.id)).toMatchObject({
      contentMarkdown: "Safe body",
      currentRevision: 1,
      project: "Open",
      revisionCount: 1
    });
    expect(store.listRevisions(item.id)).toHaveLength(1);
  });

  it("blocks high-confidence secrets and gates warnings until acknowledgment", () => {
    const store = memoryStore();
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    expect(() =>
      store.create({ title: "Do not save", contentMarkdown: `Token: ${secret}` })
    ).toThrow(SecretBlockedError);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM items").get()).toEqual({ count: 0 });
    expect(JSON.stringify(store.database.prepare("SELECT * FROM item_secret_findings").all())).not.toContain(
      secret
    );

    const warned = store.create({
      title: "Configuration note",
      contentMarkdown: "api_key=abcdefghijklmnop",
      project: "Warnings"
    });
    expect(warned.secretFindings).toHaveLength(1);
    const prepared = store.getRepresentation(warned.id, "plain");
    expect(prepared.copyAllowed).toBe(false);
    expect(prepared.blockReasons).toContain("Secret warnings must be acknowledged before copying.");
    expect(() =>
      store.recordCopy(warned.id, { representationId: prepared.id })
    ).toThrow(CopyBlockedError);

    const acknowledged = store.acknowledgeFinding(
      warned.id,
      warned.secretFindings[0]?.id ?? "missing"
    );
    expect(acknowledged.secretFindings[0]?.status).toBe("acknowledged");
    expect(store.getRepresentation(warned.id, "plain").copyAllowed).toBe(true);
  });

  it("applies review and retention policies and purges only expired done items", () => {
    let now = new Date("2026-07-10T10:00:00.000Z");
    const store = memoryStore({ databasePath: ":memory:", now: () => now });
    store.getProjectPolicy("Retention");
    store.updateProjectPolicy("Retention", {
      requireReviewBeforeCopy: true,
      retentionDays: 1
    });
    const item = store.create({
      title: "Temporary update",
      contentMarkdown: "Ready",
      project: "Retention"
    });
    expect(store.getRepresentation(item.id, "plain").copyAllowed).toBe(false);
    store.transition(item.id, "reviewed");
    expect(store.getRepresentation(item.id, "plain").copyAllowed).toBe(true);
    const done = store.transition(item.id, "done");
    expect(done.expiresAt).toBe("2026-07-11T10:00:00.000Z");

    now = new Date("2026-07-12T10:00:00.000Z");
    expect(store.get(item.id)).toBeUndefined();
    expect(store.purgeExpired()).toBe(0);
  });

  it("honors the project default destination and purges expired rows on reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cutline-retention-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "cutline.sqlite3");
    let now = new Date("2026-07-10T10:00:00.000Z");
    const first = memoryStore({ databasePath, now: () => now });
    first.getProjectPolicy("Ephemeral");
    first.updateProjectPolicy("Ephemeral", {
      defaultDestination: "slack",
      allowedDestinations: ["slack", "plain"],
      retentionDays: 1
    });
    const item = first.create({
      title: "Short-lived update",
      contentMarkdown: "Ready",
      project: "Ephemeral"
    });
    expect(item.defaultDestination).toBe("slack");
    first.transition(item.id, "done");
    first.close();
    stores.splice(stores.indexOf(first), 1);

    now = new Date("2026-07-12T10:00:00.000Z");
    const reopened = memoryStore({ databasePath, now: () => now });
    expect(reopened.get(item.id)).toBeUndefined();
  });

  it("migrates the live v0.1 shape additively and idempotently", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "cutline-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "legacy.sqlite3");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        kind TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        source_client TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
    `);
    legacy
      .prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "legacy-id",
        "Client reply",
        "Thanks — Friday works.",
        "reply",
        "ACME",
        '["client"]',
        "claude-code",
        "2026-07-09T10:00:00.000Z",
        "2026-07-09T11:00:00.000Z",
        "2026-07-09T12:00:00.000Z"
      );
    legacy.close();

    const first = memoryStore({ databasePath });
    expect(first.get("legacy-id")).toMatchObject({
      id: "legacy-id",
      contentMarkdown: "Thanks — Friday works.",
      recipeId: "generic_reply",
      status: "done",
      currentRevision: 1,
      revisionCount: 1,
      doneAt: "2026-07-09T12:00:00.000Z"
    });
    expect(first.database.pragma("user_version", { simple: true })).toBe(2);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = memoryStore({ databasePath });
    expect(reopened.listRevisions("legacy-id")).toHaveLength(1);
    const columns = reopened.database
      .prepare<[], { name: string }>("PRAGMA table_info(items)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("content_markdown");
    expect(columns).toContain("current_revision");
  });
});
