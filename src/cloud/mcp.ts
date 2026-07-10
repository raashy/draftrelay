import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { DESTINATIONS, ITEM_KINDS, RECIPE_IDS, type OutputItem } from "../shared/items.js";
import { listRecipes } from "../server/recipes.js";
import {
  CopyBlockedError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  StaleRevisionError
} from "../server/errors.js";
import {
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  parseCreateItem,
  parseCreateRevision
} from "../server/validation.js";
import { CloudStore, QuotaExceededError, type CloudActor } from "./store.js";

const RECIPE_GUIDE = listRecipes()
  .filter((recipe) => !recipe.id.startsWith("generic_"))
  .map((recipe) => `${recipe.id}: ${recipe.fields.map((field) => `${field.name}${field.required ? "" : "?"}`).join(", ")}`)
  .join("; ");

const SAVE_DESCRIPTION = `Save exactly one polished, final artifact to the user's DraftRelay review inbox. Save only the concise result they will read, copy, send, or act on. Never save chain-of-thought, hidden reasoning, terminal logs, tool traces, raw research dumps, credentials, duplicate drafts, or an entire conversation. Rewrite or extract the useful deliverable first. Typed recipe fields: ${RECIPE_GUIDE}.`;

const provenanceInput = z.object({
  sourceClientVersion: z.string().min(1).max(64).optional(),
  agentName: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(100).optional(),
  sessionId: z.string().min(1).max(240).optional(),
  cwd: z.string().min(1).max(2_000).optional(),
  repoRoot: z.string().min(1).max(2_000).optional(),
  repoRemote: z.string().min(1).max(2_000).optional(),
  branch: z.string().min(1).max(500).optional(),
  commitSha: z.string().min(1).max(100).optional(),
  repoDirty: z.boolean().optional(),
  verificationStatus: z.enum(["unverified", "passed", "partial", "failed"]).optional(),
  verificationSummary: z.string().min(1).max(2_000).optional(),
  referencedFiles: z.array(z.object({
    path: z.string().min(1).max(2_000),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional()
  })).max(50).optional()
}).strict();

export interface CloudMcpOptions {
  store: CloudStore;
  actor: CloudActor;
  scopes: string[];
  publicBaseUrl: string;
  onError?: (error: unknown) => void;
}

function itemUrl(baseUrl: string, item: OutputItem): string {
  return `${baseUrl}/app?item=${encodeURIComponent(item.id)}`;
}

function receipt(options: CloudMcpOptions, item: OutputItem) {
  return {
    id: item.id,
    title: item.title,
    revision: item.currentRevision,
    status: item.status,
    url: itemUrl(options.publicBaseUrl, item),
    project: item.project
  };
}

function toolError(error: unknown): string {
  if (error instanceof z.ZodError) return "The artifact fields are invalid. Check the title, recipe or Markdown, project, and tags.";
  if (error instanceof QuotaExceededError) {
    return `${error.message}.${error.resetAt ? ` This limit resets at ${error.resetAt}.` : ""} Open account settings to review usage or upgrade.`;
  }
  if (error instanceof SecretBlockedError) {
    return `The project secret policy blocked this artifact: ${error.findings.map((finding) => finding.redactedPreview).join("; ")}. Remove the sensitive value and try again.`;
  }
  if (
    error instanceof StaleRevisionError ||
    error instanceof ItemNotFoundError ||
    error instanceof CopyBlockedError ||
    error instanceof IdempotencyConflictError
  ) return error.message;
  return "DraftRelay could not complete the operation.";
}

function denied(scope: string) {
  return {
    content: [{ type: "text" as const, text: `This connection is missing the ${scope} permission. Reconnect DraftRelay and approve that scope.` }],
    isError: true
  };
}

