import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
  type ResourceServerMetadata
} from "@better-auth/oauth-provider";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { createAuthClient } from "better-auth/client";
import { toNodeHandler } from "better-auth/node";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import type { Logger } from "pino";
import { ZodError, z } from "zod";

import type { Destination, ItemQuery } from "../shared/items.js";
import { listRecipes } from "../server/recipes.js";
import { suppliedOriginGuard } from "../server/origin.js";
import {
  CopyBlockedError,
  FindingNotFoundError,
  IdempotencyConflictError,
  ItemNotFoundError,
  SecretBlockedError,
  SecretPatternLimitError,
  StaleRevisionError
} from "../server/errors.js";
import {
  destinationSchema,
  parseCopyReceipt,
  parseCreateItem,
  parseCreateRevision,
  parseItemQuery,
  parseProjectPolicyPatch,
  parseSecretPattern,
  parseTransition
} from "../server/validation.js";
import type { CloudAuth } from "./auth.js";
import type { CloudConfig } from "./config.js";
import type { CloudDatabase } from "./db.js";
import {
  allowedHostMiddleware,
  type AccessTokenPayload,
  type AccessTokenVerifier,
  createCloudLogger,
  createMcpAuthMiddleware,
  exactOriginCsrf,
  type McpLocals,
  requestIdMiddleware,
  requestLoggingMiddleware,
  type RequestLocals,
  requireSession,
  securityHeaders,
  type SessionLocals,
  trustedClientIpMiddleware
} from "./security.js";
import { createCloudMcpRequestHandler } from "./mcp.js";
import {
  PUBLIC_PAGE_PATHS,
  renderLlmsTxt,
  renderPublicPage,
  renderRobotsTxt,
  renderSitemapXml
} from "./public-pages.js";
import type { CloudRateLimits } from "./rate-limit.js";
import {
  CloudStore,
  QuotaExceededError,
  WorkspaceSuspendedError,
  type CloudActor
} from "./store.js";

const MCP_SCOPES: string[] = [];
const RESOURCE_SCOPES = ["outputs:read", "outputs:write", "outputs:use"];
const CLOUD_APP_ROUTES = [
  "/login",
  "/signup",
  "/reset-password",
  "/consent",
  "/app",
  "/account"
];

export interface CloudDatabaseHealth {
  query: CloudDatabase["query"];
}

export interface OAuthResourceClient extends AccessTokenVerifier {
  getProtectedResourceMetadata: (overrides: {
    resource: string;
    authorization_servers: string[];
    jwks_uri: string;
    scopes_supported: string[];
    bearer_methods_supported: ["header"];
    resource_name: string;
  }) => Promise<ResourceServerMetadata>;
}

type WebHandler = (request: globalThis.Request) => Promise<globalThis.Response>;

export interface CreateCloudAppOptions {
  config: CloudConfig;
  database: CloudDatabaseHealth;
  schemaAttestation?: () => Promise<void>;
  readinessChecks?: Array<() => Promise<void>>;
  stripeWebhookHandler?: RequestHandler;
  stripeCheckoutHandler?: RequestHandler;
  stripeReconcileUser?: (userId: string) => Promise<void>;
  auth: CloudAuth;
  logger?: Logger;
  oauthResourceClient?: OAuthResourceClient;
  authorizationMetadataHandler?: WebHandler;
  openIdMetadataHandler?: WebHandler;
  staticDir?: string;
  store?: CloudStore;
  rateLimits?: Pick<CloudRateLimits, "api" | "mcp">;
}

export interface CloudAppInstance {
  app: Express;
  logger: Logger;
}

function createOAuthResourceClient(auth: CloudAuth): OAuthResourceClient {
  const client = createAuthClient({
    plugins: [oauthProviderResourceClient(auth)]
  });

  return {
    async verifyAccessToken(token, options): Promise<AccessTokenPayload> {
      return client.verifyBearerToken(token, options);
    },
    async getProtectedResourceMetadata(overrides): Promise<ResourceServerMetadata> {
      return client.getProtectedResourceMetadata(overrides);
    }
  };
}

