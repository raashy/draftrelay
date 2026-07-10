import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { ZodError, z } from "zod";

import type { ItemQuery } from "../shared/items.js";
import { loadConfig, type ConfigOverrides, type ServerConfig } from "./config.js";
import { createMcpRequestHandler, methodNotAllowed } from "./mcp.js";
import { localMutationGuard, suppliedOriginGuard } from "./origin.js";
import { applyWorkspacePolicy } from "./policy-file.js";
import { listRecipes } from "./recipes.js";
import {
  CopyBlockedError,
  FindingNotFoundError,
  IdempotencyConflictError,
  ItemNotFoundError,
  ItemStore,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "./store.js";
import {
  destinationSchema,
  parseCopyReceipt,
  parseCreateItem,
  parseCreateRevision,
  parseItemQuery,
  parseProjectPolicyPatch,
  parseSecretPattern,
  parseTransition,
  parseUpdateItem
} from "./validation.js";

const itemIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, "Invalid item ID");
const projectNameSchema = z.string().trim().min(1).max(80);

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
): void {
  const body: ErrorBody = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
  response.status(status).json(body);
}

function isJsonSyntaxError(error: unknown): error is SyntaxError & { status: number } {
  return (
    error instanceof SyntaxError &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status === 400
  );
}

function errorStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return undefined;
}

function routeId(request: Request): string {
  return itemIdSchema.parse(request.params.id);
}

export interface CreateAppOptions extends ConfigOverrides {
  store?: ItemStore;
  onError?: (error: unknown) => void;
  policyFile?: string;
  policySearchFrom?: string | false;
}

export interface AppInstance {
  app: Express;
  config: ServerConfig;
  store: ItemStore;
  close: () => void;
}

