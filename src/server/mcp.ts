import type { Request, Response } from "express";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  createCutlineCardStructuredContent,
  createCutlineCardToolMeta,
  registerCutlineCardResource
} from "../mcp-app/index.js";
import {
  DESTINATIONS,
  ITEM_KINDS,
  RECIPE_IDS,
  type OutputItem
} from "../shared/items.js";
import { listRecipes } from "./recipes.js";
import {
  CopyBlockedError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  StaleRevisionError,
  type ItemStore
} from "./store.js";
import {
  MAX_CONTENT_LENGTH,
  MAX_TAGS,
  MAX_TITLE_LENGTH,
  parseCreateItem,
  parseCreateRevision
} from "./validation.js";

const RECIPE_GUIDE = listRecipes()
  .filter((recipe) => !recipe.id.startsWith("generic_"))
  .map(
    (recipe) =>
      `${recipe.id}: ${recipe.fields.map((field) => `${field.name}${field.required ? "" : "?"}`).join(", ")}`
  )
  .join("; ");

const SAVE_OUTPUT_DESCRIPTION = `Save exactly one polished, final, human-useful artifact to the local DraftRelay inbox. Use this only for the concise result the user will actually read, copy, send, or act on. Do not save chain-of-thought, reasoning, terminal logs, command output, tool traces, status updates, raw research dumps, duplicate drafts, or an entire conversation. Rewrite or extract the useful final artifact first, then save only that artifact. For a typed deliverable, provide recipeId and payload instead of contentMarkdown. Recipe fields: ${RECIPE_GUIDE}.`;

const provenanceInput = z
  .object({
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
    referencedFiles: z
      .array(
        z.object({
          path: z.string().min(1).max(2_000),
          lineStart: z.number().int().positive().optional(),
          lineEnd: z.number().int().positive().optional()
        })
      )
      .max(50)
      .optional()
  })
  .strict();

const receiptSchema = {
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  revision: z.number().int(),
  status: z.enum(["new", "reviewed", "copied", "done"]),
  item: z.object({
    id: z.string(),
    title: z.string(),
    contentMarkdown: z.string(),
    kind: z.string(),
    project: z.string(),
    tags: z.array(z.string()),
    createdAt: z.string(),
    url: z.string().url()
  })
};

export interface McpServerOptions {
  store: ItemStore;
  publicBaseUrl: string;
  defaultSourceClient?: string;
}

function itemUrl(options: McpServerOptions, item: OutputItem): string {
  return `${options.publicBaseUrl}/?item=${encodeURIComponent(item.id)}`;
}

function receipt(options: McpServerOptions, item: OutputItem) {
  const url = itemUrl(options, item);
  return {
    id: item.id,
    url,
    title: item.title,
    revision: item.currentRevision,
    status: item.status,
    ...createCutlineCardStructuredContent(item, url)
  };
}

function safeToolError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "The artifact fields are invalid. Check the title, recipe or Markdown, project, and tags.";
  }
  if (error instanceof SecretBlockedError) {
    return `The project secret policy blocked this output: ${error.findings
      .map((finding) => finding.redactedPreview)
      .join("; ")}.`;
  }
  if (error instanceof StaleRevisionError) {
    return error.message;
  }
  if (
    error instanceof ItemNotFoundError ||
    error instanceof CopyBlockedError ||
    error instanceof IdempotencyConflictError
  ) {
    return error.message;
  }
  return "Local storage could not complete the operation.";
}

