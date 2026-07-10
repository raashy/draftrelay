import { createHash, randomUUID } from "node:crypto";

import type { PoolClient, QueryResultRow } from "pg";

import type {
  CreateItemInput,
  CreateRevisionInput,
  Destination,
  DestinationRepresentation,
  FacetValue,
  ItemFacets,
  ItemProvenance,
  ItemQuery,
  ItemRevision,
  ItemStatus,
  ItemsResponse,
  OutputItem,
  ProjectPolicy,
  SecretFinding
} from "../shared/items.js";
import { getRecipe, kindForRecipe, recipeForLegacyKind } from "../server/recipes.js";
import { buildRepresentation, TRANSFORMER_VERSION } from "../server/representations.js";
import {
  MAX_CUSTOM_SECRET_PATTERNS,
  scanSecrets,
  type ScannedSecretFinding,
  type SecretPattern
} from "../server/security.js";
import {
  CopyBlockedError,
  FindingNotFoundError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "../server/errors.js";
import { requestFingerprint } from "../server/idempotency.js";
import { decodeItemCursor, encodeItemCursor } from "../server/pagination.js";
import type { CloudConfig, TierLimits } from "./config.js";
import type { CloudDatabase } from "./db.js";
import { withTransaction } from "./db.js";
import { runWorkspaceMaintenance } from "./maintenance.js";

export interface CloudActor {
  userId: string;
  name: string;
  kind: "human" | "agent";
  label: string;
  oauthClientId?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface CloudUsageSummary {
  plan: "free" | "pro";
  monthlySaves: { used: number; limit: number };
  dailySaves: { used: number; limit: number };
  storedItems: { used: number; limit: number };
  storageBytes: { used: number; limit: number };
  activeOAuthClients: { used: number; limit: number };
}

export interface CloudBillingSubscription {
  id: string;
  plan: string;
  status: string;
  billingInterval: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface OAuthConnectionSummary {
  consentId: string;
  clientId: string;
  name: string;
  uri: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}

export type CloudExportWriter = (chunk: string) => void | Promise<void>;

interface TenantContext {
  client: PoolClient;
  workspaceId: string;
  actor: CloudActor;
}

function isSecretPatternQuotaDatabaseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P0001" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("secret_pattern_quota_exceeded")
  );
}

interface ProjectRow extends QueryResultRow {
  id: string;
  name: string;
  default_recipe_id: ProjectPolicy["defaultRecipeId"];
  default_destination: Destination;
  default_destination_explicit: boolean;
  allowed_destinations: Destination[];
  secret_mode: ProjectPolicy["secretMode"];
  require_secret_ack: boolean;
  require_review_before_copy: boolean;
  copy_behavior: ProjectPolicy["copyBehavior"];
  retention_days: number | null;
  updated_at: Date;
}

interface ItemRow extends QueryResultRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  content_markdown: string;
  kind: OutputItem["kind"];
  tags: string[];
  source_client: string;
  recipe_id: OutputItem["recipeId"];
  recipe_payload: Record<string, unknown> | null;
  status: ItemStatus;
  current_revision: number;
  reviewed_at: Date | null;
  copied_at: Date | null;
  done_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  default_destination: Destination;
  default_destination_explicit: boolean;
  allowed_destinations: Destination[];
  current_author_kind: string;
  human_edited: boolean;
  provenance: ItemProvenance | null;
  findings: SecretFinding[];
}

interface RevisionRow extends QueryResultRow {
  id: string;
  item_id: string;
  revision: number;
  title: string;
  content_markdown: string;
  recipe_id: ItemRevision["recipeId"];
  recipe_payload: Record<string, unknown> | null;
  change_note: string | null;
  author_kind: ItemRevision["authorKind"];
  author_label: string;
  created_at: Date;
  provenance: ItemProvenance | null;
}

interface RepresentationRow extends QueryResultRow {
  id: string;
  item_id: string;
  revision: number;
  destination: Destination;
  plain_text: string;
  markdown_text: string | null;
  html_text: string | null;
  metadata: Record<string, unknown>;
  warnings: string[];
  created_at: Date;
}

interface FindingStateRow extends QueryResultRow {
  rule_id: string;
  start_offset: number;
  end_offset: number;
  status: SecretFinding["status"];
}

interface FacetCountRow extends QueryResultRow {
  facet: keyof ItemFacets;
  value: string;
  count: string;
}

export class QuotaExceededError extends Error {
  constructor(
    readonly metric: keyof TierLimits,
    readonly limit: number,
    readonly resetAt?: string
  ) {
    super(`The ${metric} limit of ${limit} has been reached`);
    this.name = "QuotaExceededError";
  }
}

export class WorkspaceSuspendedError extends Error {
  constructor() {
    super("This workspace is not active");
    this.name = "WorkspaceSuspendedError";
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function periodBounds(kind: "minute" | "day" | "month", now = new Date()): { start: Date; end: Date } {
  if (kind === "minute") {
    const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return { start, end: new Date(start.getTime() + 60_000) };
  }
  if (kind === "day") {
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  };
}

function facetValues(values: string[]): FacetValue[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) =>
    a.value.localeCompare(b.value, undefined, { sensitivity: "base" })
  );
}

function buildFacets(items: OutputItem[]): ItemFacets {
  return {
    projects: facetValues(items.map((item) => item.project)),
    kinds: facetValues(items.map((item) => item.kind)),
    tags: facetValues(items.flatMap((item) => item.tags)),
    statuses: facetValues(items.map((item) => item.status)),
    recipes: facetValues(items.map((item) => item.recipeId))
  };
}

function facetsFromCountRows(rows: FacetCountRow[]): ItemFacets {
  const facets: ItemFacets = { projects: [], kinds: [], tags: [], statuses: [], recipes: [] };
  for (const row of rows) {
    facets[row.facet].push({ value: row.value, count: Number(row.count) });
  }
  for (const values of Object.values(facets) as FacetValue[][]) {
    values.sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
  }
  return facets;
}

function contentChecksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function addDays(now: Date, days: number | null): Date | null {
  return days === null ? null : new Date(now.getTime() + days * 86_400_000);
}

function policyFromRow(row: ProjectRow): ProjectPolicy {
  return {
    project: row.name,
    defaultRecipeId: row.default_recipe_id,
    defaultDestination: row.default_destination,
    allowedDestinations: row.allowed_destinations,
    secretMode: row.secret_mode,
    requireSecretAck: row.require_secret_ack,
    requireReviewBeforeCopy: row.require_review_before_copy,
    copyBehavior: row.copy_behavior,
    retentionDays: row.retention_days,
    updatedAt: iso(row.updated_at)!
  };
}

const ITEM_SELECT = `
  SELECT i.*, p.name AS project_name, p.default_destination,
    p.default_destination_explicit, p.allowed_destinations,
    r.author_kind AS current_author_kind,
    EXISTS (
      SELECT 1 FROM output_revision edited
      WHERE edited.workspace_id = i.workspace_id
        AND edited.item_id = i.id AND edited.author_kind = 'human'
    ) AS human_edited,
    CASE WHEN provenance.revision_id IS NULL THEN NULL ELSE jsonb_build_object(
      'sourceClient', provenance.source_client,
      'sourceClientVersion', provenance.source_client_version,
      'agentName', provenance.agent_name,
      'model', provenance.model,
      'sessionId', provenance.session_id,
      'cwd', provenance.cwd,
      'repoRoot', provenance.repo_root,
      'repoRemote', provenance.repo_remote,
      'branch', provenance.branch,
      'commitSha', provenance.commit_sha,
      'repoDirty', provenance.repo_dirty,
      'captureMethod', provenance.capture_method,
      'verificationStatus', provenance.verification_status,
      'verificationSummary', provenance.verification_summary,
      'referencedFiles', COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'path', rf.path, 'lineStart', rf.line_start, 'lineEnd', rf.line_end
        )) ORDER BY rf.path)
        FROM referenced_file rf
        WHERE rf.workspace_id = i.workspace_id AND rf.revision_id = r.id
      ), '[]'::jsonb),
      'capturedAt', provenance.captured_at
    ) END AS provenance,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', sf.id,
        'ruleId', sf.rule_id,
        'label', sf.label,
        'severity', sf.severity,
        'action', sf.action,
        'lineNumber', sf.line_number,
        'redactedPreview', sf.redacted_preview,
        'status', sf.status,
        'acknowledgedAt', sf.acknowledged_at,
        'acknowledgedBy', sf.acknowledged_by_user_id
      ) ORDER BY sf.line_number, sf.rule_id)
      FROM secret_finding sf
      WHERE sf.workspace_id = i.workspace_id AND sf.revision_id = r.id
    ), '[]'::jsonb) AS findings
  FROM output_item i
  JOIN project p ON p.workspace_id = i.workspace_id AND p.id = i.project_id
  JOIN output_revision r ON r.workspace_id = i.workspace_id
    AND r.item_id = i.id AND r.revision = i.current_revision
  LEFT JOIN output_provenance provenance ON provenance.workspace_id = r.workspace_id
    AND provenance.revision_id = r.id
`;

