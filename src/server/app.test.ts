import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppInstance } from "./app.js";
import { MAX_CUSTOM_SECRET_PATTERNS } from "./security.js";

class CaptureSocket extends Duplex {
  readonly chunks: Buffer[] = [];

  _read(): void {
    // The request body is pushed directly to IncomingMessage below.
  }

  _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

interface InjectOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  nativeClient?: boolean;
}

interface InjectResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => unknown;
}

async function inject(app: Express, options: InjectOptions): Promise<InjectResponse> {
  const socket = new CaptureSocket();
  const nodeSocket = socket as unknown as Socket;
  const request = new IncomingMessage(nodeSocket);
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  request.method = options.method ?? "GET";
  request.url = options.path;
  const mutating = ["POST", "PATCH", "DELETE"].includes(request.method.toUpperCase());
  request.headers = {
    host: "127.0.0.1",
    ...(mutating && options.nativeClient !== false ? { "x-app-request": "1" } : {}),
    ...(body === ""
      ? {}
      : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body))
        }),
    ...options.headers
  };
  request.rawHeaders = Object.entries(request.headers).flatMap(([name, value]): string[] => {
    if (Array.isArray(value)) {
      return value.flatMap((entry) => [name, entry]);
    }
    return [name, value ?? ""];
  });

  const response = new ServerResponse(request);
  response.assignSocket(nodeSocket);

  const finished = new Promise<void>((resolve, reject) => {
    response.once("finish", resolve);
    response.once("error", reject);
  });

  app(request as never, response as never);
  if (body !== "") {
    request.emit("data", Buffer.from(body));
  }
  request.complete = true;
  request.emit("end");
  await finished;

  const rawResponse = Buffer.concat(socket.chunks).toString("utf8");
  const separator = rawResponse.indexOf("\r\n\r\n");
  const text = separator === -1 ? "" : rawResponse.slice(separator + 4);

  return {
    status: response.statusCode,
    headers: response.getHeaders() as Record<string, string | string[] | undefined>,
    text,
    json: () => JSON.parse(text) as unknown
  };
}

const instances: AppInstance[] = [];

function testApp(): AppInstance {
  const instance = createApp({
    databasePath: ":memory:",
    host: "127.0.0.1",
    publicBaseUrl: "http://127.0.0.1:3939"
  });
  instances.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.close();
  }
});

