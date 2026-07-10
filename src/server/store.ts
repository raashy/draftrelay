import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  DESTINATIONS,
  type CopyBehavior,
  type CreateItemInput,
  type CreateRevisionInput,
  type Destination,
  type DestinationRepresentation,
  type FacetValue,
  type ItemFacets,
  type ItemProvenance,
  type ItemQuery,
  type ItemRevision,
  type ItemsResponse,
  type ItemStatus,
  type OutputItem,
  type ProjectPolicy,
  type ProjectSecretMode,
  type ProvenanceInput,
  type RecipeId,
  type SecretFinding,
  type SecretSeverity,
  type UpdateItemInput
} from "../shared/items.js";
import {
  getRecipe,
  kindForRecipe,
  recipeForLegacyKind
} from "./recipes.js";
import {
  buildRepresentation,
  TRANSFORMER_VERSION
} from "./representations.js";
import {
  MAX_CUSTOM_SECRET_PATTERNS,
  scanSecrets,
  type ScannedSecretFinding,
  type SecretPattern
} from "./security.js";
import {
  CopyBlockedError,
  FindingNotFoundError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "./errors.js";
import { requestFingerprint } from "./idempotency.js";
import { decodeItemCursor, encodeItemCursor } from "./pagination.js";

export {
  CopyBlockedError,
  FindingNotFoundError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "./errors.js";

interface ItemRow {
  id: string;
  title: string;
  content_markdown: string;
  kind: OutputItem["kind"];
  project: string;
  tags_json: string;
  source_client: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  recipe_id: RecipeId;
  recipe_payload_json: string | null;
  status: ItemStatus;
  current_revision: number;
  status_before_done: ItemStatus | null;
  reviewed_at: string | null;
  copied_at: string | null;
  done_at: string | null;
  expires_at: string | null;
}

interface RevisionRow {
  id: string;
  item_id: string;
  revision: number;
  title: string;
  content_markdown: string;
  recipe_id: RecipeId;
  recipe_payload_json: string | null;
  change_note: string | null;
  author_kind: ItemRevision["authorKind"];
  author_label: string;
  created_at: string;
}

interface ProvenanceRow {
  revision_id: string;
  source_client: string;
  source_client_version: string | null;
  agent_name: string | null;
  model: string | null;
  session_id: string | null;
  cwd: string | null;
  repo_root: string | null;
  repo_remote: string | null;
  branch: string | null;
  commit_sha: string | null;
  repo_dirty: number | null;
  capture_method: ItemProvenance["captureMethod"];
  verification_status: ItemProvenance["verificationStatus"];
  verification_summary: string | null;
  captured_at: string;
}

interface ReferencedFileRow {
  path: string;
  line_start: number | null;
  line_end: number | null;
}

interface FindingRow {
  id: string;
  rule_id: string;
  label: string;
  severity: SecretSeverity;
  action: "warn" | "block";
  line_number: number;
  redacted_preview: string;
  status: SecretFinding["status"];
  acknowledged_at: string | null;
  acknowledged_by: string | null;
}

interface PolicyRow {
  project: string;
  default_recipe_id: RecipeId;
  default_destination: Destination;
  default_destination_explicit: number;
  allowed_destinations_json: string;
  secret_mode: ProjectSecretMode;
  require_secret_ack: number;
  require_review_before_copy: number;
  copy_behavior: CopyBehavior;
  retention_days: number | null;
  updated_at: string;
}

interface PatternRow {
  id: string;
  label: string;
  pattern_kind: "literal" | "glob";
  pattern: string;
  severity: SecretSeverity;
}

interface RepresentationRow {
  id: string;
  item_id: string;
  revision: number;
  destination: Destination;
  plain_text: string;
  markdown_text: string | null;
  html_text: string | null;
  metadata_json: string;
  warnings_json: string;
  created_at: string;
}

type SqlParameter = string | number | bigint | Buffer | null;

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseTags(tagsJson: string): string[] {
  const parsed = parseJson<unknown>(tagsJson, []);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function buildWhere(query: ItemQuery): { sql: string; parameters: SqlParameter[] } {
  const clauses: string[] = [];
  const parameters: SqlParameter[] = [];

  if (query.archived === "true") {
    clauses.push("status = 'done'");
  } else if (query.archived === "false") {
    clauses.push("status != 'done'");
  }

  if (query.q !== undefined) {
    clauses.push(
      "(title LIKE ? ESCAPE '\\' COLLATE NOCASE OR content_markdown LIKE ? ESCAPE '\\' COLLATE NOCASE OR project LIKE ? ESCAPE '\\' COLLATE NOCASE OR tags_json LIKE ? ESCAPE '\\' COLLATE NOCASE)"
    );
    const pattern = `%${escapeLike(query.q)}%`;
    parameters.push(pattern, pattern, pattern, pattern);
  }
  if (query.project !== undefined) {
    clauses.push("project = ? COLLATE NOCASE");
    parameters.push(query.project);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    parameters.push(query.kind);
  }
  if (query.tag !== undefined) {
    clauses.push(
      "EXISTS (SELECT 1 FROM json_each(items.tags_json) WHERE json_each.value = ? COLLATE NOCASE)"
    );
    parameters.push(query.tag);
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    parameters.push(query.status);
  }
  if (query.recipe !== undefined) {
    clauses.push("recipe_id = ?");
    parameters.push(query.recipe);
  }
  if (query.cursor !== undefined) {
    const cursor = decodeItemCursor(query.cursor);
    if (!cursor) throw new Error("Invalid pagination cursor");
    clauses.push(
      `(updated_at < ? OR (updated_at = ? AND
        (created_at < ? OR (created_at = ? AND id < ?))))`
    );
    parameters.push(
      cursor.updatedAt,
      cursor.updatedAt,
      cursor.createdAt,
      cursor.createdAt,
      cursor.id
    );
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    parameters
  };
}

function incrementFacet(counts: Map<string, number>, value: string): void {
  if (value !== "") {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
}

function toFacetValues(counts: Map<string, number>): FacetValue[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function buildFacets(items: OutputItem[]): ItemFacets {
  const projects = new Map<string, number>();
  const kinds = new Map<string, number>();
  const tags = new Map<string, number>();
  const statuses = new Map<string, number>();
  const recipes = new Map<string, number>();

  for (const item of items) {
    incrementFacet(projects, item.project);
    incrementFacet(kinds, item.kind);
    incrementFacet(statuses, item.status);
    incrementFacet(recipes, item.recipeId);
    for (const tag of item.tags) {
      incrementFacet(tags, tag);
    }
  }
  return {
    projects: toFacetValues(projects),
    kinds: toFacetValues(kinds),
    tags: toFacetValues(tags),
    statuses: toFacetValues(statuses),
    recipes: toFacetValues(recipes)
  };
}

function addDays(iso: string, days: number | null): string | null {
  if (days === null) {
    return null;
  }
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function contentChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ItemStoreOptions {
  databasePath: string;
  now?: () => Date;
  idGenerator?: () => string;
  internalIdGenerator?: () => string;
}

export class ItemStore {
  readonly database: Database.Database;

  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly internalIdGenerator: () => string;
  private closed = false;

  constructor(options: ItemStoreOptions) {
    this.database = new Database(options.databasePath);
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.internalIdGenerator = options.internalIdGenerator ?? randomUUID;

    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.migrate();
    this.purgeExpired();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
        content_markdown TEXT NOT NULL CHECK(length(content_markdown) BETWEEN 1 AND 12000),
        kind TEXT NOT NULL,
        project TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
        source_client TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
    `);

    const columns = new Set(
      this.database
        .prepare<[], { name: string }>("PRAGMA table_info(items)")
        .all()
        .map((column) => column.name)
    );
    const additions: Array<[string, string]> = [
      ["recipe_id", "TEXT NOT NULL DEFAULT 'generic_note'"],
      ["recipe_payload_json", "TEXT"],
      ["status", "TEXT NOT NULL DEFAULT 'new'"],
      ["current_revision", "INTEGER NOT NULL DEFAULT 1"],
      ["status_before_done", "TEXT"],
      ["reviewed_at", "TEXT"],
      ["copied_at", "TEXT"],
      ["done_at", "TEXT"],
      ["expires_at", "TEXT"]
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        this.database.exec(`ALTER TABLE items ADD COLUMN ${name} ${definition}`);
      }
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS item_revisions (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        recipe_payload_json TEXT CHECK(recipe_payload_json IS NULL OR json_valid(recipe_payload_json)),
        change_note TEXT,
        author_kind TEXT NOT NULL,
        author_label TEXT NOT NULL,
        idempotency_key TEXT,
        idempotency_fingerprint TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(item_id, revision)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS item_revisions_idempotency_idx
        ON item_revisions(idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS item_provenance (
        revision_id TEXT PRIMARY KEY REFERENCES item_revisions(id) ON DELETE CASCADE,
        source_client TEXT NOT NULL,
        source_client_version TEXT,
        agent_name TEXT,
        model TEXT,
        session_id TEXT,
        cwd TEXT,
        repo_root TEXT,
        repo_remote TEXT,
        branch TEXT,
        commit_sha TEXT,
        repo_dirty INTEGER,
        capture_method TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        verification_summary TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS revision_files (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES item_revisions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER
      );

      CREATE TABLE IF NOT EXISTS item_events (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        revision INTEGER,
        event_type TEXT NOT NULL,
        destination TEXT,
        representation_id TEXT,
        actor_kind TEXT NOT NULL,
        actor_label TEXT NOT NULL,
        client_event_id TEXT UNIQUE,
        idempotency_fingerprint TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_secret_findings (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES item_revisions(id) ON DELETE CASCADE,
        scanner_version INTEGER NOT NULL,
        rule_id TEXT NOT NULL,
        label TEXT NOT NULL,
        severity TEXT NOT NULL,
        action TEXT NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        line_number INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        redacted_preview TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        acknowledged_at TEXT,
        acknowledged_by TEXT,
        UNIQUE(revision_id, rule_id, start_offset, end_offset)
      );

      CREATE TABLE IF NOT EXISTS project_policies (
        project TEXT PRIMARY KEY COLLATE NOCASE,
        default_recipe_id TEXT NOT NULL DEFAULT 'generic_note',
        default_destination TEXT NOT NULL DEFAULT 'markdown',
        default_destination_explicit INTEGER NOT NULL DEFAULT 0,
        allowed_destinations_json TEXT NOT NULL DEFAULT '["plain","markdown","slack","email","github"]'
          CHECK(json_valid(allowed_destinations_json)),
        secret_mode TEXT NOT NULL DEFAULT 'block_high',
        require_secret_ack INTEGER NOT NULL DEFAULT 1,
        require_review_before_copy INTEGER NOT NULL DEFAULT 0,
        copy_behavior TEXT NOT NULL DEFAULT 'mark_copied',
        retention_days INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_secret_patterns (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL COLLATE NOCASE,
        label TEXT NOT NULL,
        pattern_kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        severity TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS destination_representations (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        destination TEXT NOT NULL,
        transformer_version INTEGER NOT NULL,
        plain_text TEXT NOT NULL,
        markdown_text TEXT,
        html_text TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(item_id, revision, destination, transformer_version)
      );

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS items_updated_at_idx ON items(updated_at DESC);
      CREATE INDEX IF NOT EXISTS items_project_idx ON items(project);
      CREATE INDEX IF NOT EXISTS items_kind_idx ON items(kind);
      CREATE INDEX IF NOT EXISTS items_archived_at_idx ON items(archived_at);
      CREATE INDEX IF NOT EXISTS items_status_idx ON items(status);
      CREATE INDEX IF NOT EXISTS items_recipe_idx ON items(recipe_id);
      CREATE INDEX IF NOT EXISTS revisions_item_idx ON item_revisions(item_id, revision DESC);
      CREATE INDEX IF NOT EXISTS events_item_idx ON item_events(item_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS findings_revision_idx ON item_secret_findings(revision_id);
    `);

    const revisionColumns = new Set(
      this.database
        .prepare<[], { name: string }>("PRAGMA table_info(item_revisions)")
        .all()
        .map((column) => column.name)
    );
    if (!revisionColumns.has("idempotency_fingerprint")) {
      this.database.exec("ALTER TABLE item_revisions ADD COLUMN idempotency_fingerprint TEXT");
    }
    const eventColumns = new Set(
      this.database
        .prepare<[], { name: string }>("PRAGMA table_info(item_events)")
        .all()
        .map((column) => column.name)
    );
    if (!eventColumns.has("idempotency_fingerprint")) {
      this.database.exec("ALTER TABLE item_events ADD COLUMN idempotency_fingerprint TEXT");
    }

    const policyColumns = new Set(
      this.database
        .prepare<[], { name: string }>("PRAGMA table_info(project_policies)")
        .all()
        .map((column) => column.name)
    );
    if (!policyColumns.has("default_destination_explicit")) {
      this.database.exec(
        "ALTER TABLE project_policies ADD COLUMN default_destination_explicit INTEGER NOT NULL DEFAULT 0"
      );
      // A non-default value in a database created by an earlier v0.2 build could only
      // have come from an API or workspace-policy update, so preserve that intent.
      this.database.exec(
        "UPDATE project_policies SET default_destination_explicit = 1 WHERE default_destination != 'markdown'"
      );
    }

    const migrateRows = this.database.transaction(() => {
      const rows = this.database.prepare<[], ItemRow>("SELECT * FROM items").all();
      for (const row of rows) {
        const existing = this.database
          .prepare<[string], { count: number }>(
            "SELECT COUNT(*) AS count FROM item_revisions WHERE item_id = ?"
          )
          .get(row.id);
        if ((existing?.count ?? 0) > 0) {
          continue;
        }
        const recipeId = recipeForLegacyKind(row.kind);
        const status: ItemStatus = row.archived_at === null ? "new" : "done";
        this.database
          .prepare(
            `UPDATE items SET recipe_id = ?, recipe_payload_json = ?, status = ?,
              current_revision = 1, status_before_done = ?, done_at = ? WHERE id = ?`
          )
          .run(
            recipeId,
            JSON.stringify({ contentMarkdown: row.content_markdown }),
            status,
            status === "done" ? "new" : null,
            row.archived_at,
            row.id
          );
        const revisionId = this.internalIdGenerator();
        this.database
          .prepare(
            `INSERT INTO item_revisions (
              id, item_id, revision, title, content_markdown, recipe_id,
              recipe_payload_json, change_note, author_kind, author_label,
              idempotency_key, created_at
            ) VALUES (?, ?, 1, ?, ?, ?, ?, NULL, 'migration', ?, NULL, ?)`
          )
          .run(
            revisionId,
            row.id,
            row.title,
            row.content_markdown,
            recipeId,
            JSON.stringify({ contentMarkdown: row.content_markdown }),
            row.source_client,
            row.updated_at
          );
        this.insertProvenance(
          revisionId,
          row.source_client,
          undefined,
          "legacy",
          row.updated_at
        );
        this.insertEvent(row.id, 1, "created", null, "migration", "v0.2 migration", row.created_at);
        if (status === "done") {
          this.insertEvent(
            row.id,
            1,
            "completed",
            null,
            "migration",
            "v0.2 migration",
            row.archived_at ?? row.updated_at
          );
        }
      }
      const now = this.now().toISOString();
      this.database
        .prepare(
          "INSERT OR IGNORE INTO schema_migrations (version, applied_at, checksum) VALUES (2, ?, ?)"
        )
        .run(now, "additive-v2-artifact-schema");
      this.database.pragma("user_version = 2");
    });
    migrateRows();
  }

  create(input: CreateItemInput): OutputItem {
    this.assertOpen();
    const idempotencyFingerprint = input.idempotencyKey === undefined
      ? undefined
      : requestFingerprint("output.create", { ...input, idempotencyKey: undefined });
    if (input.idempotencyKey !== undefined) {
      const existing = this.database
        .prepare<[string], { item_id: string; revision: number; idempotency_fingerprint: string | null }>(
          `SELECT item_id, revision, idempotency_fingerprint
           FROM item_revisions WHERE idempotency_key = ?`
        )
        .get(input.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.revision !== 1 ||
          existing.idempotency_fingerprint !== idempotencyFingerprint
        ) {
          throw new IdempotencyConflictError();
        }
        const item = this.get(existing.item_id);
        if (item !== undefined) {
          return item;
        }
      }
    }

    const id = this.idGenerator();
    const revisionId = this.internalIdGenerator();
    const now = this.now().toISOString();
    const kind = input.kind ?? "note";
    const recipeId = input.recipeId ?? recipeForLegacyKind(kind);
    const resolvedKind = input.recipeId === undefined ? kind : kindForRecipe(recipeId);
    const project = input.project ?? "General";
    const sourceClient = input.sourceClient ?? input.provenance?.sourceClient ?? "manual";
    const recipePayload =
      input.recipePayload ??
      (recipeId.startsWith("generic_") ? { contentMarkdown: input.contentMarkdown } : null);
    const policy = this.getProjectPolicy(project);
    const findings = this.scanForProject(project, `${input.title}\n${input.contentMarkdown}`, policy);
    const blocked = findings.filter((finding) => finding.action === "block");
    if (blocked.length > 0) {
      throw new SecretBlockedError(blocked);
    }

    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO items (
            id, title, content_markdown, kind, project, tags_json, source_client,
            created_at, updated_at, archived_at, recipe_id, recipe_payload_json,
            status, current_revision, status_before_done, reviewed_at, copied_at,
            done_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'new', 1, NULL, NULL, NULL, NULL, NULL)`
        )
        .run(
          id,
          input.title,
          input.contentMarkdown,
          resolvedKind,
          project,
          JSON.stringify(input.tags ?? []),
          sourceClient,
          now,
          now,
          recipeId,
          recipePayload === null ? null : JSON.stringify(recipePayload)
        );
      this.insertRevision(
        revisionId,
        id,
        1,
        input.title,
        input.contentMarkdown,
        recipeId,
        recipePayload,
        null,
        sourceClient === "manual" ? "human" : "agent",
        sourceClient,
        input.idempotencyKey,
        idempotencyFingerprint,
        now
      );
      this.insertProvenance(
        revisionId,
        sourceClient,
        input.provenance,
        sourceClient === "manual" ? "manual" : "client_supplied",
        now
      );
      this.insertFindings(revisionId, findings);
      this.insertEvent(
        id,
        1,
        "created",
        null,
        sourceClient === "manual" ? "human" : "agent",
        sourceClient,
        now
      );
    });
    transaction();
    return this.require(id);
  }

  get(id: string): OutputItem | undefined {
    this.assertOpen();
    this.purgeExpired();
    const row = this.database.prepare<[string], ItemRow>("SELECT * FROM items WHERE id = ?").get(id);
    return row === undefined ? undefined : this.hydrateItem(row);
  }

  private require(id: string): OutputItem {
    const item = this.get(id);
    if (item === undefined) {
      throw new ItemNotFoundError(id);
    }
    return item;
  }

  list(query: ItemQuery): ItemsResponse {
    this.assertOpen();
    this.purgeExpired();
    const where = buildWhere(query);
    const requestedLimit = query.limit;
    const parameters = [...where.parameters];
    if (requestedLimit !== undefined) parameters.push(requestedLimit + 1);
    const rows = this.database
      .prepare<SqlParameter[], ItemRow>(
        `SELECT * FROM items ${where.sql} ORDER BY updated_at DESC, created_at DESC, id DESC` +
          (requestedLimit === undefined ? "" : " LIMIT ?")
      )
      .all(...parameters);
    const hasMore = requestedLimit !== undefined && rows.length > requestedLimit;
    const pageRows = hasMore ? rows.slice(0, requestedLimit) : rows;
    const items = pageRows.map((row) => this.hydrateItem(row));

    const facetWhere = buildWhere({ archived: query.archived });
    const facetRows =
      query.q === undefined &&
      query.project === undefined &&
      query.kind === undefined &&
      query.tag === undefined &&
      query.status === undefined &&
      query.recipe === undefined &&
      query.limit === undefined &&
      query.cursor === undefined
        ? pageRows
        : this.database
            .prepare<SqlParameter[], ItemRow>(
              `SELECT * FROM items ${facetWhere.sql} ORDER BY updated_at DESC`
            )
            .all(...facetWhere.parameters);
    const lastRow = pageRows.at(-1);
    return {
      items,
      facets: buildFacets(facetRows.map((row) => this.hydrateItem(row))),
      ...(hasMore && lastRow
        ? {
            nextCursor: encodeItemCursor({
              updatedAt: lastRow.updated_at,
              createdAt: lastRow.created_at,
              id: lastRow.id
            })
          }
        : {})
    };
  }

  facets(query: ItemQuery): ItemFacets {
    return this.list(query).facets;
  }

  update(id: string, input: UpdateItemInput): OutputItem {
    this.assertOpen();
    return this.database.transaction(() => {
      let current = this.require(id);
      const changesContent =
        input.title !== undefined ||
        input.contentMarkdown !== undefined ||
        input.recipeId !== undefined ||
        input.recipePayload !== undefined;

      if (changesContent) {
        current = this.createRevision(id, {
          title: input.title,
          contentMarkdown: input.contentMarkdown ?? current.contentMarkdown,
          changeNote: input.changeNote,
          baseRevision: input.baseRevision ?? current.currentRevision,
          sourceClient: input.sourceClient ?? "manual",
          provenance: input.provenance,
          recipeId: input.recipeId ?? current.recipeId,
          recipePayload: input.recipePayload,
          authorKind:
            input.sourceClient !== undefined && input.sourceClient !== "manual" ? "agent" : "human"
        });
      }

      const metadataChanged =
        input.project !== undefined ||
        input.tags !== undefined ||
        input.kind !== undefined ||
        (input.sourceClient !== undefined && !changesContent);
      if (metadataChanged) {
        const project = input.project ?? current.project;
        const policy = this.getProjectPolicy(project);
        const findings = this.scanForProject(
          project,
          `${current.title}\n${current.contentMarkdown}`,
          policy
        );
        const blocked = findings.filter((finding) => finding.action === "block");
        if (blocked.length > 0) {
          throw new SecretBlockedError(blocked);
        }
        const now = this.now().toISOString();
        this.database
          .prepare(
            `UPDATE items SET project = ?, tags_json = ?, kind = ?, source_client = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            project,
            JSON.stringify(input.tags ?? current.tags),
            input.kind ?? current.kind,
            input.sourceClient ?? current.sourceClient,
            now,
            id
          );
        this.insertEvent(
          id,
          current.currentRevision,
          "metadata_updated",
          null,
          "human",
          "manual",
          now
        );
        current = this.require(id);
      }

      if (input.archived !== undefined) {
        if (input.archived) {
          current = this.transition(id, "done", "human", "manual");
        } else {
          const row = this.database
            .prepare<[string], { status_before_done: ItemStatus | null }>(
              "SELECT status_before_done FROM items WHERE id = ?"
            )
            .get(id);
          current = this.transition(id, row?.status_before_done ?? "new", "human", "manual");
        }
      } else if (input.status !== undefined) {
        current = this.transition(id, input.status, "human", "manual");
      }
      return current;
    })();
  }

  createRevision(id: string, input: CreateRevisionInput): OutputItem {
    this.assertOpen();
    const current = this.require(id);
    const idempotencyFingerprint = input.idempotencyKey === undefined
      ? undefined
      : requestFingerprint(`output.revision:${id}`, { ...input, idempotencyKey: undefined });
    if (input.idempotencyKey !== undefined) {
      const existing = this.database
        .prepare<[string], { item_id: string; revision: number; idempotency_fingerprint: string | null }>(
          `SELECT item_id, revision, idempotency_fingerprint
           FROM item_revisions WHERE idempotency_key = ?`
        )
        .get(input.idempotencyKey);
      if (existing !== undefined) {
        if (
          existing.item_id !== id ||
          existing.revision === 1 ||
          existing.idempotency_fingerprint !== idempotencyFingerprint
        ) {
          throw new IdempotencyConflictError();
        }
        return this.require(existing.item_id);
      }
    }
    if (input.baseRevision !== current.currentRevision) {
      throw new StaleRevisionError(current.currentRevision);
    }

    const now = this.now().toISOString();
    const revision = current.currentRevision + 1;
    const revisionId = this.internalIdGenerator();
    const title = input.title ?? current.title;
    const recipeId = input.recipeId ?? current.recipeId;
    const payload =
      input.recipePayload === undefined
        ? recipeId.startsWith("generic_")
          ? { contentMarkdown: input.contentMarkdown }
          : null
        : input.recipePayload;
    const sourceClient = input.sourceClient ?? input.provenance?.sourceClient ?? "manual";
    const authorKind = input.authorKind ?? (sourceClient === "manual" ? "human" : "agent");
    const policy = this.getProjectPolicy(current.project);
    const findings = this.scanForProject(
      current.project,
      `${title}\n${input.contentMarkdown}`,
      policy
    );
    const blocked = findings.filter((finding) => finding.action === "block");
    if (blocked.length > 0) {
      throw new SecretBlockedError(blocked);
    }

    const transaction = this.database.transaction(() => {
      this.insertRevision(
        revisionId,
        id,
        revision,
        title,
        input.contentMarkdown,
        recipeId,
        payload,
        input.changeNote ?? null,
        authorKind,
        sourceClient,
        input.idempotencyKey,
        idempotencyFingerprint,
        now
      );
      this.insertProvenance(
        revisionId,
        sourceClient,
        input.provenance,
        authorKind === "human" ? "manual" : "client_supplied",
        now
      );
      this.insertFindings(revisionId, findings);
      this.database
        .prepare(
          `UPDATE items SET title = ?, content_markdown = ?, recipe_id = ?,
             recipe_payload_json = ?, kind = ?, source_client = ?, current_revision = ?,
             status = 'new', status_before_done = NULL, reviewed_at = NULL,
             copied_at = NULL, done_at = NULL, archived_at = NULL, expires_at = NULL,
             updated_at = ? WHERE id = ?`
        )
        .run(
          title,
          input.contentMarkdown,
          recipeId,
          payload === null ? null : JSON.stringify(payload),
          kindForRecipe(recipeId),
          sourceClient,
          revision,
          now,
          id
        );
      this.insertEvent(
        id,
        revision,
        "revised",
        null,
        authorKind,
        sourceClient,
        now,
        { changeNote: input.changeNote ?? null }
      );
    });
    transaction();
    return this.require(id);
  }

  listRevisions(id: string): ItemRevision[] {
    this.require(id);
    const rows = this.database
      .prepare<[string], RevisionRow>(
        "SELECT * FROM item_revisions WHERE item_id = ? ORDER BY revision DESC"
      )
      .all(id);
    return rows.map((row) => this.hydrateRevision(row));
  }

  transition(
    id: string,
    status: ItemStatus,
    actorKind: "agent" | "human" | "system" = "human",
    actorLabel = "manual"
  ): OutputItem {
    return this.database.transaction(() => {
      const current = this.require(id);
      if (current.status === status) {
        return current;
      }
      const now = this.now().toISOString();
      const policy = this.getProjectPolicy(current.project);
      const reviewedAt = status === "reviewed" ? now : current.reviewedAt;
      const copiedAt = status === "copied" ? now : current.copiedAt;
      const doneAt = status === "done" ? now : null;
      const archivedAt = status === "done" ? now : null;
      const statusBeforeDone = status === "done" ? current.status : null;
      const expiresAt = status === "done" ? addDays(now, policy.retentionDays) : null;
      this.database
        .prepare(
          `UPDATE items SET status = ?, status_before_done = ?, reviewed_at = ?, copied_at = ?,
            done_at = ?, archived_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(
          status,
          statusBeforeDone,
          reviewedAt,
          copiedAt,
          doneAt,
          archivedAt,
          expiresAt,
          now,
          id
        );
      const eventType =
        status === "reviewed"
          ? "reviewed"
          : status === "copied"
            ? "copied"
            : status === "done"
              ? "completed"
              : "reopened";
      this.insertEvent(
        id,
        current.currentRevision,
        eventType,
        null,
        actorKind,
        actorLabel,
        now
      );
      return this.require(id);
    })();
  }

  getRepresentation(id: string, destination: Destination): DestinationRepresentation {
    const item = this.require(id);
    const policy = this.getProjectPolicy(item.project);
    const recipe = getRecipe(item.recipeId);
    if (!policy.allowedDestinations.includes(destination) || !recipe.destinations.includes(destination)) {
      throw new CopyBlockedError([`${destination} is not allowed for this project and recipe.`]);
    }

    const currentFindings = this.scanForProject(
      item.project,
      `${item.title}\n${item.contentMarkdown}`,
      policy
    );
    const reasons: string[] = currentFindings
      .filter((finding) => finding.action === "block")
      .map((finding) => finding.redactedPreview);
    if (
      policy.requireSecretAck &&
      item.secretFindings.some((finding) => finding.status === "open")
    ) {
      reasons.push("Secret warnings must be acknowledged before copying.");
    }
    if (policy.requireReviewBeforeCopy && item.status === "new") {
      reasons.push("This project requires review before copying.");
    }

    let row = this.database
      .prepare<[string, number, Destination, number], RepresentationRow>(
        `SELECT * FROM destination_representations
         WHERE item_id = ? AND revision = ? AND destination = ? AND transformer_version = ?`
      )
      .get(id, item.currentRevision, destination, TRANSFORMER_VERSION);
    if (row === undefined) {
      const content = buildRepresentation(destination, item.contentMarkdown, item.recipePayload);
      const representationId = this.internalIdGenerator();
      const now = this.now().toISOString();
      this.database
        .prepare(
          `INSERT INTO destination_representations (
            id, item_id, revision, destination, transformer_version, plain_text,
            markdown_text, html_text, metadata_json, warnings_json, checksum, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          representationId,
          id,
          item.currentRevision,
          destination,
          TRANSFORMER_VERSION,
          content.plainText,
          content.markdownText,
          content.htmlText,
          JSON.stringify(content.metadata),
          JSON.stringify(content.warnings),
          contentChecksum(
            `${content.plainText}\0${content.markdownText ?? ""}\0${content.htmlText ?? ""}`
          ),
          now
        );
      row = this.database
        .prepare<[string], RepresentationRow>(
          "SELECT * FROM destination_representations WHERE id = ?"
        )
        .get(representationId);
    }
    if (row === undefined) {
      throw new Error("Representation could not be generated");
    }
    return this.hydrateRepresentation(row, reasons);
  }

  recordCopy(
    id: string,
    input: {
      representationId: string;
      destination?: Destination;
      format?: string;
      clientEventId?: string;
      actorLabel?: string;
    }
  ): OutputItem {
    const item = this.require(id);
    const idempotencyFingerprint = input.clientEventId === undefined
      ? undefined
      : requestFingerprint(`output.copy:${id}`, {
          representationId: input.representationId,
          destination: input.destination ?? null,
          format: input.format ?? null,
          actorLabel: input.actorLabel ?? null
        });
    if (input.clientEventId !== undefined) {
      const prior = this.database
        .prepare<[string], { item_id: string; idempotency_fingerprint: string | null }>(
          `SELECT item_id, idempotency_fingerprint
           FROM item_events WHERE client_event_id = ?`
        )
        .get(input.clientEventId);
      if (prior !== undefined) {
        if (
          prior.item_id !== id ||
          prior.idempotency_fingerprint !== idempotencyFingerprint
        ) {
          throw new IdempotencyConflictError();
        }
        return this.require(prior.item_id);
      }
    }
    const row = this.database
      .prepare<[string, string], RepresentationRow>(
        "SELECT * FROM destination_representations WHERE id = ? AND item_id = ?"
      )
      .get(input.representationId, id);
    if (row === undefined || row.revision !== item.currentRevision) {
      throw new CopyBlockedError(["The prepared representation is stale or missing."]);
    }
    if (input.destination !== undefined && input.destination !== row.destination) {
      throw new CopyBlockedError(["The copy destination does not match the prepared representation."]);
    }
    const prepared = this.getRepresentation(id, row.destination);
    if (!prepared.copyAllowed) {
      throw new CopyBlockedError(prepared.blockReasons);
    }
    const policy = this.getProjectPolicy(item.project);
    const now = this.now().toISOString();
    const actorLabel = input.actorLabel ?? "web-ui";
    const nextStatus: ItemStatus =
      policy.copyBehavior === "mark_done"
        ? "done"
        : policy.copyBehavior === "mark_copied" && item.status !== "done"
          ? "copied"
          : item.status;
    const statusBeforeDone = nextStatus === "done" ? item.status : null;
    const doneAt = nextStatus === "done" ? now : item.doneAt;
    const archivedAt = nextStatus === "done" ? now : item.archivedAt;
    const expiresAt = nextStatus === "done" ? addDays(now, policy.retentionDays) : null;
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE items SET status = ?, status_before_done = ?, copied_at = ?, done_at = ?,
            archived_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(nextStatus, statusBeforeDone, now, doneAt, archivedAt, expiresAt, now, id);
      this.insertEvent(
        id,
        item.currentRevision,
        "copied",
        row.destination,
        "human",
        actorLabel,
        now,
        { format: input.format ?? "plain", representationId: row.id },
        row.id,
        input.clientEventId,
        idempotencyFingerprint
      );
    });
    transaction();
    return this.require(id);
  }

  acknowledgeFinding(id: string, findingId: string, actor = "local-user"): OutputItem {
    return this.database.transaction(() => {
      const item = this.require(id);
      const revision = this.database
        .prepare<[string, string], { revision: number }>(
          `SELECT r.revision FROM item_secret_findings f
           JOIN item_revisions r ON r.id = f.revision_id
           WHERE f.id = ? AND r.item_id = ?`
        )
        .get(findingId, id);
      if (revision === undefined || revision.revision !== item.currentRevision) {
        throw new FindingNotFoundError(findingId);
      }
      const now = this.now().toISOString();
      this.database
        .prepare(
          `UPDATE item_secret_findings SET status = 'acknowledged', acknowledged_at = ?,
            acknowledged_by = ? WHERE id = ?`
        )
        .run(now, actor, findingId);
      this.insertEvent(
        id,
        item.currentRevision,
        "secret_acknowledged",
        null,
        "human",
        actor,
        now,
        { findingId }
      );
      return this.require(id);
    })();
  }

  getFindings(id: string): SecretFinding[] {
    return this.require(id).secretFindings;
  }

  getProjectPolicy(project: string): ProjectPolicy {
    this.assertOpen();
    let row = this.database
      .prepare<[string], PolicyRow>("SELECT * FROM project_policies WHERE project = ? COLLATE NOCASE")
      .get(project);
    if (row === undefined) {
      const now = this.now().toISOString();
      this.database
        .prepare(
          `INSERT INTO project_policies (
            project, default_recipe_id, default_destination, default_destination_explicit,
            allowed_destinations_json,
            secret_mode, require_secret_ack, require_review_before_copy, copy_behavior,
            retention_days, updated_at
          ) VALUES (?, 'generic_note', 'markdown', 0, ?, 'block_high', 1, 0, 'mark_copied', NULL, ?)`
        )
        .run(project, JSON.stringify(DESTINATIONS), now);
      row = this.database
        .prepare<[string], PolicyRow>("SELECT * FROM project_policies WHERE project = ? COLLATE NOCASE")
        .get(project);
    }
    if (row === undefined) {
      throw new Error("Project policy could not be initialized");
    }
    return this.hydratePolicy(row);
  }

  updateProjectPolicy(
    project: string,
    patch: Partial<Omit<ProjectPolicy, "project" | "updatedAt">>
  ): ProjectPolicy {
    const current = this.getProjectPolicy(project);
    const next = { ...current, ...patch, project, updatedAt: this.now().toISOString() };
    const currentExplicit =
      this.database
        .prepare<[string], { default_destination_explicit: number }>(
          "SELECT default_destination_explicit FROM project_policies WHERE project = ? COLLATE NOCASE"
        )
        .get(project)?.default_destination_explicit === 1;
    const nextExplicit = patch.defaultDestination === undefined ? currentExplicit : true;
    this.database
      .prepare(
        `UPDATE project_policies SET default_recipe_id = ?, default_destination = ?,
          default_destination_explicit = ?, allowed_destinations_json = ?, secret_mode = ?, require_secret_ack = ?,
          require_review_before_copy = ?, copy_behavior = ?, retention_days = ?, updated_at = ?
         WHERE project = ? COLLATE NOCASE`
      )
      .run(
        next.defaultRecipeId,
        next.defaultDestination,
        nextExplicit ? 1 : 0,
        JSON.stringify(next.allowedDestinations),
        next.secretMode,
        next.requireSecretAck ? 1 : 0,
        next.requireReviewBeforeCopy ? 1 : 0,
        next.copyBehavior,
        next.retentionDays,
        next.updatedAt,
        project
      );
    return this.getProjectPolicy(project);
  }

  listProjects(): Array<{ project: string; count: number; policy: ProjectPolicy }> {
    const rows = this.database
      .prepare<[], { project: string; count: number }>(
        "SELECT project, COUNT(*) AS count FROM items GROUP BY project COLLATE NOCASE ORDER BY project COLLATE NOCASE"
      )
      .all();
    return rows.map((row) => ({ ...row, policy: this.getProjectPolicy(row.project) }));
  }

  addSecretPattern(
    project: string,
    input: {
      label: string;
      patternKind: "literal" | "glob";
      pattern: string;
      severity: SecretSeverity;
    }
  ): SecretPattern {
    this.getProjectPolicy(project);
    return this.database.transaction(() => {
      const count = this.database
        .prepare<[string], { count: number }>(
          "SELECT COUNT(*) AS count FROM project_secret_patterns WHERE project = ? COLLATE NOCASE"
        )
        .get(project)?.count ?? 0;
      if (count >= MAX_CUSTOM_SECRET_PATTERNS) {
        throw new SecretPatternLimitError(MAX_CUSTOM_SECRET_PATTERNS);
      }
      const id = this.internalIdGenerator();
      this.database.prepare(
        `INSERT INTO project_secret_patterns (
          id, project, label, pattern_kind, pattern, severity, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(
        id,
        project,
        input.label,
        input.patternKind,
        input.pattern,
        input.severity,
        this.now().toISOString()
      );
      return { id, ...input };
    })();
  }

  listSecretPatterns(project: string): SecretPattern[] {
    return this.database
      .prepare<[string], PatternRow>(
        `SELECT id, label, pattern_kind, pattern, severity
         FROM project_secret_patterns
         WHERE project = ? COLLATE NOCASE AND enabled = 1
         ORDER BY created_at LIMIT ${MAX_CUSTOM_SECRET_PATTERNS}`
      )
      .all(project)
      .map((row) => ({
        id: row.id,
        label: row.label,
        patternKind: row.pattern_kind,
        pattern: row.pattern,
        severity: row.severity
      }));
  }

  deleteSecretPattern(project: string, patternId: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM project_secret_patterns WHERE id = ? AND project = ? COLLATE NOCASE")
        .run(patternId, project).changes > 0
    );
  }

  checkHealth(): boolean {
    this.assertOpen();
    const result = this.database.prepare<[], { ok: number }>("SELECT 1 AS ok").get();
    return result?.ok === 1;
  }

  purgeExpired(at: Date = this.now()): number {
    this.assertOpen();
    const result = this.database
      .prepare(
        "DELETE FROM items WHERE status = 'done' AND expires_at IS NOT NULL AND expires_at <= ?"
      )
      .run(at.toISOString());
    return result.changes;
  }

  delete(id: string): boolean {
    this.assertOpen();
    return this.database.prepare("DELETE FROM items WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }

  private hydrateItem(row: ItemRow): OutputItem {
    const revision = this.database
      .prepare<[string, number], RevisionRow>(
        "SELECT * FROM item_revisions WHERE item_id = ? AND revision = ?"
      )
      .get(row.id, row.current_revision);
    const revisionCount = this.database
      .prepare<[string], { count: number }>(
        "SELECT COUNT(*) AS count FROM item_revisions WHERE item_id = ?"
      )
      .get(row.id)?.count ?? 0;
    const humanEdited =
      (this.database
        .prepare<[string], { count: number }>(
          "SELECT COUNT(*) AS count FROM item_revisions WHERE item_id = ? AND author_kind = 'human'"
        )
        .get(row.id)?.count ?? 0) > 0;
    const provenance = revision === undefined ? null : this.getProvenance(revision.id);
    const findings =
      revision === undefined
        ? []
        : this.database
            .prepare<[string], FindingRow>(
              "SELECT * FROM item_secret_findings WHERE revision_id = ? ORDER BY line_number, rule_id"
            )
            .all(revision.id)
            .map((finding) => this.hydrateFinding(finding));
    const policy = this.getProjectPolicy(row.project);
    const recipe = getRecipe(row.recipe_id);
    const destinations = recipe.destinations.filter((destination) =>
      policy.allowedDestinations.includes(destination)
    );
    const destinationWasExplicit =
      this.database
        .prepare<[string], { default_destination_explicit: number }>(
          "SELECT default_destination_explicit FROM project_policies WHERE project = ? COLLATE NOCASE"
        )
        .get(row.project)?.default_destination_explicit === 1;
    const defaultDestination =
      destinationWasExplicit && destinations.includes(policy.defaultDestination)
      ? policy.defaultDestination
      : destinations.includes(recipe.defaultDestination)
        ? recipe.defaultDestination
        : (destinations[0] ?? recipe.defaultDestination);
    return {
      id: row.id,
      title: row.title,
      contentMarkdown: row.content_markdown,
      kind: row.kind,
      project: row.project,
      tags: parseTags(row.tags_json),
      sourceClient: row.source_client,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.status === "done" ? row.done_at ?? row.archived_at : null,
      recipeId: row.recipe_id,
      recipePayload: parseJson<Record<string, unknown> | null>(row.recipe_payload_json, null),
      status: row.status,
      currentRevision: row.current_revision,
      revisionCount,
      reviewedAt: row.reviewed_at,
      copiedAt: row.copied_at,
      doneAt: row.done_at,
      expiresAt: row.expires_at,
      provenance,
      secretFindings: findings,
      availableDestinations: destinations,
      defaultDestination,
      humanEdited
    };
  }

  private hydrateRevision(row: RevisionRow): ItemRevision {
    return {
      id: row.id,
      itemId: row.item_id,
      revision: row.revision,
      title: row.title,
      contentMarkdown: row.content_markdown,
      recipeId: row.recipe_id,
      recipePayload: parseJson<Record<string, unknown> | null>(row.recipe_payload_json, null),
      changeNote: row.change_note,
      authorKind: row.author_kind,
      authorLabel: row.author_label,
      provenance: this.getProvenance(row.id),
      createdAt: row.created_at
    };
  }

  private getProvenance(revisionId: string): ItemProvenance | null {
    const row = this.database
      .prepare<[string], ProvenanceRow>("SELECT * FROM item_provenance WHERE revision_id = ?")
      .get(revisionId);
    if (row === undefined) {
      return null;
    }
    const files = this.database
      .prepare<[string], ReferencedFileRow>(
        "SELECT path, line_start, line_end FROM revision_files WHERE revision_id = ? ORDER BY path"
      )
      .all(revisionId)
      .map((file) => ({
        path: file.path,
        ...(file.line_start === null ? {} : { lineStart: file.line_start }),
        ...(file.line_end === null ? {} : { lineEnd: file.line_end })
      }));
    return {
      sourceClient: row.source_client,
      ...(row.source_client_version === null ? {} : { sourceClientVersion: row.source_client_version }),
      ...(row.agent_name === null ? {} : { agentName: row.agent_name }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.cwd === null ? {} : { cwd: row.cwd }),
      ...(row.repo_root === null ? {} : { repoRoot: row.repo_root }),
      ...(row.repo_remote === null ? {} : { repoRemote: row.repo_remote }),
      ...(row.branch === null ? {} : { branch: row.branch }),
      ...(row.commit_sha === null ? {} : { commitSha: row.commit_sha }),
      ...(row.repo_dirty === null ? {} : { repoDirty: row.repo_dirty === 1 }),
      captureMethod: row.capture_method,
      verificationStatus: row.verification_status,
      ...(row.verification_summary === null
        ? {}
        : { verificationSummary: row.verification_summary }),
      referencedFiles: files,
      capturedAt: row.captured_at
    };
  }

  private hydrateFinding(row: FindingRow): SecretFinding {
    return {
      id: row.id,
      ruleId: row.rule_id,
      label: row.label,
      severity: row.severity,
      action: row.action,
      lineNumber: row.line_number,
      redactedPreview: row.redacted_preview,
      status: row.status,
      acknowledgedAt: row.acknowledged_at,
      acknowledgedBy: row.acknowledged_by
    };
  }

  private hydratePolicy(row: PolicyRow): ProjectPolicy {
    const allowed = parseJson<unknown>(row.allowed_destinations_json, DESTINATIONS);
    return {
      project: row.project,
      defaultRecipeId: row.default_recipe_id,
      defaultDestination: row.default_destination,
      allowedDestinations: Array.isArray(allowed)
        ? allowed.filter((value): value is Destination =>
            DESTINATIONS.includes(value as Destination)
          )
        : [...DESTINATIONS],
      secretMode: row.secret_mode,
      requireSecretAck: row.require_secret_ack === 1,
      requireReviewBeforeCopy: row.require_review_before_copy === 1,
      copyBehavior: row.copy_behavior,
      retentionDays: row.retention_days,
      updatedAt: row.updated_at
    };
  }

  private hydrateRepresentation(
    row: RepresentationRow,
    blockReasons: string[]
  ): DestinationRepresentation {
    return {
      id: row.id,
      itemId: row.item_id,
      revision: row.revision,
      destination: row.destination,
      plainText: row.plain_text,
      markdownText: row.markdown_text,
      htmlText: row.html_text,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
      warnings: parseJson<string[]>(row.warnings_json, []),
      createdAt: row.created_at,
      copyAllowed: blockReasons.length === 0,
      blockReasons
    };
  }

  private insertRevision(
    revisionId: string,
    itemId: string,
    revision: number,
    title: string,
    contentMarkdown: string,
    recipeId: RecipeId,
    recipePayload: Record<string, unknown> | null,
    changeNote: string | null,
    authorKind: ItemRevision["authorKind"],
    authorLabel: string,
    idempotencyKey: string | undefined,
    idempotencyFingerprint: string | undefined,
    createdAt: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO item_revisions (
          id, item_id, revision, title, content_markdown, recipe_id,
          recipe_payload_json, change_note, author_kind, author_label,
          idempotency_key, idempotency_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revisionId,
        itemId,
        revision,
        title,
        contentMarkdown,
        recipeId,
        recipePayload === null ? null : JSON.stringify(recipePayload),
        changeNote,
        authorKind,
        authorLabel,
        idempotencyKey ?? null,
        idempotencyFingerprint ?? null,
        createdAt
      );
  }

  private insertProvenance(
    revisionId: string,
    sourceClient: string,
    provenance: ProvenanceInput | undefined,
    captureMethod: ItemProvenance["captureMethod"],
    capturedAt: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO item_provenance (
          revision_id, source_client, source_client_version, agent_name, model,
          session_id, cwd, repo_root, repo_remote, branch, commit_sha, repo_dirty,
          capture_method, verification_status, verification_summary, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        revisionId,
        provenance?.sourceClient ?? sourceClient,
        provenance?.sourceClientVersion ?? null,
        provenance?.agentName ?? null,
        provenance?.model ?? null,
        provenance?.sessionId ?? null,
        provenance?.cwd ?? null,
        provenance?.repoRoot ?? null,
        provenance?.repoRemote ?? null,
        provenance?.branch ?? null,
        provenance?.commitSha ?? null,
        provenance?.repoDirty === undefined ? null : provenance.repoDirty ? 1 : 0,
        captureMethod,
        provenance?.verificationStatus ?? "unverified",
        provenance?.verificationSummary ?? null,
        capturedAt
      );
    for (const file of provenance?.referencedFiles ?? []) {
      this.database
        .prepare(
          "INSERT INTO revision_files (id, revision_id, path, line_start, line_end) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          this.internalIdGenerator(),
          revisionId,
          file.path,
          file.lineStart ?? null,
          file.lineEnd ?? null
        );
    }
  }

  private insertFindings(revisionId: string, findings: ScannedSecretFinding[]): void {
    for (const finding of findings.filter((candidate) => candidate.action === "warn")) {
      this.database
        .prepare(
          `INSERT INTO item_secret_findings (
            id, revision_id, scanner_version, rule_id, label, severity, action,
            start_offset, end_offset, line_number, fingerprint, redacted_preview,
            status, acknowledged_at, acknowledged_by
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL)`
        )
        .run(
          this.internalIdGenerator(),
          revisionId,
          finding.ruleId,
          finding.label,
          finding.severity,
          finding.action,
          finding.startOffset,
          finding.endOffset,
          finding.lineNumber,
          finding.fingerprint,
          finding.redactedPreview
        );
    }
  }

  private insertEvent(
    itemId: string,
    revision: number | null,
    eventType: string,
    destination: Destination | null,
    actorKind: string,
    actorLabel: string,
    createdAt: string,
    metadata: Record<string, unknown> = {},
    representationId: string | null = null,
    clientEventId: string | undefined = undefined,
    idempotencyFingerprint: string | undefined = undefined
  ): void {
    this.database
      .prepare(
        `INSERT INTO item_events (
          id, item_id, revision, event_type, destination, representation_id,
          actor_kind, actor_label, client_event_id, idempotency_fingerprint,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.internalIdGenerator(),
        itemId,
        revision,
        eventType,
        destination,
        representationId,
        actorKind,
        actorLabel,
        clientEventId ?? null,
        idempotencyFingerprint ?? null,
        JSON.stringify(metadata),
        createdAt
      );
  }

  private scanForProject(
    project: string,
    content: string,
    policy: ProjectPolicy
  ): ScannedSecretFinding[] {
    return scanSecrets(content, policy.secretMode, this.listSecretPatterns(project));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Item store is closed");
    }
  }
}

export const storeInternals = {
  buildFacets,
  buildWhere,
  contentChecksum,
  escapeLike,
  parseJson,
  parseTags
};