export function createApp(options: CreateAppOptions = {}): AppInstance {
  const config = loadConfig(process.env, options);
  const ownsStore = options.store === undefined;

  if (ownsStore && config.databasePath !== ":memory:") {
    mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
  }

  const store = options.store ?? new ItemStore({ databasePath: config.databasePath });
  try {
    applyWorkspacePolicy(store, {
      explicitPath: options.policyFile,
      searchFrom: options.policySearchFrom
    });
  } catch (error: unknown) {
    if (ownsStore) store.close();
    throw error;
  }
  const app = express();
  app.use(hostHeaderValidation([
    config.host === "::1" ? "[::1]" : config.host,
    "localhost"
  ]));
  app.use(express.json({ limit: "256kb", strict: true }));

  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    );
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  const healthHandler = (_request: Request, response: Response): void => {
    if (!store.checkHealth()) {
      sendError(response, 503, "storage_unavailable", "Storage is unavailable");
      return;
    }

    response.json({
      status: "ok",
      storage: "ok",
      timestamp: new Date().toISOString()
    });
  };

  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  const localServerOrigin = new URL(config.publicBaseUrl);
  localServerOrigin.hostname = config.host === "::1" ? "[::1]" : config.host;
  localServerOrigin.port = String(config.port);
  const localOrigins = [config.publicBaseUrl, localServerOrigin.origin];
  app.use("/api", localMutationGuard(localOrigins));

  app.get("/api/items", (request, response, next) => {
    try {
      const query = parseItemQuery(request.query);
      response.json(store.list(query));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/facets", (request, response, next) => {
    try {
      const query: ItemQuery = parseItemQuery(request.query);
      response.json(store.facets(query));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/recipes", (_request, response) => {
    response.json({ recipes: listRecipes() });
  });

  app.get("/api/projects", (_request, response, next) => {
    try {
      response.json({ projects: store.listProjects() });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/projects/:project/policy", (request, response, next) => {
    try {
      const project = projectNameSchema.parse(request.params.project);
      response.json(store.getProjectPolicy(project));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.patch("/api/projects/:project/policy", (request, response, next) => {
    try {
      const project = projectNameSchema.parse(request.params.project);
      const patch = parseProjectPolicyPatch(request.body);
      response.json(store.updateProjectPolicy(project, patch));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/projects/:project/secret-patterns", (request, response, next) => {
    try {
      const project = projectNameSchema.parse(request.params.project);
      response.json({ patterns: store.listSecretPatterns(project) });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/projects/:project/secret-patterns", (request, response, next) => {
    try {
      const project = projectNameSchema.parse(request.params.project);
      response.status(201).json(store.addSecretPattern(project, parseSecretPattern(request.body)));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.delete("/api/projects/:project/secret-patterns/:patternId", (request, response, next) => {
    try {
      const project = projectNameSchema.parse(request.params.project);
      const patternId = itemIdSchema.parse(request.params.patternId);
      if (!store.deleteSecretPattern(project, patternId)) {
        sendError(response, 404, "not_found", `Secret pattern ${patternId} was not found`);
        return;
      }
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/items/:id", (request, response, next) => {
    try {
      const id = routeId(request);
      const item = store.get(id);
      if (item === undefined) {
        throw new ItemNotFoundError(id);
      }
      response.json(item);
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/items/:id/revisions", (request, response, next) => {
    try {
      const id = routeId(request);
      response.json({ revisions: store.listRevisions(id) });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/items/:id/revisions", (request, response, next) => {
    try {
      const id = routeId(request);
      const input = parseCreateRevision(request.body);
      response.status(201).json(store.createRevision(id, input));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/items/:id/transitions", (request, response, next) => {
    try {
      const id = routeId(request);
      response.json(store.transition(id, parseTransition(request.body)));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/items/:id/representations/:destination", (request, response, next) => {
    try {
      const id = routeId(request);
      const destination = destinationSchema.parse(request.params.destination);
      response.json(store.getRepresentation(id, destination));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/items/:id/copy-receipts", (request, response, next) => {
    try {
      const id = routeId(request);
      response.json(store.recordCopy(id, parseCopyReceipt(request.body)));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.get("/api/items/:id/findings", (request, response, next) => {
    try {
      const id = routeId(request);
      response.json({ findings: store.getFindings(id) });
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/items/:id/findings/:findingId/acknowledge", (request, response, next) => {
    try {
      const id = routeId(request);
      const findingId = itemIdSchema.parse(request.params.findingId);
      const actor = z
        .object({ actor: z.string().trim().min(1).max(100).optional() })
        .strict()
        .parse(request.body ?? {}).actor;
      response.json(store.acknowledgeFinding(id, findingId, actor));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.post("/api/items", (request, response, next) => {
    try {
      const input = parseCreateItem(request.body);
      response.status(201).json(store.create(input));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.patch("/api/items/:id", (request, response, next) => {
    try {
      const id = routeId(request);
      const input = parseUpdateItem(request.body);
      response.json(store.update(id, input));
    } catch (error: unknown) {
      next(error);
    }
  });

  app.delete("/api/items/:id", (request, response, next) => {
    try {
      const id = routeId(request);
      if (!store.delete(id)) {
        throw new ItemNotFoundError(id);
      }
      response.status(204).end();
    } catch (error: unknown) {
      next(error);
    }
  });

  app.use(
    "/mcp",
    suppliedOriginGuard(localOrigins)
  );
  app.post(
    "/mcp",
    createMcpRequestHandler({
      store,
      publicBaseUrl: config.publicBaseUrl,
      onError: options.onError
    })
  );
  app.all("/mcp", methodNotAllowed);

  app.use("/api", (_request, response) => {
    sendError(response, 404, "not_found", "API route not found");
  });

  if (config.isProduction) {
    app.use(express.static(config.staticDir, { index: false }));
    app.use((request, response, next) => {
      if (request.method !== "GET" || !request.accepts("html")) {
        next();
        return;
      }

      const indexPath = path.join(config.staticDir, "index.html");
      if (!existsSync(indexPath)) {
        next();
        return;
      }

      response.sendFile(indexPath);
    });
  }

  app.use((_request, response) => {
    sendError(response, 404, "not_found", "Route not found");
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    request: Request,
    response: Response,
    _next: NextFunction
  ): void => {
    options.onError?.(error);

    if (response.headersSent) {
      return;
    }

    if (request.path === "/mcp") {
      const status = errorStatus(error) === 413 ? 413 : 400;
      response.status(status).json({
        jsonrpc: "2.0",
        error: {
          code: isJsonSyntaxError(error) ? -32_700 : -32_600,
          message:
            status === 413
              ? "Request body is too large"
              : isJsonSyntaxError(error)
                ? "Parse error"
                : "Invalid request"
        },
        id: null
      });
      return;
    }

    if (error instanceof ZodError) {
      sendError(response, 400, "validation_error", "Request validation failed", error.issues);
      return;
    }

    if (error instanceof ItemNotFoundError) {
      sendError(response, 404, "not_found", error.message);
      return;
    }

    if (error instanceof FindingNotFoundError) {
      sendError(response, 404, "not_found", error.message);
      return;
    }

    if (error instanceof StaleRevisionError) {
      sendError(response, 409, "stale_revision", error.message, {
        currentRevision: error.currentRevision
      });
      return;
    }

    if (error instanceof IdempotencyConflictError) {
      sendError(response, 409, "idempotency_conflict", error.message);
      return;
    }

    if (error instanceof SecretBlockedError) {
      sendError(response, 422, "secret_detected", error.message, {
        findings: error.findings
      });
      return;
    }

    if (error instanceof CopyBlockedError) {
      sendError(response, 409, "copy_blocked", error.message, { reasons: error.reasons });
      return;
    }

    if (error instanceof SecretPatternLimitError) {
      sendError(response, 409, "secret_pattern_limit", error.message, { limit: error.limit });
      return;
    }

    if (isJsonSyntaxError(error)) {
      sendError(response, 400, "invalid_json", "Request body contains invalid JSON");
      return;
    }

    if (errorStatus(error) === 413) {
      sendError(response, 413, "payload_too_large", "Request body is too large");
      return;
    }

    sendError(response, 500, "internal_error", "An unexpected error occurred");
  };

  app.use(errorHandler);

  return {
    app,
    config,
    store,
    close: () => {
      if (ownsStore) {
        store.close();
      }
    }
  };
}

export const appInternals = {
  errorStatus,
  isJsonSyntaxError,
  itemIdSchema,
  projectNameSchema,
  sendError
};
