import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import type { ResourceServerMetadata } from "@better-auth/oauth-provider";
import type { RequestHandler } from "express";
import pino, { type Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretPatternLimitError } from "../server/errors.js";
import { MAX_CUSTOM_SECRET_PATTERNS } from "../server/security.js";
import { createCloudApp, type CloudDatabaseHealth, type OAuthResourceClient } from "./app.js";
import type { CloudAuth } from "./auth.js";
import { loadCloudConfig, type CloudConfig } from "./config.js";
import { CloudStore, QuotaExceededError } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

interface TestCloud {
  baseUrl: string;
  close: () => Promise<void>;
  getSession: ReturnType<typeof vi.fn>;
  verifyAccessToken: ReturnType<typeof vi.fn>;
  databaseQuery: ReturnType<typeof vi.fn>;
  protectedMetadata: ReturnType<typeof vi.fn>;
}

function sessionValue() {
  const now = new Date();
  return {
    user: {
      id: "user_test",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now
    },
    session: {
      id: "session_test",
      token: "session-token",
      userId: "user_test",
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      ipAddress: "127.0.0.1",
      userAgent: "test"
    }
  };
}

async function startCloud(
  overrides: {
    config?: CloudConfig;
    staticDir?: string;
    session?: ReturnType<typeof sessionValue> | null;
    databaseError?: Error;
    schemaAttestation?: () => Promise<void>;
    readinessChecks?: Array<() => Promise<void>>;
    stripeWebhookHandler?: RequestHandler;
    stripeReconcileUser?: (userId: string) => Promise<void>;
    logger?: Logger;
    store?: CloudStore;
    tokenScopes?: string;
  } = {}
): Promise<TestCloud> {
  const config =
    overrides.config ??
    loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1",
      DATABASE_URL: "postgres://unused"
    });
  const getSession = vi.fn(async () =>
    Object.hasOwn(overrides, "session") ? overrides.session : sessionValue()
  );
  const authHandler = vi.fn(async (request: Request) => {
    const body = await request.text();
    return Response.json({ path: new URL(request.url).pathname, body });
  });
  const auth = {
    handler: authHandler,
    api: { getSession }
  } as unknown as CloudAuth;

  const databaseQuery = vi.fn(async () => {
    if (overrides.databaseError) throw overrides.databaseError;
    return { rows: [{ value: 1 }] };
  });
  const database = {
    query: databaseQuery as unknown as CloudDatabaseHealth["query"]
  };

  const verifyAccessToken = vi.fn(async () => ({
    sub: "user_test",
    scope: overrides.tokenScopes ?? "outputs:use outputs:read",
    azp: "client_test",
    exp: 2_000_000_000
  }));
  const protectedMetadata = vi.fn(async (metadata) => metadata as ResourceServerMetadata);
  const oauthResourceClient: OAuthResourceClient = {
    verifyAccessToken,
    getProtectedResourceMetadata: protectedMetadata
  };

  const instance = createCloudApp({
    config,
    database,
    ...(overrides.schemaAttestation
      ? { schemaAttestation: overrides.schemaAttestation }
      : {}),
    ...(overrides.readinessChecks ? { readinessChecks: overrides.readinessChecks } : {}),
    ...(overrides.stripeWebhookHandler
      ? { stripeWebhookHandler: overrides.stripeWebhookHandler }
      : {}),
    ...(overrides.stripeReconcileUser
      ? { stripeReconcileUser: overrides.stripeReconcileUser }
      : {}),
    auth,
    oauthResourceClient,
    authorizationMetadataHandler: async () =>
      Response.json({ issuer: config.authUrl, token_endpoint: `${config.authUrl}/oauth2/token` }),
    openIdMetadataHandler: async () => Response.json({ issuer: config.authUrl }),
    logger: overrides.logger ?? pino({ level: "silent" }),
    ...(overrides.store ? { store: overrides.store } : {}),
    ...(overrides.staticDir ? { staticDir: overrides.staticDir } : {})
  });

  const server = createServer(instance.app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to an IP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await closeServer(server);
    },
    getSession,
    verifyAccessToken,
    databaseQuery,
    protectedMetadata
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("cloud Express application", () => {
  it("mounts Better Auth before JSON parsing", async () => {
    const cloud = await startCloud();
    try {
      const response = await fetch(`${cloud.baseUrl}/api/auth/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ deliberately not JSON"
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        path: "/api/auth/echo",
        body: "{ deliberately not JSON"
      });
    } finally {
      await cloud.close();
    }
  });

  it("provides liveness, database readiness, and OAuth discovery metadata", async () => {
    const cloud = await startCloud();
    try {
      const [live, ready, authorization, authorizationAtIssuerPath, resource] = await Promise.all([
        fetch(`${cloud.baseUrl}/health/live`),
        fetch(`${cloud.baseUrl}/health/ready`),
        fetch(`${cloud.baseUrl}/.well-known/oauth-authorization-server`),
        fetch(`${cloud.baseUrl}/.well-known/oauth-authorization-server/api/auth`),
        fetch(`${cloud.baseUrl}/.well-known/oauth-protected-resource/mcp`)
      ]);

      expect(live.status).toBe(200);
      expect(ready.status).toBe(200);
      expect(await authorization.json()).toMatchObject({
        issuer: "http://127.0.0.1/api/auth"
      });
      expect(await authorizationAtIssuerPath.json()).toMatchObject({
        issuer: "http://127.0.0.1/api/auth"
      });
      expect(await resource.json()).toMatchObject({
        resource: "http://127.0.0.1/mcp",
        authorization_servers: ["http://127.0.0.1/api/auth"],
        jwks_uri: "http://127.0.0.1/api/auth/jwks",
        scopes_supported: ["outputs:read", "outputs:write", "outputs:use"],
        bearer_methods_supported: ["header"]
      });
      expect(resource.headers.get("cache-control")).toContain("max-age=300");
      expect(cloud.databaseQuery).toHaveBeenCalledWith("SELECT 1");
      expect(cloud.protectedMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          resource: "http://127.0.0.1/mcp",
          scopes_supported: ["outputs:read", "outputs:write", "outputs:use"]
        })
      );
    } finally {
      await cloud.close();
    }
  });

  it("serves crawlable public pages and discovery files before the POST-only MCP transport", async () => {
    const cloud = await startCloud();
    try {
      const [docs, mcpPage, sitemap, robots, llms] = await Promise.all([
        fetch(`${cloud.baseUrl}/docs`),
        fetch(`${cloud.baseUrl}/mcp`),
        fetch(`${cloud.baseUrl}/sitemap.xml`),
        fetch(`${cloud.baseUrl}/robots.txt`),
        fetch(`${cloud.baseUrl}/llms.txt`)
      ]);
      expect(docs.status).toBe(200);
      expect(docs.headers.get("content-type")).toContain("text/html");
      expect(await docs.text()).toContain("From agent output to a clean handoff");
      expect(mcpPage.status).toBe(200);
      expect(await mcpPage.text()).toContain("One MCP job: hand the useful result back");
      expect(sitemap.headers.get("content-type")).toContain("application/xml");
      expect(await sitemap.text()).toContain("http://127.0.0.1/docs");
      expect(robots.headers.get("content-type")).toContain("text/plain");
      expect(await robots.text()).toContain("Disallow: /api/");
      expect(await llms.text()).toContain("# DraftRelay");
      expect(cloud.verifyAccessToken).not.toHaveBeenCalled();
    } finally {
      await cloud.close();
    }
  });

  it("fails readiness without exposing the database error", async () => {
    const cloud = await startCloud({ databaseError: new Error("secret database detail") });
    try {
      const response = await fetch(`${cloud.baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret database detail");
    } finally {
      await cloud.close();
    }
  });

  it("re-attests the migration and forced-RLS state for readiness", async () => {
    const schemaAttestation = vi.fn(async () => undefined);
    const cloud = await startCloud({ schemaAttestation });
    try {
      const ready = await fetch(`${cloud.baseUrl}/health/ready`);
      expect(ready.status).toBe(200);
      expect(schemaAttestation).toHaveBeenCalledTimes(1);
    } finally {
      await cloud.close();
    }

    const failed = await startCloud({
      schemaAttestation: vi.fn(async () => {
        throw new Error("private schema detail");
      })
    });
    try {
      const ready = await fetch(`${failed.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.text()).not.toContain("private schema detail");
    } finally {
      await failed.close();
    }
  });

  it("includes external dependencies in readiness and the UI health response", async () => {
    const dependency = vi.fn(async () => {
      throw new Error("private redis or Stripe detail");
    });
    const cloud = await startCloud({ readinessChecks: [dependency] });
    try {
      const ready = await fetch(`${cloud.baseUrl}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.text()).not.toContain("private redis or Stripe detail");
      const uiHealth = await fetch(`${cloud.baseUrl}/api/health`);
      expect(uiHealth.status).toBe(503);
      expect(await uiHealth.json()).toMatchObject({
        status: "unavailable",
        storage: "unavailable"
      });
      expect(dependency).toHaveBeenCalledTimes(2);
    } finally {
      await cloud.close();
    }
  });

  it("routes the exact Stripe webhook through the owned raw-body handler", async () => {
    const webhookHandler: RequestHandler = (request, response) => {
      expect(Buffer.isBuffer(request.body)).toBe(true);
      expect(request.body.toString()).toBe('{"event":"value"}');
      response.json({ received: true });
    };
    const cloud = await startCloud({ stripeWebhookHandler: webhookHandler });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/auth/stripe/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "test-signature"
        },
        body: '{"event":"value"}'
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ received: true });
    } finally {
      await cloud.close();
    }
  });

  it("reconciles Stripe authoritatively before returning account billing state", async () => {
    const order: string[] = [];
    const stripeReconcileUser = vi.fn(async (userId: string) => {
      expect(userId).toBe("user_test");
      order.push("stripe");
    });
    const billingSubscriptions = vi.fn(async () => {
      order.push("store");
      return [{ id: "subscription_test", plan: "pro", status: "active" }];
    });
    const cloud = await startCloud({
      stripeReconcileUser,
      store: { billingSubscriptions } as unknown as CloudStore
    });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/billing/subscriptions`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        subscriptions: [{ id: "subscription_test", plan: "pro", status: "active" }]
      });
      expect(order).toEqual(["stripe", "store"]);
    } finally {
      await cloud.close();
    }
  });

  it("fails account billing state closed when Stripe reconciliation is unavailable", async () => {
    const billingSubscriptions = vi.fn();
    const cloud = await startCloud({
      stripeReconcileUser: vi.fn(async () => {
        throw new Error("provider detail must not reach the client");
      }),
      store: { billingSubscriptions } as unknown as CloudStore
    });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/billing/subscriptions`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "billing_state_unavailable" }
      });
      expect(billingSubscriptions).not.toHaveBeenCalled();
    } finally {
      await cloud.close();
    }
  });

  it("streams the sanitized account export as a downloadable JSON document", async () => {
    const streamExportData = vi.fn(async (
      _actor: unknown,
      write: (chunk: string) => void | Promise<void>
    ) => {
      await write('{"schemaVersion":1,"account":');
      await write('{"profile":{"email":"test@example.com"}},"items":[]}');
    });
    const cloud = await startCloud({
      store: { streamExportData } as unknown as CloudStore
    });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/account/export`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("content-disposition")).toContain("draftrelay-export-");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual({
        schemaVersion: 1,
        account: { profile: { email: "test@example.com" } },
        items: []
      });
      expect(streamExportData).toHaveBeenCalledTimes(1);
    } finally {
      await cloud.close();
    }
  });

  it("requires schema attestation when constructing the production app", () => {
    const config = {
      ...loadCloudConfig({ NODE_ENV: "test" }),
      environment: "production" as const
    };
    expect(() => createCloudApp({
      config,
      database: { query: vi.fn() as unknown as CloudDatabaseHealth["query"] },
      auth: {} as CloudAuth,
      oauthResourceClient: {} as OAuthResourceClient
    })).toThrow(/schema attestation/);
  });

  it("requires exact-origin JSON requests for cookie-authenticated mutations", async () => {
    const cloud = await startCloud();
    try {
      const rejected = await fetch(`${cloud.baseUrl}/api/not-a-route`, {
        method: "POST",
        headers: {
          cookie: "draftrelay.session_token=value",
          "content-type": "application/json",
          origin: "https://attacker.example",
          "x-app-request": "1"
        },
        body: "{}"
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ error: { code: "csrf_rejected" } });
      expect(cloud.getSession).not.toHaveBeenCalled();

      const accepted = await fetch(`${cloud.baseUrl}/api/not-a-route`, {
        method: "POST",
        headers: {
          cookie: "draftrelay.session_token=value",
          "content-type": "application/json; charset=utf-8",
          origin: "http://127.0.0.1",
          "sec-fetch-site": "same-origin",
          "x-app-request": "1"
        },
        body: "{}"
      });
      expect(accepted.status).toBe(404);
      expect(accepted.headers.get("cache-control")).toBe("private, no-store");
      expect(accepted.headers.get("pragma")).toBe("no-cache");
      expect(cloud.getSession).toHaveBeenCalledTimes(1);
    } finally {
      await cloud.close();
    }
  });

  it("returns a private public-safe conflict for the custom-pattern ceiling", async () => {
    const addSecretPattern = vi.fn(async () => {
      throw new SecretPatternLimitError(MAX_CUSTOM_SECRET_PATTERNS);
    });
    const store = { addSecretPattern } as unknown as CloudStore;
    const cloud = await startCloud({ store });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/projects/Bounded/secret-patterns`, {
        method: "POST",
        headers: {
          cookie: "draftrelay.session_token=value",
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          "sec-fetch-site": "same-origin",
          "x-app-request": "1"
        },
        body: JSON.stringify({
          label: "One too many",
          patternKind: "literal",
          pattern: "bounded-secret-over-limit",
          severity: "medium"
        })
      });
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toMatchObject({
        error: {
          code: "secret_pattern_limit",
          details: { limit: MAX_CUSTOM_SECRET_PATTERNS }
        }
      });
      expect(addSecretPattern).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_test" }),
        "Bounded",
        expect.objectContaining({ patternKind: "literal" })
      );
    } finally {
      await cloud.close();
    }
  });

  it("fails closed when a browser session is absent", async () => {
    const cloud = await startCloud({ session: null });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/me`);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    } finally {
      await cloud.close();
    }
  });

  it("verifies MCP bearer issuer, audience, and scope before reaching the transport", async () => {
    const cloud = await startCloud();
    try {
      const missing = await fetch(`${cloud.baseUrl}/mcp`, { method: "POST" });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toContain(
        "/.well-known/oauth-protected-resource/mcp"
      );

      cloud.verifyAccessToken.mockRejectedValueOnce(new Error("bad token"));
      const invalid = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer test.invalid-token" }
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.text()).not.toContain("bad token");

      const authenticated = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test.valid-token",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(authenticated.status).toBe(501);
      expect(cloud.verifyAccessToken).toHaveBeenLastCalledWith("test.valid-token", {
        verifyOptions: {
          issuer: "http://127.0.0.1/api/auth",
          audience: "http://127.0.0.1/mcp"
        },
        scopes: []
      });
    } finally {
      await cloud.close();
    }
  });

  it("rejects a supplied cross-origin MCP request before token verification", async () => {
    const cloud = await startCloud();
    try {
      const rejected = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer otherwise.valid.token",
          origin: "https://attacker.example"
        }
      });
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ error: { code: "invalid_origin" } });
      expect(cloud.verifyAccessToken).not.toHaveBeenCalled();

      const allowed = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer allowed.origin.token",
          origin: "http://127.0.0.1",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(allowed.status).toBe(501);
      expect(cloud.verifyAccessToken).toHaveBeenCalledTimes(1);
    } finally {
      await cloud.close();
    }
  });

  it("returns the same safe boundary for malformed and wrong-audience tokens", async () => {
    const rawCredential = "wrong.audience.token.must-not-leak";
    const cloud = await startCloud();
    try {
      const malformed = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer %%% malformed" }
      });
      expect(malformed.status).toBe(401);
      expect(await malformed.json()).toMatchObject({ error: { code: "invalid_token" } });
      expect(cloud.verifyAccessToken).not.toHaveBeenCalled();

      cloud.verifyAccessToken.mockRejectedValueOnce(
        new Error(`JWT audience mismatch while checking ${rawCredential}`)
      );
      const wrongAudience = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${rawCredential}` }
      });
      const body = await wrongAudience.text();
      expect(wrongAudience.status).toBe(401);
      expect(wrongAudience.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(body).toContain("invalid_token");
      expect(body).not.toContain(rawCredential);
      expect(body).not.toContain("audience mismatch");
    } finally {
      await cloud.close();
    }
  });

  it("accepts the maximum ordinary MCP save payload above the former transport cap", async () => {
    const create = vi.fn(async (_actor, input: { title: string; project?: string }) => ({
      id: "8d75fb26-8da7-49b7-b2cd-bf090f5952af",
      title: input.title,
      currentRevision: 1,
      status: "new" as const,
      project: input.project ?? "General"
    }));
    const store = {
      create,
      isOAuthConnectionActive: vi.fn(async () => true),
      consumeMcpRequest: vi.fn(async () => undefined)
    } as unknown as CloudStore;
    const cloud = await startCloud({
      store,
      tokenScopes: "outputs:read outputs:write outputs:use"
    });
    const referencedFiles = Array.from({ length: 50 }, (_, index) => ({
      path: `${String(index).padStart(2, "0")}${"p".repeat(1_998)}`,
      lineStart: 1,
      lineEnd: 1
    }));
    const request = {
      jsonrpc: "2.0",
      id: 91,
      method: "tools/call",
      params: {
        name: "save_output",
        arguments: {
          title: "T".repeat(120),
          contentMarkdown: "c".repeat(12_000),
          project: "P".repeat(80),
          tags: Array.from({ length: 8 }, (_, index) => `tag${index}${"x".repeat(28)}`),
          sourceClient: "s".repeat(64),
          idempotencyKey: "i".repeat(240),
          provenance: {
            sourceClientVersion: "v".repeat(64),
            agentName: "a".repeat(100),
            model: "m".repeat(100),
            sessionId: "q".repeat(240),
            cwd: "d".repeat(2_000),
            repoRoot: "r".repeat(2_000),
            repoRemote: "u".repeat(2_000),
            branch: "b".repeat(500),
            commitSha: "h".repeat(100),
            repoDirty: true,
            verificationStatus: "passed",
            verificationSummary: "z".repeat(2_000),
            referencedFiles
          }
        }
      }
    };
    const serialized = JSON.stringify(request);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(100 * 1_024);
    expect(Buffer.byteLength(serialized)).toBeLessThan(256 * 1_024);

    try {
      const response = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid.maximum-payload-token",
          "content-type": "application/json"
        },
        body: serialized
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 91,
        result: { structuredContent: { revision: 1, status: "new" } }
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_test" }),
        expect.objectContaining({
          contentMarkdown: "c".repeat(12_000),
          provenance: expect.objectContaining({ referencedFiles })
        })
      );
    } finally {
      await cloud.close();
    }
  });

  it("returns route-aware MCP JSON-RPC body errors without logging raw content", async () => {
    const rawSecret = "sk-proj-malformed-body-must-never-enter-logs";
    let logs = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      }
    });
    const logger = pino({ level: "trace" }, destination);
    const cloud = await startCloud({ logger });
    try {
      const malformed = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"contentMarkdown":"${rawSecret}"`
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_700, message: "Parse error" },
        id: null
      });

      const oversized = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(270_000) })
      });
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_600, message: "Request body is too large" },
        id: null
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(logs).toContain("Cloud request body was rejected");
      expect(logs).not.toContain(rawSecret);
      expect(logs).not.toContain("contentMarkdown");
    } finally {
      await cloud.close();
      destination.end();
    }
  });

  it("revokes a consent and denies that OAuth client on its next MCP request", async () => {
    let active = true;
    const consentId = "9232234e-aa86-4f0d-bd21-e63aeb45dbf0";
    const revokeOAuthConnection = vi.fn(async () => {
      active = false;
      return true;
    });
    const isOAuthConnectionActive = vi.fn(async () => active);
    const store = {
      revokeOAuthConnection,
      isOAuthConnectionActive
    } as unknown as CloudStore;
    const cloud = await startCloud({ store });
    try {
      const revoked = await fetch(`${cloud.baseUrl}/api/oauth/connections/${consentId}`, {
        method: "DELETE",
        headers: {
          cookie: "draftrelay.session_token=value",
          "content-type": "application/json",
          origin: "http://127.0.0.1",
          "sec-fetch-site": "same-origin",
          "x-app-request": "1"
        }
      });
      expect(revoked.status).toBe(204);
      expect(revokeOAuthConnection).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_test", kind: "human" }),
        consentId
      );

      const denied = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer valid.token.after.revocation",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toContain('error="invalid_token"');
      expect(await denied.json()).toMatchObject({ error: { code: "connection_revoked" } });
      expect(isOAuthConnectionActive).toHaveBeenCalledWith("user_test", "client_test");
    } finally {
      await cloud.close();
    }
  });

  it("enforces the authenticated MCP tier limit with retry guidance", async () => {
    const resetAt = new Date(Date.now() + 30_000).toISOString();
    const consumeMcpRequest = vi.fn(async () => {
      throw new QuotaExceededError("requestsPerMinute", 60, resetAt);
    });
    const store = {
      isOAuthConnectionActive: vi.fn(async () => true),
      consumeMcpRequest
    } as unknown as CloudStore;
    const cloud = await startCloud({ store });
    try {
      const response = await fetch(`${cloud.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer valid.token.for.limit",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(response.status).toBe(429);
      expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await response.json()).toMatchObject({
        error: {
          code: "quota_exceeded",
          details: { metric: "requestsPerMinute", limit: 60, resetAt }
        }
      });
      expect(consumeMcpRequest).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user_test", oauthClientId: "client_test" })
      );
    } finally {
      await cloud.close();
    }
  });

  it("does not write bearer credentials or sensitive query values to logs or errors", async () => {
    const rawToken = "raw.secret.jwt.value.must-never-appear";
    const querySecret = "oauth-code-must-never-appear";
    let logs = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      }
    });
    const logger = pino({ level: "trace" }, destination);
    const cloud = await startCloud({ logger });
    try {
      cloud.verifyAccessToken.mockRejectedValueOnce(
        new Error(`verification failed for bearer ${rawToken}`)
      );
      const response = await fetch(
        `${cloud.baseUrl}/mcp?code=${encodeURIComponent(querySecret)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${rawToken}` }
        }
      );
      const body = await response.text();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(response.status).toBe(401);
      expect(body).not.toContain(rawToken);
      expect(body).not.toContain(querySecret);
      expect(logs).not.toContain(rawToken);
      expect(logs).not.toContain(querySecret);
      expect(logs).not.toContain("authorization");
    } finally {
      await cloud.close();
      destination.end();
    }
  });

  it("serves safely substituted marketing and cloud application HTML", async () => {
    const staticDir = await mkdtemp(path.join(tmpdir(), "draftrelay-cloud-test-"));
    temporaryDirectories.push(staticDir);
    await writeFile(
      path.join(staticDir, "cloud.html"),
      "<title>__APP_NAME__</title><a href=\"__APP_URL__/signup\">Start</a>",
      "utf8"
    );
    await writeFile(path.join(staticDir, "cloud-app.html"), "<main>Cloud app</main>", "utf8");

    const baseConfig = loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1",
      DATABASE_URL: "postgres://unused"
    });
    const cloud = await startCloud({
      staticDir,
      config: { ...baseConfig, appName: "Relay & Review" }
    });
    try {
      const home = await fetch(`${cloud.baseUrl}/`);
      const login = await fetch(`${cloud.baseUrl}/login`);
      expect(home.headers.get("cache-control")).toBe("no-cache");
      expect(await home.text()).toBe(
        "<title>Relay &amp; Review</title><a href=\"http://127.0.0.1/signup\">Start</a>"
      );
      expect(await login.text()).toBe("<main>Cloud app</main>");
    } finally {
      await cloud.close();
    }
  });

  it("adds hardened headers and accepts only bounded request IDs", async () => {
    const cloud = await startCloud();
    try {
      const accepted = await fetch(`${cloud.baseUrl}/health/live`, {
        headers: { "x-request-id": "request_12345678" }
      });
      expect(accepted.headers.get("x-request-id")).toBe("request_12345678");
      expect(accepted.headers.get("x-content-type-options")).toBe("nosniff");
      expect(accepted.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");

      const rejected = await fetch(`${cloud.baseUrl}/health/live`, {
        headers: { "x-request-id": "bad id with spaces" }
      });
      expect(rejected.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await cloud.close();
    }
  });

  it("allows content-free container probes while rejecting untrusted product hosts", async () => {
    const cloud = await startCloud();
    try {
      const probe = await fetch(`${cloud.baseUrl}/health/live`, {
        headers: { host: "127.0.0.1" }
      });
      expect(probe.status).toBe(200);

      const product = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = httpRequest(`${cloud.baseUrl}/docs`, {
          headers: { host: "untrusted.example" }
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          }));
        });
        request.once("error", reject);
        request.end();
      });
      expect(product.status).toBe(400);
      expect(JSON.parse(product.body)).toMatchObject({ error: { code: "invalid_host" } });
    } finally {
      await cloud.close();
    }
  });

  it("publishes only the Turnstile site key and extends CSP when signup protection is enabled", async () => {
    const config = loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1",
      DATABASE_URL: "postgres://unused",
      TURNSTILE_SECRET_KEY: "server-secret-must-stay-private",
      TURNSTILE_SITE_KEY: "public-site-key"
    });
    const cloud = await startCloud({ config });
    try {
      const response = await fetch(`${cloud.baseUrl}/api/public-config`);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("public-site-key");
      expect(text).not.toContain("server-secret-must-stay-private");
      expect(response.headers.get("content-security-policy")).toContain(
        "https://challenges.cloudflare.com"
      );
    } finally {
      await cloud.close();
    }
  });
});