describe("HTTP app", () => {
  it("serves health and the item CRUD API", async () => {
    const { app } = testApp();
    const health = await inject(app, { path: "/api/health" });
    expect(health.status).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", storage: "ok" });
    expect(health.headers["content-security-policy"]).toContain("default-src 'self'");

    const createdResponse = await inject(app, {
      method: "POST",
      path: "/api/items",
      body: {
        title: "  Client reply ",
        contentMarkdown: "**Thanks!**",
        kind: "reply",
        project: "ACME",
        tags: ["client"]
      }
    });
    expect(createdResponse.status).toBe(201);
    const created = createdResponse.json() as { id: string; title: string };
    expect(created.title).toBe("Client reply");

    const list = await inject(app, {
      path: "/api/items?project=ACME&kind=reply&tag=client"
    });
    const listBody = list.json() as { items: Array<{ id: string }>; facets: object };
    expect(listBody.items.map((item) => item.id)).toEqual([created.id]);
    expect(listBody.facets).toBeDefined();

    const archived = await inject(app, {
      method: "PATCH",
      path: `/api/items/${created.id}`,
      body: { archived: true }
    });
    expect(archived.json() as { archivedAt: string | null }).toMatchObject({
      archivedAt: expect.any(String)
    });

    const deleted = await inject(app, {
      method: "DELETE",
      path: `/api/items/${created.id}`
    });
    expect(deleted.status).toBe(204);
  });

  it("returns consistent validation and not-found errors", async () => {
    const { app } = testApp();
    const invalid = await inject(app, {
      method: "POST",
      path: "/api/items",
      body: { title: "", contentMarkdown: "" }
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "validation_error" } });

    const missing = await inject(app, { path: "/api/items/not-here" });
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("requires an exact browser origin or an explicit origin-less native client for writes", async () => {
    const { app } = testApp();
    const payload = {
      title: "Protected write",
      contentMarkdown: "Only an approved local caller may save this."
    };

    const sameOrigin = await inject(app, {
      method: "POST",
      path: "/api/items",
      headers: {
        origin: "http://127.0.0.1:3939",
        "sec-fetch-site": "same-origin"
      },
      body: payload
    });
    expect(sameOrigin.status).toBe(201);

    const foreignOrigin = await inject(app, {
      method: "POST",
      path: "/api/items",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "same-site"
      },
      body: payload
    });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({
      error: { code: "local_csrf_rejected" }
    });

    const crossSiteWithoutOrigin = await inject(app, {
      method: "DELETE",
      path: "/api/items/not-present",
      headers: { "sec-fetch-site": "cross-site" }
    });
    expect(crossSiteWithoutOrigin.status).toBe(403);

    const formLikeMissingOrigin = await inject(app, {
      method: "POST",
      path: "/api/items/not-present/findings/not-present/acknowledge",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      nativeClient: false
    });
    expect(formLikeMissingOrigin.status).toBe(403);
    expect(formLikeMissingOrigin.headers["cache-control"]).toBe("no-store");

    const nativeClient = await inject(app, {
      method: "POST",
      path: "/api/items",
      body: { ...payload, title: "Native protected write" }
    });
    expect(nativeClient.status).toBe(201);
  });

  it("serves recipes, revisions, lifecycle, representations, and copy receipts", async () => {
    const { app } = testApp();
    const recipes = await inject(app, { path: "/api/recipes" });
    expect(recipes.status).toBe(200);
    expect(recipes.json()).toMatchObject({
      recipes: expect.arrayContaining([
        expect.objectContaining({
          id: "slack_update",
          defaultDestination: "slack",
          fields: expect.any(Array)
        })
      ])
    });

    const createdResponse = await inject(app, {
      method: "POST",
      path: "/api/items",
      body: {
        title: "Launch update",
        recipeId: "slack_update",
        payload: {
          headline: "Launch is ready",
          updateMarkdown: "All checks passed."
        },
        project: "Website",
        sourceClient: "codex",
        provenance: { branch: "feature/outbox", commitSha: "abc123" }
      }
    });
    expect(createdResponse.status).toBe(201);
    const created = createdResponse.json() as {
      id: string;
      contentMarkdown: string;
      currentRevision: number;
    };
    expect(created).toMatchObject({
      contentMarkdown: "# Launch is ready\n\nAll checks passed.",
      currentRevision: 1,
      defaultDestination: "slack"
    });

    const filtered = await inject(app, {
      path: "/api/items?status=new&recipe=slack_update"
    });
    expect((filtered.json() as { items: unknown[] }).items).toHaveLength(1);

    const revised = await inject(app, {
      method: "POST",
      path: `/api/items/${created.id}/revisions`,
      body: {
        contentMarkdown: "# Launch is ready\n\nAll checks passed twice.",
        changeNote: "Added verification detail",
        baseRevision: 1
      }
    });
    expect(revised.status).toBe(201);
    expect(revised.json()).toMatchObject({ currentRevision: 2, status: "new" });

    const revisionList = await inject(app, {
      path: `/api/items/${created.id}/revisions`
    });
    expect((revisionList.json() as { revisions: unknown[] }).revisions).toHaveLength(2);

    const reviewed = await inject(app, {
      method: "POST",
      path: `/api/items/${created.id}/transitions`,
      body: { status: "reviewed" }
    });
    expect(reviewed.json()).toMatchObject({ status: "reviewed" });

    const representationResponse = await inject(app, {
      path: `/api/items/${created.id}/representations/plain`
    });
    const representation = representationResponse.json() as { id: string; copyAllowed: boolean };
    expect(representation).toMatchObject({ copyAllowed: true });

    const copied = await inject(app, {
      method: "POST",
      path: `/api/items/${created.id}/copy-receipts`,
      body: {
        representationId: representation.id,
        destination: "plain",
        clientEventId: "browser-copy-1"
      }
    });
    expect(copied.json()).toMatchObject({ status: "copied" });
  });

  it("returns only redacted secret-policy errors", async () => {
    const { app } = testApp();
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const response = await inject(app, {
      method: "POST",
      path: "/api/items",
      body: { title: "Unsafe", contentMarkdown: `Token: ${secret}` }
    });
    expect(response.status).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "secret_detected",
        details: {
          findings: [
            expect.objectContaining({
              ruleId: "openai_key",
              redactedPreview: "OpenAI API key detected on line 2"
            })
          ]
        }
      }
    });
    expect(response.text).not.toContain(secret);
  });

  it("returns a public conflict when a project reaches the custom-pattern limit", async () => {
    const { app, store } = testApp();
    for (let index = 0; index < MAX_CUSTOM_SECRET_PATTERNS; index += 1) {
      store.addSecretPattern("Bounded", {
        label: `Pattern ${index + 1}`,
        patternKind: "literal",
        pattern: `bounded-secret-${index + 1}`,
        severity: "medium"
      });
    }

    const response = await inject(app, {
      method: "POST",
      path: "/api/projects/Bounded/secret-patterns",
      body: {
        label: "One too many",
        patternKind: "literal",
        pattern: "bounded-secret-over-limit",
        severity: "medium"
      }
    });
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "secret_pattern_limit",
        details: { limit: MAX_CUSTOM_SECRET_PATTERNS }
      }
    });
  });

  it("accepts the maximum ordinary MCP save payload above the former transport cap", async () => {
    const { app, store } = testApp();
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

    const response = await inject(app, {
      method: "POST",
      path: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      body: request
    });
    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 91,
      result: { structuredContent: { revision: 1, status: "new" } }
    });
    const saved = store.list({ archived: "all" }).items;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      contentMarkdown: "c".repeat(12_000),
      provenance: expect.objectContaining({ referencedFiles })
    });
  });

  it("returns an MCP protocol error above the bounded HTTP payload cap", async () => {
    const { app } = testApp();
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not bind to an IP port");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({ padding: "x".repeat(270_000) })
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32_600, message: "Request body is too large" },
        id: null
      });
    } finally {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["GET", "DELETE"])("returns an MCP protocol 405 for %s", async (method) => {
    const { app } = testApp();
    const response = await inject(app, { method, path: "/mcp" });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("POST");
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32_600, message: "Method not allowed. Use POST for Streamable HTTP." },
      id: null
    });
  });

  it("allows native MCP requests without Origin and rejects a supplied foreign Origin", async () => {
    const { app } = testApp();
    const rejected = await inject(app, {
      method: "GET",
      path: "/mcp",
      headers: { origin: "https://attacker.example" }
    });
    expect(rejected.status).toBe(403);
    expect(rejected.json()).toMatchObject({ error: { code: "invalid_origin" } });

    const allowed = await inject(app, {
      method: "GET",
      path: "/mcp",
      headers: { origin: "http://127.0.0.1:3939" }
    });
    expect(allowed.status).toBe(405);
  });

  it("rejects hostile Host headers through the MCP Express app", async () => {
    const { app } = testApp();
    const response = await inject(app, {
      path: "/health",
      headers: { host: "attacker.example" }
    });
    expect(response.status).toBe(403);
    expect(response.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32_000 }
    });
  });
});