function webRequest(request: Request, config: CloudConfig): globalThis.Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.append(name, value);
    else if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    }
  }

  return new globalThis.Request(new URL(request.originalUrl, config.appUrl), {
    method: request.method,
    headers
  });
}

async function sendWebResponse(response: Response, webResponse: globalThis.Response): Promise<void> {
  response.status(webResponse.status);
  for (const [name, value] of webResponse.headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  }

  const cookieHeaders = (
    webResponse.headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();
  if (cookieHeaders && cookieHeaders.length > 0) response.setHeader("Set-Cookie", cookieHeaders);

  const body = Buffer.from(await webResponse.arrayBuffer());
  response.send(body);
}

function wrapWebHandler(handler: WebHandler, config: CloudConfig) {
  return async (request: Request, response: Response, next: (error?: unknown) => void) => {
    try {
      await sendWebResponse(response, await handler(webRequest(request, config)));
    } catch (error: unknown) {
      next(error);
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlTemplateHandler(staticDir: string, config: CloudConfig) {
  return async (_request: Request, response: Response, next: (error?: unknown) => void) => {
    try {
      const template = await readFile(path.join(staticDir, "cloud.html"), "utf8");
      const html = template
        .replaceAll("__APP_URL__", escapeHtml(config.appUrl))
        .replaceAll("__APP_NAME__", escapeHtml(config.appName));
      response.setHeader(
        "Cache-Control",
        config.environment === "production"
          ? "public, max-age=300, stale-while-revalidate=300, stale-if-error=86400"
          : "no-cache"
      );
      response.type("html").send(html);
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        response.status(404).type("text").send("Cloud frontend has not been built");
        return;
      }
      next(error);
    }
  };
}

function cloudAppHandler(staticDir: string) {
  return (_request: Request, response: Response, next: (error?: unknown) => void) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile("cloud-app.html", { root: staticDir }, (error) => {
      if (!error) return;
      if (isMissingFile(error)) {
        if (!response.headersSent) {
          response.status(404).type("text").send("Cloud application has not been built");
        }
        return;
      }
      next(error);
    });
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EISDIR")
  );
}

function publicError(
  response: Response<unknown, Partial<RequestLocals>>,
  code: string,
  message: string
) {
  return {
    error: {
      code,
      message,
      ...(response.locals.requestId ? { requestId: response.locals.requestId } : {})
    }
  };
}

function jsonSyntaxError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 400
  );
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error &&
    typeof error.status === "number" ? error.status : undefined;
}

const itemIdSchema = z.string().uuid();
const projectNameSchema = z.string().trim().min(1).max(80);

function sessionActor(
  request: Request,
  response: Response<unknown, SessionLocals>
): CloudActor {
  return {
    userId: response.locals.auth.user.id,
    name: response.locals.auth.user.name,
    kind: "human",
    label: "web-ui",
    requestId: response.locals.requestId,
    ipAddress: request.ip,
    userAgent: request.get("user-agent")
  };
}

function mcpActor(
  request: Request,
  response: Response<unknown, McpLocals>
): CloudActor {
  return {
    userId: response.locals.mcp.userId,
    name: "MCP user",
    kind: "agent",
    label: response.locals.mcp.clientId ?? "mcp",
    ...(response.locals.mcp.clientId ? { oauthClientId: response.locals.mcp.clientId } : {}),
    requestId: response.locals.requestId,
    ipAddress: request.ip,
    userAgent: request.get("user-agent")
  };
}

function apiErrorBody(
  response: Response<unknown, Partial<RequestLocals>>,
  code: string,
  message: string,
  details?: unknown
) {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(response.locals.requestId ? { requestId: response.locals.requestId } : {})
    }
  };
}