export function createCloudMcpServer(options: CloudMcpOptions): McpServer {
  const server = new McpServer(
    { name: "draftrelay", version: "0.3.0" },
    { instructions: "Use save_output only for a polished, self-contained artifact the user explicitly wants to keep, review, copy, send, or act on. Never save scratch reasoning, logs, transcripts, credentials, or duplicate drafts." }
  );

  server.registerTool("save_output", {
    title: "Save final useful output",
    description: SAVE_DESCRIPTION,
    inputSchema: {
      title: z.string().min(1).max(MAX_TITLE_LENGTH),
      contentMarkdown: z.string().min(1).max(MAX_CONTENT_LENGTH).optional()
        .describe("Copy-ready Markdown. Omit when using recipeId and payload."),
      kind: z.enum(ITEM_KINDS).optional().default("note"),
      recipeId: z.enum(RECIPE_IDS).optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
      project: z.string().min(1).max(80).optional().default("General"),
      tags: z.array(z.string().min(1).max(32)).max(MAX_TAGS).optional().default([]),
      sourceClient: z.string().min(1).max(64).optional().default(options.actor.label),
      provenance: provenanceInput.optional(),
      idempotencyKey: z.string().min(1).max(240).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (arguments_) => {
    if (!options.scopes.includes("outputs:write")) return denied("outputs:write");
    try {
      const item = await options.store.create(options.actor, parseCreateItem(arguments_));
      const result = receipt(options, item);
      return { content: [{ type: "text", text: `Saved “${item.title}” to DraftRelay.\nID: ${item.id}\nRevision: ${item.currentRevision}\nReview: ${result.url}` }], structuredContent: result };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Could not save output: ${toolError(error)}` }], isError: true };
    }
  });

  server.registerTool("read_output", {
    title: "Read a saved output",
    description: "Read the current revision and lifecycle state of one DraftRelay artifact by ID.",
    inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => {
    if (!options.scopes.includes("outputs:read")) return denied("outputs:read");
    const item = await options.store.get(options.actor, id);
    if (!item) return { content: [{ type: "text", text: `Output ${id} was not found.` }], isError: true };
    return {
      content: [{ type: "text", text: `${item.title}\nRevision ${item.currentRevision} · ${item.status}\nProject: ${item.project}\n\n${item.contentMarkdown}` }],
      structuredContent: {
        id: item.id, title: item.title, contentMarkdown: item.contentMarkdown,
        revision: item.currentRevision, status: item.status, recipeId: item.recipeId,
        project: item.project, tags: item.tags, url: itemUrl(options.publicBaseUrl, item)
      }
    };
  });

  server.registerTool("list_outputs", {
    title: "List saved outputs",
    description: "Find recent DraftRelay artifacts by optional project, status, kind, tag, or text query. Returns concise metadata rather than full bodies.",
    inputSchema: {
      query: z.string().min(1).max(200).optional(),
      project: z.string().min(1).max(80).optional(),
      status: z.enum(["new", "reviewed", "copied", "done"]).optional(),
      kind: z.enum(ITEM_KINDS).optional(),
      tag: z.string().min(1).max(32).optional(),
      limit: z.number().int().min(1).max(50).optional().default(20),
      cursor: z.string().min(8).max(500).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ query, project, status, kind, tag, limit, cursor }) => {
    if (!options.scopes.includes("outputs:read")) return denied("outputs:read");
    const result = await options.store.list(options.actor, {
      archived: "all", ...(query ? { q: query } : {}), ...(project ? { project } : {}),
      ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(tag ? { tag } : {}),
      limit, ...(cursor ? { cursor } : {})
    });
    const items = result.items.map((item) => ({
      id: item.id, title: item.title, project: item.project, kind: item.kind,
      status: item.status, revision: item.currentRevision, updatedAt: item.updatedAt,
      url: itemUrl(options.publicBaseUrl, item)
    }));
    return {
      content: [{ type: "text", text: items.length ? items.map((item) => `${item.id} · ${item.title} · ${item.status} · ${item.project}`).join("\n") : "No matching outputs." }],
      structuredContent: { items, count: items.length, nextCursor: result.nextCursor ?? null }
    };
  });

  server.registerTool("revise_output", {
    title: "Revise a saved output",
    description: "Create an immutable new revision. Pass the revision from read_output as baseRevision to avoid overwriting newer work.",
    inputSchema: {
      id: z.string().uuid(),
      contentMarkdown: z.string().min(1).max(MAX_CONTENT_LENGTH),
      title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
      changeNote: z.string().min(1).max(500).optional(),
      baseRevision: z.number().int().positive(),
      sourceClient: z.string().min(1).max(64).optional().default(options.actor.label),
      provenance: provenanceInput.optional(),
      idempotencyKey: z.string().min(1).max(240).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ id, ...arguments_ }) => {
    if (!options.scopes.includes("outputs:write")) return denied("outputs:write");
    try {
      const item = await options.store.createRevision(options.actor, id, parseCreateRevision({ ...arguments_, authorKind: "agent" }));
      const result = receipt(options, item);
      return { content: [{ type: "text", text: `Revised “${item.title}” in DraftRelay.\nRevision: ${item.currentRevision}\nReview: ${result.url}` }], structuredContent: result };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Could not revise output: ${toolError(error)}` }], isError: true };
    }
  });

  server.registerTool("mark_output_used", {
    title: "Mark an output used",
    description: "Record that the user used an output for a destination. This respects review and secret policies. Supply a stable clientEventId when retrying the same action to avoid a duplicate receipt.",
    inputSchema: {
      id: z.string().uuid(),
      destination: z.enum(DESTINATIONS),
      completed: z.boolean().optional().default(false),
      clientEventId: z.string().min(1).max(240).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ id, destination, completed, clientEventId }) => {
    if (!options.scopes.includes("outputs:use")) return denied("outputs:use");
    try {
      const prepared = await options.store.getRepresentation(options.actor, id, destination);
      if (!prepared.copyAllowed) throw new CopyBlockedError(prepared.blockReasons);
      let item = await options.store.recordCopy(options.actor, id, {
        representationId: prepared.id, destination, format: destination, clientEventId
      });
      if (completed && item.status !== "done") item = await options.store.transition(options.actor, id, "done");
      return {
        content: [{ type: "text", text: `Marked “${item.title}” used for ${destination}; status is ${item.status}.` }],
        structuredContent: { id: item.id, revision: item.currentRevision, status: item.status, destination }
      };
    } catch (error: unknown) {
      return { content: [{ type: "text", text: `Could not mark output used: ${toolError(error)}` }], isError: true };
    }
  });

  return server;
}

function sendProtocolError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createCloudMcpRequestHandler(options: CloudMcpOptions) {
  return async (request: Request, response: Response): Promise<void> => {
    const server = createCloudMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    response.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error: unknown) {
      options.onError?.(error);
      if (!response.headersSent) sendProtocolError(response, 500, -32_603, "Internal server error");
    }
  };
}

export const cloudMcpInternals = { RECIPE_GUIDE, SAVE_DESCRIPTION, toolError };