export function createOutputMcpServer(options: McpServerOptions): McpServer {
  const defaultSourceClient = options.defaultSourceClient ?? "mcp";
  const server = new McpServer(
    { name: "draftrelay", version: "0.3.0" },
    {
      instructions:
        "Use save_output when the user asks to save, pin, capture, or keep a final artifact. Use revise_output to replace an existing deliverable without making a duplicate. Save one polished, self-contained artifact per call. Never save scratch reasoning, command logs, entire transcripts, credentials, secrets, or duplicate drafts."
    }
  );

  registerCutlineCardResource(server, registerAppResource);

  registerAppTool(
    server,
    "save_output",
    {
      title: "Save final useful output",
      description: SAVE_OUTPUT_DESCRIPTION,
      inputSchema: {
        title: z.string().min(1).max(MAX_TITLE_LENGTH),
        contentMarkdown: z
          .string()
          .min(1)
          .max(MAX_CONTENT_LENGTH)
          .optional()
          .describe("Legacy/free-form copy-ready Markdown. Omit when using recipeId + payload."),
        kind: z.enum(ITEM_KINDS).optional().default("note"),
        recipeId: z
          .enum(RECIPE_IDS)
          .optional()
          .describe("Typed recipe. Supply its payload and omit contentMarkdown."),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(`Recipe-specific fields. ${RECIPE_GUIDE}`),
        project: z.string().min(1).max(80).optional().default("General"),
        tags: z.array(z.string().min(1).max(32)).max(MAX_TAGS).optional().default([]),
        sourceClient: z.string().min(1).max(64).optional().default(defaultSourceClient),
        provenance: provenanceInput.optional(),
        idempotencyKey: z.string().min(1).max(240).optional()
      },
      outputSchema: receiptSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: createCutlineCardToolMeta() as unknown as Record<string, unknown> & {
        ui: ReturnType<typeof createCutlineCardToolMeta>["ui"];
      }
    },
    async (arguments_) => {
      try {
        const item = options.store.create(parseCreateItem(arguments_));
        const result = receipt(options, item);
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved “${item.title}” to DraftRelay.\nID: ${item.id}\nRevision: ${item.currentRevision}\nURL: ${result.url}`
            }
          ],
          structuredContent: result
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text" as const, text: `Could not save output: ${safeToolError(error)}` }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "read_output",
    {
      title: "Read a DraftRelay output",
      description: "Read the current revision and lifecycle state of one saved output by ID.",
      inputSchema: { id: z.string().min(1).max(100) },
      outputSchema: {
        id: z.string(),
        title: z.string(),
        contentMarkdown: z.string(),
        revision: z.number().int(),
        status: z.enum(["new", "reviewed", "copied", "done"]),
        recipeId: z.enum(RECIPE_IDS),
        project: z.string()
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ id }) => {
      const item = options.store.get(id);
      if (item === undefined) {
        return {
          content: [{ type: "text" as const, text: `Output ${id} was not found.` }],
          isError: true
        };
      }
      const structuredContent = {
        id: item.id,
        title: item.title,
        contentMarkdown: item.contentMarkdown,
        revision: item.currentRevision,
        status: item.status,
        recipeId: item.recipeId,
        project: item.project
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `${item.title}\nRevision ${item.currentRevision} · ${item.status}\n\n${item.contentMarkdown}`
          }
        ],
        structuredContent
      };
    }
  );

  server.registerTool(
    "revise_output",
    {
      title: "Revise a DraftRelay output",
      description:
        "Create an immutable new revision of an existing output. Pass the revision returned by read_output as baseRevision to prevent overwriting newer work.",
      inputSchema: {
        id: z.string().min(1).max(100),
        contentMarkdown: z.string().min(1).max(MAX_CONTENT_LENGTH),
        title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
        changeNote: z.string().min(1).max(500).optional(),
        baseRevision: z.number().int().positive(),
        sourceClient: z.string().min(1).max(64).optional().default(defaultSourceClient),
        provenance: provenanceInput.optional(),
        idempotencyKey: z.string().min(1).max(240).optional()
      },
      outputSchema: receiptSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ id, ...arguments_ }) => {
      try {
        const input = parseCreateRevision({ ...arguments_, authorKind: "agent" });
        const item = options.store.createRevision(id, input);
        const result = receipt(options, item);
        return {
          content: [
            {
              type: "text" as const,
              text: `Revised “${item.title}” in DraftRelay.\nRevision: ${item.currentRevision}\nURL: ${result.url}`
            }
          ],
          structuredContent: result
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text" as const, text: `Could not revise output: ${safeToolError(error)}` }],
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "mark_output_used",
    {
      title: "Mark a DraftRelay output used",
      description:
        "Record that the user copied or used an output for a destination. This respects review and secret policies. Supply a stable clientEventId when retrying the same action to avoid a duplicate receipt.",
      inputSchema: {
        id: z.string().min(1).max(100),
        destination: z.enum(DESTINATIONS),
        completed: z.boolean().optional().default(false),
        clientEventId: z.string().min(1).max(240).optional()
      },
      outputSchema: {
        id: z.string(),
        revision: z.number().int(),
        status: z.enum(["new", "reviewed", "copied", "done"]),
        destination: z.enum(DESTINATIONS)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ id, destination, completed, clientEventId }) => {
      try {
        const representation = options.store.getRepresentation(id, destination);
        if (!representation.copyAllowed) {
          throw new CopyBlockedError(representation.blockReasons);
        }
        let item = options.store.recordCopy(id, {
          representationId: representation.id,
          destination,
          format: destination,
          clientEventId,
          actorLabel: defaultSourceClient
        });
        if (completed && item.status !== "done") {
          item = options.store.transition(id, "done", "agent", defaultSourceClient);
        }
        const structuredContent = {
          id: item.id,
          revision: item.currentRevision,
          status: item.status,
          destination
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Marked “${item.title}” used for ${destination}; status is ${item.status}.`
            }
          ],
          structuredContent
        };
      } catch (error: unknown) {
        return {
          content: [{ type: "text" as const, text: `Could not mark output used: ${safeToolError(error)}` }],
          isError: true
        };
      }
    }
  );

  return server;
}

function sendProtocolError(response: Response, status: number, code: number, message: string): void {
  response.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function methodNotAllowed(_request: Request, response: Response): void {
  response.setHeader("Allow", "POST");
  sendProtocolError(response, 405, -32_600, "Method not allowed. Use POST for Streamable HTTP.");
}

export interface McpRequestHandlerOptions extends McpServerOptions {
  onError?: (error: unknown) => void;
}

export function createMcpRequestHandler(options: McpRequestHandlerOptions) {
  return async (request: Request, response: Response): Promise<void> => {
    const server = createOutputMcpServer(options);
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
      if (!response.headersSent) {
        sendProtocolError(response, 500, -32_603, "Internal server error");
      }
    }
  };
}

export const mcpInternals = {
  RECIPE_GUIDE,
  SAVE_OUTPUT_DESCRIPTION,
  safeToolError
};