export class CloudStore {
  constructor(
    private readonly database: CloudDatabase,
    private readonly config: CloudConfig
  ) {}

  private async inWorkspace<T>(
    actor: CloudActor,
    run: (context: TenantContext) => Promise<T>,
    options: { isolationLevel?: "REPEATABLE READ" } = {}
  ): Promise<T> {
    return withTransaction(this.database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [actor.userId]);
      await client.query("SELECT set_config('app.user_id', $1::uuid::text, true)", [actor.userId]);
      let membership = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_member
         WHERE user_id = $1::uuid
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at
         LIMIT 1`,
        [actor.userId]
      );
      let workspaceId = membership.rows[0]?.workspace_id;
      if (!workspaceId) {
        workspaceId = randomUUID();
        await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
        const safeName = `${actor.name.trim().slice(0, 95) || "Personal"}'s workspace`;
        await client.query(
          `INSERT INTO workspace (id, slug, name, created_by_user_id)
           VALUES ($1, $2, $3, $4::uuid)`,
          [workspaceId, `user-${actor.userId.toLowerCase()}`, safeName, actor.userId]
        );
        await client.query(
          `INSERT INTO workspace_member (workspace_id, user_id, role)
           VALUES ($1, $2::uuid, 'owner')`,
          [workspaceId, actor.userId]
        );
        membership = await client.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM workspace_member WHERE user_id = $1::uuid AND workspace_id = $2",
          [actor.userId, workspaceId]
        );
        if (!membership.rows[0]) throw new Error("Workspace membership could not be created");
      } else {
        await client.query("SELECT set_config('app.workspace_id', $1::uuid::text, true)", [workspaceId]);
      }

      const workspace = await client.query<{ status: string }>(
        "SELECT status FROM workspace WHERE id = $1",
        [workspaceId]
      );
      if (workspace.rows[0]?.status !== "active") throw new WorkspaceSuspendedError();
      await client.query(
        `DELETE FROM output_item
         WHERE workspace_id = $1 AND status = 'done'
           AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP`,
        [workspaceId]
      );
      await runWorkspaceMaintenance(client, workspaceId);
      return run({ client, workspaceId, actor });
    }, options);
  }

  private async plan(context: TenantContext): Promise<{ name: "free" | "pro"; limits: TierLimits }> {
    const result = await context.client.query<{ paid: boolean }>(
      `SELECT public.draftrelay_has_paid_entitlement($1::uuid, $2::uuid) AS paid`,
      [context.actor.userId, context.workspaceId]
    );
    const name = result.rows[0]?.paid ? "pro" : "free";
    return { name, limits: name === "pro" ? this.config.limits.paid : this.config.limits.free };
  }

  private async counterValue(
    context: TenantContext,
    metric: string,
    period: { start: Date; end: Date }
  ): Promise<number> {
    const result = await context.client.query<{ value: string }>(
      `SELECT value::text FROM usage_counter
       WHERE workspace_id = $1 AND metric = $2 AND period_start = $3`,
      [context.workspaceId, metric, period.start]
    );
    return Number(result.rows[0]?.value ?? 0);
  }

  private async consumeCounter(
    context: TenantContext,
    metric: string,
    period: { start: Date; end: Date },
    limit: number,
    quotaMetric: keyof TierLimits
  ): Promise<void> {
    const result = await context.client.query(
      `INSERT INTO usage_counter (workspace_id, metric, period_start, period_end, value)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (workspace_id, metric, period_start)
       DO UPDATE SET value = usage_counter.value + 1, period_end = EXCLUDED.period_end
       WHERE usage_counter.value < $5
       RETURNING value`,
      [context.workspaceId, metric, period.start, period.end, limit]
    );
    if (result.rowCount !== 1) {
      throw new QuotaExceededError(quotaMetric, limit, period.end.toISOString());
    }
  }

  private async consumeSaveQuota(context: TenantContext, addedBytes: number, newItem: boolean): Promise<void> {
    const { limits } = await this.plan(context);
    const totals = await context.client.query<{ item_count: string; storage_bytes: string }>(
      `SELECT
         (SELECT count(*)::text FROM output_item WHERE workspace_id = $1) AS item_count,
         (SELECT COALESCE(sum(content_bytes), 0)::text FROM output_revision WHERE workspace_id = $1) AS storage_bytes`,
      [context.workspaceId]
    );
    const row = totals.rows[0];
    const itemCount = Number(row?.item_count ?? 0);
    const storageBytes = Number(row?.storage_bytes ?? 0);
    if (newItem && itemCount >= limits.storedItems) {
      throw new QuotaExceededError("storedItems", limits.storedItems);
    }
    if (storageBytes + addedBytes > limits.storageBytes) {
      throw new QuotaExceededError("storageBytes", limits.storageBytes);
    }
    const daily = periodBounds("day");
    const monthly = periodBounds("month");
    await this.consumeCounter(context, "saves_day", daily, limits.dailySaves, "dailySaves");
    await this.consumeCounter(context, "saves_month", monthly, limits.monthlySaves, "monthlySaves");
  }

  private hydrate(row: ItemRow): OutputItem {
    const recipe = getRecipe(row.recipe_id);
    const availableDestinations = recipe.destinations.filter((destination) =>
      row.allowed_destinations.includes(destination)
    );
    const preferred = row.default_destination_explicit
      ? row.default_destination
      : recipe.defaultDestination;
    const defaultDestination = availableDestinations.includes(preferred)
      ? preferred
      : availableDestinations[0] ?? "plain";
    return {
      id: row.id,
      title: row.title,
      contentMarkdown: row.content_markdown,
      kind: row.kind,
      project: row.project_name,
      tags: row.tags,
      sourceClient: row.source_client,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      archivedAt: row.status === "done" ? iso(row.done_at) : null,
      recipeId: row.recipe_id,
      recipePayload: row.recipe_payload,
      status: row.status,
      currentRevision: row.current_revision,
      revisionCount: row.current_revision,
      reviewedAt: iso(row.reviewed_at),
      copiedAt: iso(row.copied_at),
      doneAt: iso(row.done_at),
      expiresAt: iso(row.expires_at),
      provenance: row.provenance,
      secretFindings: row.findings,
      availableDestinations,
      defaultDestination,
      humanEdited: row.human_edited || row.current_author_kind === "human"
    };
  }

  private async item(context: TenantContext, id: string): Promise<OutputItem | undefined> {
    const result = await context.client.query<ItemRow>(
      `${ITEM_SELECT} WHERE i.workspace_id = $1 AND i.id = $2`,
      [context.workspaceId, id]
    );
    return result.rows[0] ? this.hydrate(result.rows[0]) : undefined;
  }

  private async requireItem(context: TenantContext, id: string): Promise<OutputItem> {
    const item = await this.item(context, id);
    if (!item) throw new ItemNotFoundError(id);
    return item;
  }

  private async project(context: TenantContext, name: string, create = false): Promise<ProjectRow | undefined> {
    if (create) {
      await context.client.query(
        `INSERT INTO project (workspace_id, name)
         VALUES ($1, $2)
         ON CONFLICT ON CONSTRAINT project_workspace_name_unique
         DO UPDATE SET name = EXCLUDED.name`,
        [context.workspaceId, name]
      );
    }
    const result = await context.client.query<ProjectRow>(
      `SELECT id, name, default_recipe_id, default_destination,
         default_destination_explicit, allowed_destinations, secret_mode,
         require_secret_ack, require_review_before_copy, copy_behavior,
         retention_days, updated_at
       FROM project WHERE workspace_id = $1 AND normalized_name = lower(btrim($2))`,
      [context.workspaceId, name]
    );
    return result.rows[0];
  }

  private async patterns(context: TenantContext, projectId: string): Promise<SecretPattern[]> {
    const result = await context.client.query<{
      id: string; label: string; pattern_kind: "literal" | "glob"; pattern: string;
      severity: SecretPattern["severity"];
    }>(
      `SELECT id, label, pattern_kind, pattern, severity
       FROM project_secret_pattern
       WHERE workspace_id = $1 AND project_id = $2 AND enabled = true
       ORDER BY created_at LIMIT ${MAX_CUSTOM_SECRET_PATTERNS}`,
      [context.workspaceId, projectId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      label: row.label,
      patternKind: row.pattern_kind,
      pattern: row.pattern,
      severity: row.severity
    }));
  }

  private async insertProvenance(
    context: TenantContext,
    revisionId: string,
    sourceClient: string,
    provenance: CreateItemInput["provenance"],
    authorKind: "agent" | "human"
  ): Promise<void> {
    const capturedAt = new Date();
    await context.client.query(
      `INSERT INTO output_provenance (
         workspace_id, revision_id, source_client, source_client_version,
         agent_name, model, session_id, cwd, repo_root, repo_remote, branch,
         commit_sha, repo_dirty, capture_method, verification_status,
         verification_summary, captured_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        context.workspaceId, revisionId, sourceClient,
        provenance?.sourceClientVersion ?? null,
        provenance?.agentName ?? null,
        provenance?.model ?? null,
        provenance?.sessionId ?? null,
        provenance?.cwd ?? null,
        provenance?.repoRoot ?? null,
        provenance?.repoRemote ?? null,
        provenance?.branch ?? null,
        provenance?.commitSha ?? null,
        provenance?.repoDirty ?? null,
        authorKind === "human" ? "manual" : "client_supplied",
        provenance?.verificationStatus ?? "unverified",
        provenance?.verificationSummary ?? null,
        capturedAt
      ]
    );
    for (const file of provenance?.referencedFiles ?? []) {
      await context.client.query(
        `INSERT INTO referenced_file (workspace_id, revision_id, path, line_start, line_end)
         VALUES ($1, $2, $3, $4, $5)`,
        [context.workspaceId, revisionId, file.path, file.lineStart ?? null, file.lineEnd ?? null]
      );
    }
  }

  private async insertFindings(
    context: TenantContext,
    revisionId: string,
    findings: ScannedSecretFinding[]
  ): Promise<void> {
    for (const finding of findings) {
      await context.client.query(
        `INSERT INTO secret_finding (
           workspace_id, revision_id, scanner_version, rule_id, label, severity,
           action, start_offset, end_offset, line_number, fingerprint, redacted_preview
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (workspace_id, revision_id, rule_id, start_offset, end_offset)
         DO UPDATE SET scanner_version = EXCLUDED.scanner_version,
           label = EXCLUDED.label, severity = EXCLUDED.severity,
           action = EXCLUDED.action, fingerprint = EXCLUDED.fingerprint,
           redacted_preview = EXCLUDED.redacted_preview`,
        [context.workspaceId, revisionId, finding.ruleId, finding.label, finding.severity,
          finding.action, finding.startOffset, finding.endOffset, finding.lineNumber,
          finding.fingerprint, finding.redactedPreview]
      );
    }
  }

  private async event(
    context: TenantContext,
    itemId: string,
    revision: number | null,
    eventType: string,
    options: {
      destination?: Destination;
      representationId?: string;
      clientEventId?: string;
      idempotencyFingerprint?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<void> {
    await context.client.query(
      `INSERT INTO output_event (
         workspace_id, item_id, revision, event_type, destination,
         representation_id, actor_kind, actor_user_id, oauth_client_id,
         actor_label, client_event_id, idempotency_fingerprint, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11, $12, $13)`,
      [
        context.workspaceId, itemId, revision, eventType,
        options.destination ?? null, options.representationId ?? null,
        context.actor.kind, context.actor.userId,
        context.actor.oauthClientId ?? null, context.actor.label,
        options.clientEventId ?? null, options.idempotencyFingerprint ?? null,
        options.metadata ?? {}
      ]
    );
    await context.client.query(
      `INSERT INTO audit_event (
         workspace_id, actor_user_id, oauth_client_id, request_id,
         action, resource_type, resource_id, outcome, ip_address,
         user_agent, metadata
       ) VALUES ($1, $2::uuid, $3, $4, $5, 'output', $6, 'success',
         $7::inet, $8, $9::jsonb)`,
      [
        context.workspaceId,
        context.actor.userId,
        context.actor.oauthClientId ?? null,
        context.actor.requestId ?? null,
        `output.${eventType}`,
        itemId,
        context.actor.ipAddress ?? null,
        context.actor.userAgent ?? null,
        JSON.stringify({ revision, destination: options.destination ?? null })
      ]
    );
  }

  async create(actor: CloudActor, input: CreateItemInput): Promise<OutputItem> {
    return this.inWorkspace(actor, async (context) => {
      const idempotencyFingerprint = input.idempotencyKey
        ? requestFingerprint("output.create", { ...input, idempotencyKey: undefined })
        : undefined;
      if (input.idempotencyKey) {
        await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${context.workspaceId}:${input.idempotencyKey}`
        ]);
        const prior = await context.client.query<{
          item_id: string;
          revision: number;
          idempotency_fingerprint: string | null;
        }>(
          `SELECT item_id, revision, idempotency_fingerprint
           FROM output_revision WHERE workspace_id = $1 AND idempotency_key = $2`,
          [context.workspaceId, input.idempotencyKey]
        );
        if (prior.rows[0]) {
          if (
            prior.rows[0].revision !== 1 ||
            prior.rows[0].idempotency_fingerprint !== idempotencyFingerprint
          ) throw new IdempotencyConflictError();
          return this.requireItem(context, prior.rows[0].item_id);
        }
      }

      const kind = input.kind ?? "note";
      const recipeId = input.recipeId ?? recipeForLegacyKind(kind);
      const resolvedKind = input.recipeId ? kindForRecipe(recipeId) : kind;
      const projectName = input.project ?? "General";
      const project = await this.project(context, projectName, true);
      if (!project) throw new Error("Project could not be created");
      const sourceClient = input.sourceClient ?? input.provenance?.sourceClient ?? actor.label;
      const payload = input.recipePayload ??
        (recipeId.startsWith("generic_") ? { contentMarkdown: input.contentMarkdown } : null);
      const findings = scanSecrets(
        `${input.title}\n${input.contentMarkdown}`,
        project.secret_mode,
        await this.patterns(context, project.id)
      );
      const blocked = findings.filter((finding) => finding.action === "block");
      if (blocked.length) throw new SecretBlockedError(blocked);
      await this.consumeSaveQuota(context, Buffer.byteLength(input.contentMarkdown), true);

      const itemId = randomUUID();
      const revisionId = randomUUID();
      const authorKind = actor.kind === "human" || sourceClient === "manual" ? "human" : "agent";
      await context.client.query(
        `INSERT INTO output_item (
           workspace_id, id, project_id, title, content_markdown, kind, tags,
           source_client, recipe_id, recipe_payload, status, current_revision
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', 1)`,
        [context.workspaceId, itemId, project.id, input.title, input.contentMarkdown,
          resolvedKind, input.tags ?? [], sourceClient, recipeId, payload]
      );
      await context.client.query(
        `INSERT INTO output_revision (
           workspace_id, id, item_id, revision, title, content_markdown,
           recipe_id, recipe_payload, author_kind, author_user_id, author_label,
           idempotency_key, idempotency_fingerprint
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12)`,
        [context.workspaceId, revisionId, itemId, input.title, input.contentMarkdown,
          recipeId, payload, authorKind, actor.userId, sourceClient,
          input.idempotencyKey ?? null, idempotencyFingerprint ?? null]
      );
      await this.insertProvenance(context, revisionId, sourceClient, input.provenance, authorKind);
      await this.insertFindings(context, revisionId, findings);
      await this.event(context, itemId, 1, "created");
      return this.requireItem(context, itemId);
    });
  }

  async consumeMcpRequest(actor: CloudActor): Promise<void> {
    await this.inWorkspace(actor, async (context) => {
      const { limits } = await this.plan(context);
      await this.consumeCounter(
        context,
        "mcp_requests_minute",
        periodBounds("minute"),
        limits.requestsPerMinute,
        "requestsPerMinute"
      );
    });
  }

  async get(actor: CloudActor, id: string): Promise<OutputItem | undefined> {
    return this.inWorkspace(actor, (context) => this.item(context, id));
  }

  async list(actor: CloudActor, query: ItemQuery): Promise<ItemsResponse> {
    return this.inWorkspace(actor, async (context) => {
      const clauses = ["i.workspace_id = $1"];
      const values: unknown[] = [context.workspaceId];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        clauses.push(sql.replace("?", `$${values.length}`));
      };
      if (query.archived === "true") clauses.push("i.status = 'done'");
      else if (query.archived === "false") clauses.push("i.status <> 'done'");
      if (query.q) add("concat_ws(' ', i.title, i.content_markdown, p.name, array_to_string(i.tags, ' ')) ILIKE '%' || ? || '%'", query.q);
      if (query.project) add("lower(p.name) = lower(?)", query.project);
      if (query.kind) add("i.kind = ?", query.kind);
      if (query.tag) add("? = ANY(i.tags)", query.tag);
      if (query.status) add("i.status = ?", query.status);
      if (query.recipe) add("i.recipe_id = ?", query.recipe);
      if (query.cursor) {
        const cursor = decodeItemCursor(query.cursor);
        if (!cursor) throw new Error("Invalid pagination cursor");
        values.push(cursor.updatedAt, cursor.createdAt, cursor.id);
        clauses.push(
          `(i.updated_at, i.created_at, i.id::text) < ` +
            `($${values.length - 2}::timestamptz, $${values.length - 1}::timestamptz, $${values.length}::text)`
        );
      }
      const limit = Math.min(query.limit ?? 50, 100);
      values.push(limit + 1);
      const result = await context.client.query<ItemRow>(
        `${ITEM_SELECT} WHERE ${clauses.join(" AND ")}
         ORDER BY i.updated_at DESC, i.created_at DESC, i.id::text DESC LIMIT $${values.length}`,
        values
      );
      const hasMore = result.rows.length > limit;
      const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
      const items = pageRows.map((row) => this.hydrate(row));
      const archivedClause = query.archived === "true"
        ? "AND i.status = 'done'"
        : query.archived === "false"
          ? "AND i.status <> 'done'"
          : "";
      const facetResult = await context.client.query<FacetCountRow>(
        `WITH eligible AS MATERIALIZED (
           SELECT i.project_id, i.kind, i.tags, i.status, i.recipe_id
           FROM output_item i
           WHERE i.workspace_id = $1 ${archivedClause}
         )
         SELECT 'projects'::text AS facet, p.name AS value, count(*)::text AS count
         FROM eligible e
         JOIN project p ON p.workspace_id = $1 AND p.id = e.project_id
         GROUP BY p.name
         UNION ALL
         SELECT 'kinds', e.kind, count(*)::text FROM eligible e GROUP BY e.kind
         UNION ALL
         SELECT 'tags', tag.value, count(*)::text
         FROM eligible e CROSS JOIN LATERAL unnest(e.tags) AS tag(value)
         WHERE btrim(tag.value) <> '' GROUP BY tag.value
         UNION ALL
         SELECT 'statuses', e.status, count(*)::text FROM eligible e GROUP BY e.status
         UNION ALL
         SELECT 'recipes', e.recipe_id, count(*)::text FROM eligible e GROUP BY e.recipe_id`,
        [context.workspaceId]
      );
      const lastRow = pageRows.at(-1);
      return {
        items,
        facets: facetsFromCountRows(facetResult.rows),
        ...(hasMore && lastRow
          ? {
              nextCursor: encodeItemCursor({
                updatedAt: iso(lastRow.updated_at)!,
                createdAt: iso(lastRow.created_at)!,
                id: lastRow.id
              })
            }
          : {})
      };
    });
  }

  async createRevision(actor: CloudActor, id: string, input: CreateRevisionInput): Promise<OutputItem> {
    return this.inWorkspace(actor, async (context) => {
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.workspaceId}:${id}`]);
      const idempotencyFingerprint = input.idempotencyKey
        ? requestFingerprint(`output.revision:${id}`, { ...input, idempotencyKey: undefined })
        : undefined;
      if (input.idempotencyKey) {
        await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${context.workspaceId}:${input.idempotencyKey}`
        ]);
        const prior = await context.client.query<{
          item_id: string;
          revision: number;
          idempotency_fingerprint: string | null;
        }>(
          `SELECT item_id, revision, idempotency_fingerprint
           FROM output_revision WHERE workspace_id = $1 AND idempotency_key = $2`,
          [context.workspaceId, input.idempotencyKey]
        );
        if (prior.rows[0]) {
          if (
            prior.rows[0].item_id !== id ||
            prior.rows[0].revision === 1 ||
            prior.rows[0].idempotency_fingerprint !== idempotencyFingerprint
          ) throw new IdempotencyConflictError();
          return this.requireItem(context, prior.rows[0].item_id);
        }
      }
      const current = await this.requireItem(context, id);
      if (input.baseRevision !== current.currentRevision) throw new StaleRevisionError(current.currentRevision);
      const project = await this.project(context, current.project);
      if (!project) throw new Error("Project policy is missing");
      const revision = current.currentRevision + 1;
      const title = input.title ?? current.title;
      const recipeId = input.recipeId ?? current.recipeId;
      const payload = input.recipePayload === undefined
        ? recipeId.startsWith("generic_") ? { contentMarkdown: input.contentMarkdown } : null
        : input.recipePayload;
      const sourceClient = input.sourceClient ?? input.provenance?.sourceClient ?? actor.label;
      const authorKind = input.authorKind ?? actor.kind;
      const findings = scanSecrets(`${title}\n${input.contentMarkdown}`, project.secret_mode, await this.patterns(context, project.id));
      const blocked = findings.filter((finding) => finding.action === "block");
      if (blocked.length) throw new SecretBlockedError(blocked);
      await this.consumeSaveQuota(context, Buffer.byteLength(input.contentMarkdown), false);
      const revisionId = randomUUID();
      await context.client.query(
        `INSERT INTO output_revision (
           workspace_id, id, item_id, revision, title, content_markdown,
           recipe_id, recipe_payload, change_note, author_kind, author_user_id,
           author_label, idempotency_key, idempotency_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12, $13, $14)`,
        [context.workspaceId, revisionId, id, revision, title, input.contentMarkdown,
          recipeId, payload, input.changeNote ?? null, authorKind, actor.userId,
          sourceClient, input.idempotencyKey ?? null, idempotencyFingerprint ?? null]
      );
      await this.insertProvenance(context, revisionId, sourceClient, input.provenance, authorKind);
      await this.insertFindings(context, revisionId, findings);
      await context.client.query(
        `UPDATE output_item SET title = $3, content_markdown = $4,
           recipe_id = $5, recipe_payload = $6, kind = $7,
           source_client = $8, current_revision = $9, status = 'new',
           status_before_done = NULL, reviewed_at = NULL, copied_at = NULL,
           done_at = NULL, expires_at = NULL
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, id, title, input.contentMarkdown, recipeId, payload,
          kindForRecipe(recipeId), sourceClient, revision]
      );
      await this.event(context, id, revision, "revised", { metadata: { changeNote: input.changeNote ?? null } });
      return this.requireItem(context, id);
    });
  }

  async listRevisions(actor: CloudActor, id: string): Promise<ItemRevision[]> {
    return this.inWorkspace(actor, async (context) => {
      await this.requireItem(context, id);
      const result = await context.client.query<RevisionRow>(
        `SELECT r.*,
           CASE WHEN provenance.revision_id IS NULL THEN NULL ELSE jsonb_build_object(
             'sourceClient', provenance.source_client,
             'sourceClientVersion', provenance.source_client_version,
             'agentName', provenance.agent_name,
             'model', provenance.model,
             'sessionId', provenance.session_id,
             'cwd', provenance.cwd,
             'repoRoot', provenance.repo_root,
             'repoRemote', provenance.repo_remote,
             'branch', provenance.branch,
             'commitSha', provenance.commit_sha,
             'repoDirty', provenance.repo_dirty,
             'captureMethod', provenance.capture_method,
             'verificationStatus', provenance.verification_status,
             'verificationSummary', provenance.verification_summary,
             'referencedFiles', COALESCE((
               SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                 'path', rf.path, 'lineStart', rf.line_start, 'lineEnd', rf.line_end
               )) ORDER BY rf.path)
               FROM referenced_file rf
               WHERE rf.workspace_id = r.workspace_id AND rf.revision_id = r.id
             ), '[]'::jsonb),
             'capturedAt', provenance.captured_at
           ) END AS provenance
         FROM output_revision r
         LEFT JOIN output_provenance provenance
           ON provenance.workspace_id = r.workspace_id AND provenance.revision_id = r.id
         WHERE r.workspace_id = $1 AND r.item_id = $2
         ORDER BY r.revision DESC`,
        [context.workspaceId, id]
      );
      return result.rows.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        revision: row.revision,
        title: row.title,
        contentMarkdown: row.content_markdown,
        recipeId: row.recipe_id,
        recipePayload: row.recipe_payload,
        changeNote: row.change_note,
        authorKind: row.author_kind,
        authorLabel: row.author_label,
        provenance: row.provenance,
        createdAt: iso(row.created_at)!
      }));
    });
  }

  async transition(actor: CloudActor, id: string, status: ItemStatus): Promise<OutputItem> {
    return this.inWorkspace(actor, async (context) => {
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.workspaceId}:${id}`]);
      const current = await this.requireItem(context, id);
      if (current.status === status) return current;
      const project = await this.project(context, current.project);
      if (!project) throw new Error("Project policy is missing");
      const now = new Date();
      const reviewedAt = status === "reviewed" ? now : current.reviewedAt;
      const copiedAt = status === "copied" ? now : current.copiedAt;
      const doneAt = status === "done" ? now : null;
      const expiresAt = status === "done" ? addDays(now, project.retention_days) : null;
      await context.client.query(
        `UPDATE output_item SET status = $3,
           status_before_done = CASE WHEN $3 = 'done' THEN $4 ELSE NULL END,
           reviewed_at = $5, copied_at = $6, done_at = $7, expires_at = $8
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, id, status, current.status, reviewedAt, copiedAt, doneAt, expiresAt]
      );
      const eventType = status === "reviewed" ? "reviewed"
        : status === "copied" ? "copied"
          : status === "done" ? "completed" : "reopened";
      await this.event(context, id, current.currentRevision, eventType);
      return this.requireItem(context, id);
    });
  }

  private async representation(
    context: TenantContext,
    id: string,
    destination: Destination
  ): Promise<DestinationRepresentation> {
    const item = await this.requireItem(context, id);
    const project = await this.project(context, item.project);
    if (!project) throw new Error("Project policy is missing");
    const recipe = getRecipe(item.recipeId);
    if (!project.allowed_destinations.includes(destination) || !recipe.destinations.includes(destination)) {
      throw new CopyBlockedError([`${destination} is not allowed for this project and recipe.`]);
    }
    const currentFindings = scanSecrets(
      `${item.title}\n${item.contentMarkdown}`,
      project.secret_mode,
      await this.patterns(context, project.id)
    );
    const currentRevision = await context.client.query<{ id: string }>(
      `SELECT id FROM output_revision
       WHERE workspace_id = $1 AND item_id = $2 AND revision = $3`,
      [context.workspaceId, id, item.currentRevision]
    );
    const revisionId = currentRevision.rows[0]?.id;
    if (!revisionId) throw new Error("Current revision could not be resolved");
    await this.insertFindings(context, revisionId, currentFindings);
    const findingStates = await context.client.query<FindingStateRow>(
      `SELECT rule_id, start_offset, end_offset, status
       FROM secret_finding WHERE workspace_id = $1 AND revision_id = $2`,
      [context.workspaceId, revisionId]
    );
    const statusByLocation = new Map(
      findingStates.rows.map((finding) => [
        `${finding.rule_id}:${finding.start_offset}:${finding.end_offset}`,
        finding.status
      ])
    );
    const reasons = currentFindings
      .filter((finding) => finding.action === "block")
      .map((finding) => finding.redactedPreview);
    const hasUnacknowledgedWarning = currentFindings
      .filter((finding) => finding.action === "warn")
      .some((finding) => {
        const status = statusByLocation.get(
          `${finding.ruleId}:${finding.startOffset}:${finding.endOffset}`
        );
        return status !== "acknowledged" && status !== "false_positive";
      });
    if (project.require_secret_ack && hasUnacknowledgedWarning) {
      reasons.push("Secret warnings must be acknowledged before copying.");
    }
    if (project.require_review_before_copy && item.status === "new") {
      reasons.push("This project requires review before copying.");
    }
    let result = await context.client.query<RepresentationRow>(
      `SELECT id, item_id, revision, destination, plain_text, markdown_text,
         html_text, metadata, warnings, created_at
       FROM output_representation
       WHERE workspace_id = $1 AND item_id = $2 AND revision = $3
         AND destination = $4 AND transformer_version = $5`,
      [context.workspaceId, id, item.currentRevision, destination, TRANSFORMER_VERSION]
    );
    if (!result.rows[0]) {
      const content = buildRepresentation(destination, item.contentMarkdown, item.recipePayload);
      const checksum = contentChecksum(
        `${content.plainText}\0${content.markdownText ?? ""}\0${content.htmlText ?? ""}`
      );
      await context.client.query(
        `INSERT INTO output_representation (
           workspace_id, item_id, revision, destination, transformer_version,
           plain_text, markdown_text, html_text, metadata, warnings, checksum
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
         ON CONFLICT (workspace_id, item_id, revision, destination, transformer_version)
         DO NOTHING`,
        [context.workspaceId, id, item.currentRevision, destination, TRANSFORMER_VERSION,
          content.plainText, content.markdownText, content.htmlText,
          content.metadata, JSON.stringify(content.warnings), checksum]
      );
      result = await context.client.query<RepresentationRow>(
        `SELECT id, item_id, revision, destination, plain_text, markdown_text,
           html_text, metadata, warnings, created_at
         FROM output_representation
         WHERE workspace_id = $1 AND item_id = $2 AND revision = $3
           AND destination = $4 AND transformer_version = $5`,
        [context.workspaceId, id, item.currentRevision, destination, TRANSFORMER_VERSION]
      );
    }
    const row = result.rows[0];
    if (!row) throw new Error("Representation could not be generated");
    return {
      id: row.id,
      itemId: row.item_id,
      revision: row.revision,
      destination: row.destination,
      plainText: row.plain_text,
      markdownText: row.markdown_text,
      htmlText: row.html_text,
      metadata: row.metadata,
      warnings: row.warnings,
      createdAt: iso(row.created_at)!,
      copyAllowed: reasons.length === 0,
      blockReasons: reasons
    };
  }

  async getRepresentation(
    actor: CloudActor,
    id: string,
    destination: Destination
  ): Promise<DestinationRepresentation> {
    return this.inWorkspace(actor, (context) => this.representation(context, id, destination));
  }

  async recordCopy(
    actor: CloudActor,
    id: string,
    input: {
      representationId: string;
      destination?: Destination;
      format?: string;
      clientEventId?: string;
    }
  ): Promise<OutputItem> {
    return this.inWorkspace(actor, async (context) => {
      await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${context.workspaceId}:${id}`]);
      const idempotencyFingerprint = input.clientEventId
        ? requestFingerprint(`output.copy:${id}`, {
            representationId: input.representationId,
            destination: input.destination ?? null,
            format: input.format ?? null
          })
        : undefined;
      if (input.clientEventId) {
        await context.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${context.workspaceId}:${input.clientEventId}`
        ]);
        const prior = await context.client.query<{
          item_id: string;
          idempotency_fingerprint: string | null;
        }>(
          `SELECT item_id, idempotency_fingerprint
           FROM output_event WHERE workspace_id = $1 AND client_event_id = $2`,
          [context.workspaceId, input.clientEventId]
        );
        if (prior.rows[0]) {
          if (
            prior.rows[0].item_id !== id ||
            prior.rows[0].idempotency_fingerprint !== idempotencyFingerprint
          ) throw new IdempotencyConflictError();
          return this.requireItem(context, prior.rows[0].item_id);
        }
      }
      const item = await this.requireItem(context, id);
      const representationResult = await context.client.query<RepresentationRow>(
        `SELECT id, item_id, revision, destination, plain_text, markdown_text,
           html_text, metadata, warnings, created_at
         FROM output_representation
         WHERE workspace_id = $1 AND id = $2 AND item_id = $3`,
        [context.workspaceId, input.representationId, id]
      );
      const row = representationResult.rows[0];
      if (!row || row.revision !== item.currentRevision) {
        throw new CopyBlockedError(["The prepared representation is stale or missing."]);
      }
      if (input.destination && input.destination !== row.destination) {
        throw new CopyBlockedError(["The copy destination does not match the prepared representation."]);
      }
      const prepared = await this.representation(context, id, row.destination);
      if (!prepared.copyAllowed) throw new CopyBlockedError(prepared.blockReasons);
      const project = await this.project(context, item.project);
      if (!project) throw new Error("Project policy is missing");
      const now = new Date();
      const nextStatus: ItemStatus = project.copy_behavior === "mark_done"
        ? "done"
        : project.copy_behavior === "mark_copied" && item.status !== "done"
          ? "copied" : item.status;
      const doneAt = nextStatus === "done" ? now : item.doneAt;
      const expiresAt = nextStatus === "done" ? addDays(now, project.retention_days) : null;
      await context.client.query(
        `UPDATE output_item SET status = $3,
           status_before_done = CASE WHEN $3 = 'done' THEN $4 ELSE status_before_done END,
           copied_at = $5, done_at = $6, expires_at = $7
         WHERE workspace_id = $1 AND id = $2`,
        [context.workspaceId, id, nextStatus, item.status, now, doneAt, expiresAt]
      );
      await this.event(context, id, item.currentRevision, "copied", {
        destination: row.destination,
        representationId: row.id,
        clientEventId: input.clientEventId,
        idempotencyFingerprint,
        metadata: { format: input.format ?? "plain" }
      });
      return this.requireItem(context, id);
    });
  }

  async getFindings(actor: CloudActor, id: string): Promise<SecretFinding[]> {
    const item = await this.get(actor, id);
    if (!item) throw new ItemNotFoundError(id);
    return item.secretFindings;
  }

  async acknowledgeFinding(
    actor: CloudActor,
    id: string,
    findingId: string
  ): Promise<OutputItem> {
    return this.inWorkspace(actor, async (context) => {
      const item = await this.requireItem(context, id);
      const result = await context.client.query(
        `UPDATE secret_finding sf SET status = 'acknowledged',
           acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = $4::uuid
         FROM output_revision r
         WHERE sf.workspace_id = $1 AND sf.id = $2
           AND r.workspace_id = sf.workspace_id AND r.id = sf.revision_id
           AND r.item_id = $3 AND r.revision = $5
         RETURNING sf.id`,
        [context.workspaceId, findingId, id, actor.userId, item.currentRevision]
      );
      if (result.rowCount !== 1) throw new FindingNotFoundError(findingId);
      await this.event(context, id, item.currentRevision, "secret_acknowledged", {
        metadata: { findingId }
      });
      return this.requireItem(context, id);
    });
  }

  async getProjectPolicy(actor: CloudActor, name: string): Promise<ProjectPolicy> {
    return this.inWorkspace(actor, async (context) => {
      const project = await this.project(context, name, true);
      if (!project) throw new Error("Project could not be created");
      return policyFromRow(project);
    });
  }

  async updateProjectPolicy(
    actor: CloudActor,
    name: string,
    patch: Partial<Pick<ProjectPolicy,
      "defaultRecipeId" | "defaultDestination" | "allowedDestinations" |
      "secretMode" | "requireSecretAck" | "requireReviewBeforeCopy" |
      "copyBehavior" | "retentionDays">>
  ): Promise<ProjectPolicy> {
    return this.inWorkspace(actor, async (context) => {
      const current = await this.project(context, name, true);
      if (!current) throw new Error("Project could not be created");
      const allowed = patch.allowedDestinations ?? current.allowed_destinations;
      const destination = patch.defaultDestination ?? current.default_destination;
      if (!allowed.includes(destination)) {
        throw new Error("The default destination must be included in allowed destinations");
      }
      const result = await context.client.query<ProjectRow>(
        `UPDATE project SET
           default_recipe_id = $3,
           default_destination = $4,
           default_destination_explicit = $5,
           allowed_destinations = $6,
           secret_mode = $7,
           require_secret_ack = $8,
           require_review_before_copy = $9,
           copy_behavior = $10,
           retention_days = $11
         WHERE workspace_id = $1 AND id = $2
         RETURNING id, name, default_recipe_id, default_destination,
           default_destination_explicit, allowed_destinations, secret_mode,
           require_secret_ack, require_review_before_copy, copy_behavior,
           retention_days, updated_at`,
        [context.workspaceId, current.id,
          patch.defaultRecipeId ?? current.default_recipe_id,
          destination,
          patch.defaultDestination === undefined ? current.default_destination_explicit : true,
          allowed,
          patch.secretMode ?? current.secret_mode,
          patch.requireSecretAck ?? current.require_secret_ack,
          patch.requireReviewBeforeCopy ?? current.require_review_before_copy,
          patch.copyBehavior ?? current.copy_behavior,
          patch.retentionDays === undefined ? current.retention_days : patch.retentionDays]
      );
      const updated = result.rows[0];
      if (!updated) throw new Error("Project policy could not be updated");
      await context.client.query(
        `INSERT INTO audit_event (
           workspace_id, actor_user_id, oauth_client_id, request_id,
           action, resource_type, resource_id, outcome, ip_address, user_agent
         ) VALUES ($1, $2::uuid, $3, $4, 'project.policy.update', 'project', $5, 'success', $6::inet, $7)`,
        [context.workspaceId, actor.userId, actor.oauthClientId ?? null,
          actor.requestId ?? null, current.id, actor.ipAddress ?? null, actor.userAgent ?? null]
      );
      return policyFromRow(updated);
    });
  }

  async listProjects(actor: CloudActor): Promise<Array<{ project: string; count: number; policy: ProjectPolicy }>> {
    return this.inWorkspace(actor, async (context) => {
      const result = await context.client.query<ProjectRow & { item_count: string }>(
        `SELECT p.id, p.name, p.default_recipe_id, p.default_destination,
           p.default_destination_explicit, p.allowed_destinations, p.secret_mode,
           p.require_secret_ack, p.require_review_before_copy, p.copy_behavior,
           p.retention_days, p.updated_at, count(i.id)::text AS item_count
         FROM project p
         LEFT JOIN output_item i ON i.workspace_id = p.workspace_id AND i.project_id = p.id
         WHERE p.workspace_id = $1
         GROUP BY p.workspace_id, p.id
         ORDER BY lower(p.name)`,
        [context.workspaceId]
      );
      return result.rows.map((row) => ({
        project: row.name,
        count: Number(row.item_count),
        policy: policyFromRow(row)
      }));
    });
  }

  async listSecretPatterns(actor: CloudActor, projectName: string): Promise<SecretPattern[]> {
    return this.inWorkspace(actor, async (context) => {
      const project = await this.project(context, projectName, true);
      if (!project) throw new Error("Project could not be created");
      return this.patterns(context, project.id);
    });
  }

  async addSecretPattern(actor: CloudActor, projectName: string, pattern: Omit<SecretPattern, "id">): Promise<SecretPattern> {
    return this.inWorkspace(actor, async (context) => {
      const project = await this.project(context, projectName, true);
      if (!project) throw new Error("Project could not be created");
      const count = await context.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM project_secret_pattern
         WHERE workspace_id = $1 AND project_id = $2`,
        [context.workspaceId, project.id]
      );
      if (Number(count.rows[0]?.count ?? 0) >= MAX_CUSTOM_SECRET_PATTERNS) {
        throw new SecretPatternLimitError(MAX_CUSTOM_SECRET_PATTERNS);
      }
      let result;
      try {
        result = await context.client.query<{
          id: string; label: string; pattern_kind: "literal" | "glob"; pattern: string;
          severity: SecretPattern["severity"];
        }>(
          `INSERT INTO project_secret_pattern (
             workspace_id, project_id, label, pattern_kind, pattern, severity
           ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, label, pattern_kind, pattern, severity`,
          [context.workspaceId, project.id, pattern.label, pattern.patternKind,
            pattern.pattern, pattern.severity]
        );
      } catch (error: unknown) {
        if (isSecretPatternQuotaDatabaseError(error)) {
          throw new SecretPatternLimitError(MAX_CUSTOM_SECRET_PATTERNS);
        }
        throw error;
      }
      const row = result.rows[0];
      if (!row) throw new Error("Secret pattern could not be created");
      return { id: row.id, label: row.label, patternKind: row.pattern_kind, pattern: row.pattern, severity: row.severity };
    });
  }

  async deleteSecretPattern(actor: CloudActor, projectName: string, patternId: string): Promise<boolean> {
    return this.inWorkspace(actor, async (context) => {
      const project = await this.project(context, projectName);
      if (!project) return false;
      const result = await context.client.query(
        `DELETE FROM project_secret_pattern
         WHERE workspace_id = $1 AND project_id = $2 AND id = $3`,
        [context.workspaceId, project.id, patternId]
      );
      return result.rowCount === 1;
    });
  }

  async delete(actor: CloudActor, id: string): Promise<boolean> {
    return this.inWorkspace(actor, async (context) => {
      const result = await context.client.query(
        "DELETE FROM output_item WHERE workspace_id = $1 AND id = $2 RETURNING id",
        [context.workspaceId, id]
      );
      return result.rowCount === 1;
    });
  }

  async usage(actor: CloudActor): Promise<CloudUsageSummary> {
    return this.inWorkspace(actor, async (context) => {
      const plan = await this.plan(context);
      const daily = periodBounds("day");
      const monthly = periodBounds("month");
      const dailySaves = await this.counterValue(context, "saves_day", daily);
      const monthlySaves = await this.counterValue(context, "saves_month", monthly);
      const totals = await context.client.query<{ item_count: string; storage_bytes: string }>(
        `SELECT
           (SELECT count(*)::text FROM output_item WHERE workspace_id = $1) AS item_count,
           (SELECT COALESCE(sum(content_bytes), 0)::text FROM output_revision WHERE workspace_id = $1) AS storage_bytes`,
        [context.workspaceId]
      );
      const clients = await context.client.query<{ count: string }>(
        `SELECT count(DISTINCT "clientId")::text AS count
         FROM "oauthConsent" WHERE "userId" = $1::uuid`,
        [actor.userId]
      );
      const total = totals.rows[0];
      return {
        plan: plan.name,
        monthlySaves: { used: monthlySaves, limit: plan.limits.monthlySaves },
        dailySaves: { used: dailySaves, limit: plan.limits.dailySaves },
        storedItems: { used: Number(total?.item_count ?? 0), limit: plan.limits.storedItems },
        storageBytes: { used: Number(total?.storage_bytes ?? 0), limit: plan.limits.storageBytes },
        activeOAuthClients: { used: Number(clients.rows[0]?.count ?? 0), limit: plan.limits.activeOAuthClients }
      };
    });
  }

  async billingSubscriptions(actor: CloudActor): Promise<CloudBillingSubscription[]> {
    return this.inWorkspace(actor, async (context) => {
      const result = await context.client.query<{
        id: string;
        plan: string;
        status: string;
        billingInterval: string | null;
        periodEnd: Date | null;
        cancelAtPeriodEnd: boolean | null;
      }>(
        `SELECT id, plan, status, "billingInterval", "periodEnd", "cancelAtPeriodEnd"
         FROM subscription
         WHERE "referenceId" = $1
         ORDER BY COALESCE("periodEnd", '-infinity'::timestamptz) DESC, id DESC`,
        [actor.userId]
      );
      return result.rows.map((row) => ({
        id: row.id,
        plan: row.plan,
        status: row.status,
        billingInterval: row.billingInterval,
        periodEnd: iso(row.periodEnd),
        cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false
      }));
    });
  }

  private async streamExportArray(
    context: TenantContext,
    key: string,
    selectSql: string,
    write: CloudExportWriter
  ): Promise<void> {
    await write(`,${JSON.stringify(key)}:[`);
    await context.client.query(`DECLARE draftrelay_export_rows NO SCROLL CURSOR FOR ${selectSql}`);
    let first = true;
    try {
      while (true) {
        const page = await context.client.query<{ payload: unknown }>(
          "FETCH FORWARD 100 FROM draftrelay_export_rows"
        );
        if (page.rows.length === 0) break;
        const serialized = page.rows
          .map((row) => JSON.stringify(row.payload ?? null))
          .join(",");
        await write(`${first ? "" : ","}${serialized}`);
        first = false;
      }
    } finally {
      await context.client.query("CLOSE draftrelay_export_rows").catch(() => undefined);
    }
    await write("]");
  }

  async streamExportData(actor: CloudActor, write: CloudExportWriter): Promise<void> {
    await this.inWorkspace(actor, async (context) => {
      const header = await context.client.query<{
        exported_at: Date;
        profile: Record<string, unknown> | null;
        workspace: Record<string, unknown> | null;
      }>(
        `SELECT CURRENT_TIMESTAMP AS exported_at,
           (SELECT jsonb_build_object(
             'id', account.id, 'name', account.name, 'email', account.email,
             'emailVerified', account."emailVerified", 'image', account.image,
             'stripeCustomerId', account."stripeCustomerId",
             'createdAt', account."createdAt", 'updatedAt', account."updatedAt"
           ) FROM "user" account WHERE account.id = $1::uuid) AS profile,
           (SELECT to_jsonb(tenant) - 'created_by_user_id'
            FROM workspace tenant WHERE tenant.id = $2) AS workspace`,
        [actor.userId, context.workspaceId]
      );
      const snapshot = header.rows[0];
      if (!snapshot?.profile || !snapshot.workspace) {
        throw new Error("Account export context could not be resolved");
      }

      await write(
        `{"schemaVersion":1,"exportedAt":${JSON.stringify(snapshot.exported_at.toISOString())},` +
          `"account":{"profile":${JSON.stringify(snapshot.profile)}`
      );
      await this.streamExportArray(
        context,
        "linkedAccounts",
        `SELECT jsonb_build_object(
           'id', linked.id, 'accountId', linked."accountId", 'providerId', linked."providerId",
           'scope', linked.scope, 'accessTokenExpiresAt', linked."accessTokenExpiresAt",
           'refreshTokenExpiresAt', linked."refreshTokenExpiresAt",
           'createdAt', linked."createdAt", 'updatedAt', linked."updatedAt"
         ) AS payload
         FROM "account" linked WHERE linked."userId" = current_setting('app.user_id')::uuid
         ORDER BY linked."createdAt", linked.id`,
        write
      );
      await this.streamExportArray(
        context,
        "sessions",
        `SELECT jsonb_build_object(
           'id', session_row.id, 'expiresAt', session_row."expiresAt",
           'createdAt', session_row."createdAt", 'updatedAt', session_row."updatedAt",
           'userAgent', session_row."userAgent"
         ) AS payload
         FROM "session" session_row WHERE session_row."userId" = current_setting('app.user_id')::uuid
         ORDER BY session_row."createdAt", session_row.id`,
        write
      );
      await this.streamExportArray(
        context,
        "passkeys",
        `SELECT jsonb_build_object(
           'id', passkey_row.id, 'name', passkey_row.name,
           'credentialId', passkey_row."credentialID", 'counter', passkey_row.counter,
           'deviceType', passkey_row."deviceType", 'backedUp', passkey_row."backedUp",
           'transports', passkey_row.transports, 'createdAt', passkey_row."createdAt",
           'aaguid', passkey_row.aaguid
         ) AS payload
         FROM passkey passkey_row WHERE passkey_row."userId" = current_setting('app.user_id')::uuid
         ORDER BY passkey_row."createdAt", passkey_row.id`,
        write
      );
      await this.streamExportArray(
        context,
        "oauthConnections",
        `SELECT jsonb_build_object(
           'consentId', consent.id, 'clientId', consent."clientId", 'name', client.name,
           'uri', client.uri, 'icon', client.icon, 'scopes', consent.scopes,
           'resources', consent.resources, 'redirectUris', client."redirectUris",
           'grantTypes', client."grantTypes", 'responseTypes', client."responseTypes",
           'createdAt', consent."createdAt", 'updatedAt', consent."updatedAt"
         ) AS payload
         FROM "oauthConsent" consent
         JOIN "oauthClient" client ON client."clientId" = consent."clientId"
         WHERE consent."userId" = current_setting('app.user_id')::uuid
         ORDER BY consent."createdAt", consent.id`,
        write
      );
      await this.streamExportArray(
        context,
        "subscriptions",
        `SELECT jsonb_build_object(
           'id', subscription_row.id, 'plan', subscription_row.plan,
           'status', subscription_row.status,
           'stripeCustomerId', subscription_row."stripeCustomerId",
           'stripeSubscriptionId', subscription_row."stripeSubscriptionId",
           'periodStart', subscription_row."periodStart", 'periodEnd', subscription_row."periodEnd",
           'trialStart', subscription_row."trialStart", 'trialEnd', subscription_row."trialEnd",
           'cancelAtPeriodEnd', subscription_row."cancelAtPeriodEnd",
           'cancelAt', subscription_row."cancelAt", 'canceledAt', subscription_row."canceledAt",
           'endedAt', subscription_row."endedAt", 'billingInterval', subscription_row."billingInterval",
           'stripeScheduleId', subscription_row."stripeScheduleId",
           'stripeSyncedAt', subscription_row."stripeSyncedAt"
         ) AS payload
         FROM subscription subscription_row
         WHERE subscription_row."referenceId" = current_setting('app.user_id')
         ORDER BY COALESCE(subscription_row."periodEnd", '-infinity'::timestamptz), subscription_row.id`,
        write
      );
      await write(`},"workspace":${JSON.stringify(snapshot.workspace)}`);

      const domainArrays: Array<[string, string]> = [
        ["workspaceMembers", `SELECT to_jsonb(member_row) - 'workspace_id' AS payload
          FROM workspace_member member_row ORDER BY member_row.created_at, member_row.user_id`],
        ["projects", `SELECT to_jsonb(project_row) - 'workspace_id' - 'normalized_name' AS payload
          FROM project project_row ORDER BY project_row.created_at, project_row.id`],
        ["projectSecretPatterns", `SELECT to_jsonb(pattern_row) - 'workspace_id' AS payload
          FROM project_secret_pattern pattern_row ORDER BY pattern_row.created_at, pattern_row.id`],
        ["items", `SELECT to_jsonb(item_row) - 'workspace_id' AS payload
          FROM output_item item_row ORDER BY item_row.created_at, item_row.id`],
        ["revisions", `SELECT to_jsonb(revision_row) - 'workspace_id' - 'idempotency_fingerprint' AS payload
          FROM output_revision revision_row ORDER BY revision_row.created_at, revision_row.id`],
        ["provenance", `SELECT to_jsonb(provenance_row) - 'workspace_id' AS payload
          FROM output_provenance provenance_row ORDER BY provenance_row.captured_at, provenance_row.revision_id`],
        ["referencedFiles", `SELECT to_jsonb(file_row) - 'workspace_id' AS payload
          FROM referenced_file file_row ORDER BY file_row.path, file_row.id`],
        ["secretFindings", `SELECT to_jsonb(finding_row) - 'workspace_id' - 'fingerprint' AS payload
          FROM secret_finding finding_row ORDER BY finding_row.line_number, finding_row.id`],
        ["events", `SELECT to_jsonb(event_row) - 'workspace_id' - 'idempotency_fingerprint' AS payload
          FROM output_event event_row ORDER BY event_row.created_at, event_row.id`],
        ["representations", `SELECT to_jsonb(representation_row) - 'workspace_id' - 'checksum' AS payload
          FROM output_representation representation_row ORDER BY representation_row.created_at, representation_row.id`],
        ["entitlements", `SELECT to_jsonb(entitlement_row) - 'workspace_id' AS payload
          FROM workspace_entitlement entitlement_row ORDER BY entitlement_row.feature_key`],
        ["usage", `SELECT to_jsonb(counter_row) - 'workspace_id' AS payload
          FROM usage_counter counter_row ORDER BY counter_row.period_start, counter_row.metric`],
        ["auditEvents", `SELECT to_jsonb(audit_row) - 'workspace_id' - 'ip_address' AS payload
          FROM audit_event audit_row ORDER BY audit_row.created_at, audit_row.id`]
      ];
      for (const [key, sql] of domainArrays) {
        await this.streamExportArray(context, key, sql, write);
      }
      await write("}");
    }, { isolationLevel: "REPEATABLE READ" });
  }

  async exportData(actor: CloudActor): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    await this.streamExportData(actor, (chunk) => { chunks.push(chunk); });
    return JSON.parse(chunks.join("")) as Record<string, unknown>;
  }

  async isOAuthConnectionActive(userId: string, clientId: string): Promise<boolean> {
    return withTransaction(this.database, async (client) => {
      await client.query("SELECT set_config('app.user_id', $1::uuid::text, true)", [userId]);
      const membership = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_member
         WHERE user_id = $1::uuid
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
           created_at,
           workspace_id
         LIMIT 1`,
        [userId]
      );
      const workspaceId = membership.rows[0]?.workspace_id ?? null;
      if (workspaceId !== null) {
        await client.query(
          "SELECT set_config('app.workspace_id', $1::uuid::text, true)",
          [workspaceId]
        );
      }
      const result = await client.query<{ active: boolean }>(
        `WITH connection_limit AS (
           SELECT CASE WHEN public.draftrelay_has_paid_entitlement(
             $1::uuid,
             $3::uuid
           ) THEN 20 ELSE 3 END AS maximum
         ), ranked_connections AS (
           SELECT consent."clientId",
             row_number() OVER (
               ORDER BY consent."createdAt", consent.id
             ) AS position
           FROM "oauthConsent" consent
           JOIN "oauthClient" oauth_client ON oauth_client."clientId" = consent."clientId"
           WHERE consent."userId" = $1::uuid
             AND COALESCE(oauth_client.disabled, false) = false
         )
         SELECT EXISTS (
           SELECT 1 FROM ranked_connections, connection_limit
           WHERE ranked_connections."clientId" = $2
             AND ranked_connections.position <= connection_limit.maximum
         ) AS active`,
        [userId, clientId, workspaceId]
      );
      return result.rows[0]?.active ?? false;
    });
  }

  async listOAuthConnections(actor: CloudActor): Promise<OAuthConnectionSummary[]> {
    return this.inWorkspace(actor, async (context) => {
      const result = await context.client.query<{
        consent_id: string;
        client_id: string;
        name: string | null;
        uri: string | null;
        scopes: string[];
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT consent.id AS consent_id, consent."clientId" AS client_id,
           client.name, client.uri, consent.scopes,
           consent."createdAt" AS created_at, consent."updatedAt" AS updated_at
         FROM "oauthConsent" consent
         JOIN "oauthClient" client ON client."clientId" = consent."clientId"
         WHERE consent."userId" = $1::uuid
         ORDER BY consent."updatedAt" DESC`,
        [actor.userId]
      );
      return result.rows.map((row) => ({
        consentId: row.consent_id,
        clientId: row.client_id,
        name: row.name?.trim() || "MCP client",
        uri: row.uri,
        scopes: row.scopes,
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!
      }));
    });
  }

  async revokeOAuthConnection(actor: CloudActor, consentId: string): Promise<boolean> {
    return this.inWorkspace(actor, async (context) => {
      const consent = await context.client.query<{ client_id: string }>(
        `SELECT "clientId" AS client_id FROM "oauthConsent"
         WHERE id = $1::uuid AND "userId" = $2::uuid
         FOR UPDATE`,
        [consentId, actor.userId]
      );
      const clientId = consent.rows[0]?.client_id;
      if (!clientId) return false;
      await context.client.query(
        `DELETE FROM "oauthAccessToken"
         WHERE "userId" = $1::uuid AND "clientId" = $2`,
        [actor.userId, clientId]
      );
      await context.client.query(
        `DELETE FROM "oauthRefreshToken"
         WHERE "userId" = $1::uuid AND "clientId" = $2`,
        [actor.userId, clientId]
      );
      await context.client.query(
        `DELETE FROM "oauthConsent"
         WHERE id = $1::uuid AND "userId" = $2::uuid`,
        [consentId, actor.userId]
      );
      await context.client.query(
        `DELETE FROM "oauthClient" client
         WHERE client."clientId" = $1
           AND client."userId" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "oauthConsent" remaining
             WHERE remaining."clientId" = client."clientId"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "oauthAccessToken" remaining
             WHERE remaining."clientId" = client."clientId"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "oauthRefreshToken" remaining
             WHERE remaining."clientId" = client."clientId"
           )`,
        [clientId]
      );
      await context.client.query(
        `INSERT INTO audit_event (
           workspace_id, actor_user_id, request_id, action, resource_type,
           resource_id, outcome, ip_address, user_agent
         ) VALUES ($1, $2::uuid, $3, 'oauth.connection.revoke', 'oauth_client',
           $4, 'success', $5::inet, $6)`,
        [context.workspaceId, actor.userId, actor.requestId ?? null, clientId,
          actor.ipAddress ?? null, actor.userAgent ?? null]
      );
      return true;
    });
  }
}

export const cloudStoreInternals = {
  ITEM_SELECT,
  buildFacets,
  periodBounds
};