export function createCloudApp(options: CreateCloudAppOptions): CloudAppInstance {
  const { auth, config, database } = options;
  if (config.environment === "production" && !options.schemaAttestation) {
    throw new Error("Production startup requires cloud schema attestation");
  }
  if (
    config.environment === "production" &&
    (!options.stripeWebhookHandler || !options.stripeCheckoutHandler || !options.stripeReconcileUser)
  ) {
    throw new Error("Production startup requires owned Stripe billing handlers");
  }
  const logger = options.logger ?? createCloudLogger(config);
  const staticDir = path.resolve(options.staticDir ?? "dist/client");
  const oauthResource = options.oauthResourceClient ?? createOAuthResourceClient(auth);
  const authorizationMetadata =
    options.authorizationMetadataHandler ?? oauthProviderAuthServerMetadata(auth);
  const openIdMetadata =
    options.openIdMetadataHandler ?? oauthProviderOpenIdConfigMetadata(auth);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustedProxyIps.length > 0 ? config.trustedProxyIps : false);

  app.use(trustedClientIpMiddleware());
  app.use(requestIdMiddleware());
  app.use(requestLoggingMiddleware(logger));
  app.use(securityHeaders(config));

  app.get(["/health", "/health/live"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ status: "ok" });
  });
  const checkReadiness = async (): Promise<void> => {
    await database.query("SELECT 1");
    await options.schemaAttestation?.();
    for (const check of options.readinessChecks ?? []) await check();
  };
  app.get("/api/health", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    try {
      await checkReadiness();
      response.json({ status: "ok", storage: "ok", timestamp: new Date().toISOString() });
    } catch {
      response.status(503).json({
        status: "unavailable",
        storage: "unavailable",
        timestamp: new Date().toISOString()
      });
    }
  });

  app.get("/health/ready", async (_request, response, next) => {
    try {
      await checkReadiness();
      response.setHeader("Cache-Control", "no-store");
      response.json({ status: "ok" });
    } catch (error: unknown) {
      logger.error({ err: error }, "Cloud readiness check failed");
      response.setHeader("Cache-Control", "no-store");
      response.status(503).json({ status: "unavailable" });
    }
  });

  // Health probes commonly use a loopback Host header inside the container.
  // Keep their payloads content-free, then validate Host on every product,
  // authentication, OAuth, API, and MCP route below.
  app.use(allowedHostMiddleware(config));
  app.get("/api/public-config", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    response.json({
      appName: config.appName,
      ...(config.turnstile?.siteKey
        ? { turnstile: { siteKey: config.turnstile.siteKey } }
        : {})
    });
  });

  // Some MCP clients discover from the origin root even when the issuer has a path.
  app.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth"
    ],
    wrapWebHandler(authorizationMetadata, config)
  );
  app.get("/.well-known/openid-configuration", wrapWebHandler(openIdMetadata, config));

  if (options.stripeWebhookHandler) {
    app.post(
      "/api/auth/stripe/webhook",
      express.raw({ type: "application/json", limit: "256kb" }),
      options.stripeWebhookHandler
    );
  }
  if (options.stripeCheckoutHandler) {
    app.post(
      "/api/auth/subscription/upgrade",
      express.json({ limit: "16kb", strict: true }),
      options.stripeCheckoutHandler
    );
  }

  // Better Auth must receive the raw request body before any JSON middleware.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  const publicPageOptions = {
    appUrl: config.appUrl,
    appName: config.appName,
    legalName: config.legal.name,
    legalEmail: config.legal.email,
    jurisdiction: config.legal.jurisdiction,
    effectiveDate: config.legal.effectiveDate
  };
  app.get([...PUBLIC_PAGE_PATHS], (request, response) => {
    const html = renderPublicPage(request.path, publicPageOptions);
    if (!html) {
      response.status(404).type("text").send("Page not found");
      return;
    }
    response.setHeader(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=300, stale-if-error=86400"
    );
    response.type("html").send(html);
  });
  app.get("/sitemap.xml", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    response.type("application/xml").send(renderSitemapXml(publicPageOptions));
  });
  app.get("/robots.txt", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    response.type("text/plain").send(renderRobotsTxt(publicPageOptions));
  });
  app.get("/llms.txt", (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    response.type("text/plain").send(renderLlmsTxt(publicPageOptions));
  });

  const protectedResourceHandler = async (
    _request: Request,
    response: Response,
    next: (error?: unknown) => void
  ) => {
    try {
      const metadata = await oauthResource.getProtectedResourceMetadata({
        resource: config.mcpUrl,
        authorization_servers: [config.authUrl],
        jwks_uri: `${config.authUrl}/jwks`,
        scopes_supported: RESOURCE_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: `${config.appName} MCP`
      });
      response.setHeader(
        "Cache-Control",
        "public, max-age=300, stale-while-revalidate=300, stale-if-error=86400"
      );
      response.json(metadata);
    } catch (error: unknown) {
      next(error);
    }
  };
  app.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    protectedResourceHandler
  );

  app.use(express.json({ limit: "256kb", strict: true }));

  app.all(
    "/mcp",
    suppliedOriginGuard([config.appUrl]),
    ...(options.rateLimits ? [options.rateLimits.mcp] : []),
    createMcpAuthMiddleware(config, oauthResource, MCP_SCOPES),
    async (request, response: Response<unknown, McpLocals>, next) => {
      if (!options.store) {
        response.status(501).json(
          publicError(
            response,
            "mcp_transport_not_connected",
            "The hosted MCP transport is not connected yet"
          )
        );
        return;
      }
      const actor = mcpActor(request, response);
      try {
        const clientId = response.locals.mcp.clientId;
        if (!clientId || !await options.store.isOAuthConnectionActive(response.locals.mcp.userId, clientId)) {
          response.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${config.appUrl}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`
          );
          response.status(401).json(publicError(response, "connection_revoked", "This MCP connection has been revoked"));
          return;
        }
        await options.store.consumeMcpRequest(actor);
      } catch (error: unknown) {
        next(error);
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        response.status(405).json({
          jsonrpc: "2.0",
          error: { code: -32_600, message: "Method not allowed. Use POST for Streamable HTTP." },
          id: null
        });
        return;
      }
      void createCloudMcpRequestHandler({
        store: options.store,
        actor,
        scopes: response.locals.mcp.scopes,
        publicBaseUrl: config.appUrl,
        onError: (error) => logger.error({ err: error }, "Hosted MCP request failed")
      })(request, response).catch(next);
    }
  );

  const protectedApi = express.Router();
  protectedApi.use((_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");
    next();
  });
  if (options.rateLimits) protectedApi.use(options.rateLimits.api);
  protectedApi.use(exactOriginCsrf(config));
  protectedApi.use(requireSession(auth));
  protectedApi.get("/me", (_request, response: Response<unknown, SessionLocals>) => {
    response.json({ user: response.locals.auth.user });
  });
  if (options.store) {
    const store = options.store;
    protectedApi.get("/usage", async (request, response: Response<unknown, SessionLocals>, next) => {
      try { response.json(await store.usage(sessionActor(request, response))); }
      catch (error: unknown) { next(error); }
    });
    protectedApi.get("/billing/subscriptions", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const actor = sessionActor(request, response);
        if (options.stripeReconcileUser) {
          try {
            await options.stripeReconcileUser(actor.userId);
          } catch (error: unknown) {
            request.log?.warn(
              { err: error, userId: actor.userId },
              "Authoritative Stripe account reconciliation failed"
            );
            response.status(503).json({
              error: {
                code: "billing_state_unavailable",
                message: "Billing state could not be verified. No checkout was started."
              }
            });
            return;
          }
        }
        response.json({ subscriptions: await store.billingSubscriptions(actor) });
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/account/export", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const date = new Date().toISOString().slice(0, 10);
        response.setHeader("Content-Disposition", `attachment; filename="draftrelay-export-${date}.json"`);
        response.status(200).type("application/json");
        response.flushHeaders();
        await store.streamExportData(sessionActor(request, response), (chunk) => new Promise<void>(
          (resolve, reject) => {
            if (response.destroyed) {
              reject(new Error("Account export connection closed"));
              return;
            }
            response.write(chunk, (error?: Error | null) => {
              if (error) reject(error);
              else resolve();
            });
          }
        ));
        response.end();
      } catch (error: unknown) {
        if (response.headersSent) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        } else {
          next(error);
        }
      }
    });
    protectedApi.get("/oauth/connections", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        response.json({ connections: await store.listOAuthConnections(sessionActor(request, response)) });
      } catch (error: unknown) { next(error); }
    });
    protectedApi.delete("/oauth/connections/:consentId", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const consentId = itemIdSchema.parse(request.params.consentId);
        if (!await store.revokeOAuthConnection(sessionActor(request, response), consentId)) {
          throw new FindingNotFoundError(consentId);
        }
        response.status(204).end();
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/recipes", (_request, response) => response.json({ recipes: listRecipes() }));
    protectedApi.get("/items", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const query: ItemQuery = parseItemQuery(request.query);
        response.json(await store.list(sessionActor(request, response), query));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/facets", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const result = await store.list(sessionActor(request, response), parseItemQuery(request.query));
        response.json(result.facets);
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/items/:id", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        const item = await store.get(sessionActor(request, response), id);
        if (!item) throw new ItemNotFoundError(id);
        response.json(item);
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/items", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        response.status(201).json(await store.create(sessionActor(request, response), parseCreateItem(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/items/:id/revisions", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        response.json({ revisions: await store.listRevisions(sessionActor(request, response), id) });
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/items/:id/revisions", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        response.status(201).json(await store.createRevision(sessionActor(request, response), id, parseCreateRevision(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/items/:id/transitions", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        response.json(await store.transition(sessionActor(request, response), id, parseTransition(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/items/:id/representations/:destination", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        const destination: Destination = destinationSchema.parse(request.params.destination);
        response.json(await store.getRepresentation(sessionActor(request, response), id, destination));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/items/:id/copy-receipts", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        response.json(await store.recordCopy(sessionActor(request, response), id, parseCopyReceipt(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/items/:id/findings", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        response.json({ findings: await store.getFindings(sessionActor(request, response), id) });
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/items/:id/findings/:findingId/acknowledge", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        const findingId = itemIdSchema.parse(request.params.findingId);
        response.json(await store.acknowledgeFinding(sessionActor(request, response), id, findingId));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.delete("/items/:id", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const id = itemIdSchema.parse(request.params.id);
        if (!await store.delete(sessionActor(request, response), id)) throw new ItemNotFoundError(id);
        response.status(204).end();
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/projects", async (request, response: Response<unknown, SessionLocals>, next) => {
      try { response.json({ projects: await store.listProjects(sessionActor(request, response)) }); }
      catch (error: unknown) { next(error); }
    });
    protectedApi.get("/projects/:project/policy", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const project = projectNameSchema.parse(request.params.project);
        response.json(await store.getProjectPolicy(sessionActor(request, response), project));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.patch("/projects/:project/policy", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const project = projectNameSchema.parse(request.params.project);
        response.json(await store.updateProjectPolicy(sessionActor(request, response), project, parseProjectPolicyPatch(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.get("/projects/:project/secret-patterns", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const project = projectNameSchema.parse(request.params.project);
        response.json({ patterns: await store.listSecretPatterns(sessionActor(request, response), project) });
      } catch (error: unknown) { next(error); }
    });
    protectedApi.post("/projects/:project/secret-patterns", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const project = projectNameSchema.parse(request.params.project);
        response.status(201).json(await store.addSecretPattern(sessionActor(request, response), project, parseSecretPattern(request.body)));
      } catch (error: unknown) { next(error); }
    });
    protectedApi.delete("/projects/:project/secret-patterns/:patternId", async (request, response: Response<unknown, SessionLocals>, next) => {
      try {
        const project = projectNameSchema.parse(request.params.project);
        const patternId = itemIdSchema.parse(request.params.patternId);
        if (!await store.deleteSecretPattern(sessionActor(request, response), project, patternId)) {
          throw new FindingNotFoundError(patternId);
        }
        response.status(204).end();
      } catch (error: unknown) { next(error); }
    });
  }
  app.use("/api", protectedApi);

  app.get("/", htmlTemplateHandler(staticDir, config));
  for (const route of CLOUD_APP_ROUTES) app.get(route, cloudAppHandler(staticDir));
  app.get("/assets/cloud.css", (_request, response, next) => {
    response.setHeader(
      "Cache-Control",
      config.environment === "production" ? "public, max-age=300" : "no-cache"
    );
    response.sendFile("assets/cloud.css", { root: staticDir }, (error) => {
      if (!error) return;
      next(error);
    });
  });
  app.use(
    "/assets",
    express.static(path.join(staticDir, "assets"), {
      fallthrough: true,
      immutable: config.environment === "production",
      maxAge: config.environment === "production" ? "1y" : 0,
      index: false
    })
  );
  app.use(
    express.static(staticDir, {
      fallthrough: true,
      immutable: false,
      maxAge: config.environment === "production" ? "1h" : 0,
      index: false
    })
  );

  app.use((_request, response) => {
    response.status(404).json(publicError(response, "not_found", "The requested route was not found"));
  });

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    const status = errorStatus(error);
    const rejectedRequestBody = jsonSyntaxError(error) || status === 413;
    if (rejectedRequestBody) {
      // body-parser attaches the raw request body to parse errors. Never pass
      // that error object to the logger: an invalid artifact can still contain
      // credentials or private client text.
      request.log?.warn(
        {
          code: jsonSyntaxError(error) ? "invalid_json" : "payload_too_large",
          status,
          requestId: response.locals.requestId
        },
        "Cloud request body was rejected"
      );
    } else {
      request.log?.error(
        { err: error, requestId: response.locals.requestId },
        "Unhandled cloud request error"
      );
    }
    if (response.headersSent) {
      response.end();
      return;
    }
    if (response.getHeader("Cache-Control") !== "private, no-store") {
      response.setHeader("Cache-Control", "no-store");
    }
    if (request.path === "/mcp" && jsonSyntaxError(error)) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32_700, message: "Parse error" },
        id: null
      });
      return;
    }
    if (request.path === "/mcp" && status === 413) {
      response.status(413).json({
        jsonrpc: "2.0",
        error: { code: -32_600, message: "Request body is too large" },
        id: null
      });
      return;
    }
    if (jsonSyntaxError(error)) {
      response
        .status(400)
        .json(publicError(response, "invalid_json", "The request body is not valid JSON"));
      return;
    }
    if (status === 413) {
      response
        .status(413)
        .json(publicError(response, "payload_too_large", "The request body is too large"));
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json(apiErrorBody(response, "validation_error", "Request validation failed", error.issues));
      return;
    }
    if (error instanceof ItemNotFoundError || error instanceof FindingNotFoundError) {
      response.status(404).json(apiErrorBody(response, "not_found", error.message));
      return;
    }
    if (error instanceof StaleRevisionError) {
      response.status(409).json(apiErrorBody(response, "stale_revision", error.message, { currentRevision: error.currentRevision }));
      return;
    }
    if (error instanceof IdempotencyConflictError) {
      response.status(409).json(apiErrorBody(response, "idempotency_conflict", error.message));
      return;
    }
    if (error instanceof SecretBlockedError) {
      response.status(422).json(apiErrorBody(response, "secret_detected", error.message, { findings: error.findings }));
      return;
    }
    if (error instanceof CopyBlockedError) {
      response.status(409).json(apiErrorBody(response, "copy_blocked", error.message, { reasons: error.reasons }));
      return;
    }
    if (error instanceof SecretPatternLimitError) {
      response.status(409).json(apiErrorBody(response, "secret_pattern_limit", error.message, {
        limit: error.limit
      }));
      return;
    }
    if (error instanceof QuotaExceededError) {
      if (error.resetAt) {
        const retryAfter = Math.max(
          1,
          Math.ceil((Date.parse(error.resetAt) - Date.now()) / 1_000)
        );
        response.setHeader("Retry-After", String(retryAfter));
      }
      response.status(429).json(apiErrorBody(response, "quota_exceeded", error.message, {
        metric: error.metric, limit: error.limit, resetAt: error.resetAt
      }));
      return;
    }
    if (error instanceof WorkspaceSuspendedError) {
      response.status(403).json(apiErrorBody(response, "workspace_suspended", error.message));
      return;
    }
    response
      .status(500)
      .json(publicError(response, "internal_error", "The request could not be completed"));
  };
  app.use(errorHandler);

  return { app, logger };
}

export const cloudAppInternals = {
  CLOUD_APP_ROUTES,
  MCP_SCOPES,
  RESOURCE_SCOPES,
  escapeHtml,
  errorStatus,
  isMissingFile,
  webRequest
};
