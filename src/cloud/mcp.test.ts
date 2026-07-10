import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SecretBlockedError } from "../server/store.js";
import { createCloudMcpServer } from "./mcp.js";
import { CloudStore, QuotaExceededError, type CloudActor } from "./store.js";

const cleanups: Array<() => Promise<void> | void> = [];
const outputId = "8d75fb26-8da7-49b7-b2cd-bf090f5952af";
const actor: CloudActor = {
  userId: "14ff2ea1-49c0-47f6-b759-b293ecd81a42",
  name: "MCP boundary test",
  kind: "agent",
  label: "test-client"
};

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function toolText(result: unknown): string {
  if (
    typeof result !== "object" ||
    result === null ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return "";
  }
  return result.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

async function connect(
  store: CloudStore,
  scopes: string[]
): Promise<Client> {
  const server = createCloudMcpServer({
    store,
    actor,
    scopes,
    publicBaseUrl: "https://app.draftrelay.example"
  });
  const client = new Client({ name: "boundary-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(() => server.close());
  cleanups.push(() => client.close());
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("hosted MCP tool authorization", () => {
  it("does not advertise mark_output_used as unconditionally idempotent", async () => {
    const client = await connect({} as CloudStore, []);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "mark_output_used")?.annotations)
      .toMatchObject({ idempotentHint: false });
  });

  it("denies read, write, and use tools before invoking the store", async () => {
    const create = vi.fn();
    const get = vi.fn();
    const list = vi.fn();
    const createRevision = vi.fn();
    const getRepresentation = vi.fn();
    const store = {
      create,
      get,
      list,
      createRevision,
      getRepresentation
    } as unknown as CloudStore;
    const client = await connect(store, []);

    const write = await client.callTool({
      name: "save_output",
      arguments: { title: "Final reply", contentMarkdown: "Ship it." }
    });
    const read = await client.callTool({
      name: "read_output",
      arguments: { id: outputId }
    });
    const listResult = await client.callTool({ name: "list_outputs", arguments: {} });
    const revise = await client.callTool({
      name: "revise_output",
      arguments: { id: outputId, baseRevision: 1, contentMarkdown: "Revised." }
    });
    const use = await client.callTool({
      name: "mark_output_used",
      arguments: { id: outputId, destination: "plain" }
    });

    expect(write.isError).toBe(true);
    expect(toolText(write)).toContain("outputs:write");
    expect(read.isError).toBe(true);
    expect(toolText(read)).toContain("outputs:read");
    expect(listResult.isError).toBe(true);
    expect(toolText(listResult)).toContain("outputs:read");
    expect(revise.isError).toBe(true);
    expect(toolText(revise)).toContain("outputs:write");
    expect(use.isError).toBe(true);
    expect(toolText(use)).toContain("outputs:use");
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(createRevision).not.toHaveBeenCalled();
    expect(getRepresentation).not.toHaveBeenCalled();
  });

  it("returns actionable quota and redacted secret errors without leaking internals", async () => {
    const rawSecret = "sk-proj-raw-secret-value-that-must-never-escape";
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new QuotaExceededError("dailySaves", 50, "2026-07-11T00:00:00.000Z")
      )
      .mockRejectedValueOnce(
        new SecretBlockedError([
          {
            ruleId: "openai_key",
            label: "OpenAI API key",
            severity: "high",
            action: "block",
            startOffset: 0,
            endOffset: rawSecret.length,
            lineNumber: 1,
            fingerprint: "fingerprint-must-not-escape",
            redactedPreview: "sk-proj-raw…cape"
          }
        ])
      )
      .mockRejectedValueOnce(new Error(`database credential ${rawSecret}`));
    const store = { create } as unknown as CloudStore;
    const client = await connect(store, ["outputs:write"]);
    const input = {
      name: "save_output",
      arguments: { title: "Safe artifact", contentMarkdown: "No credential here." }
    } as const;

    const quota = await client.callTool(input);
    const secret = await client.callTool(input);
    const unexpected = await client.callTool(input);

    expect(quota.isError).toBe(true);
    expect(toolText(quota)).toContain("dailySaves limit of 50");
    expect(toolText(quota)).toContain("2026-07-11T00:00:00.000Z");
    expect(toolText(quota)).toContain("review usage or upgrade");

    expect(secret.isError).toBe(true);
    expect(toolText(secret)).toContain("sk-proj-raw…cape");
    expect(toolText(secret)).not.toContain(rawSecret);
    expect(toolText(secret)).not.toContain("fingerprint-must-not-escape");

    expect(unexpected.isError).toBe(true);
    expect(toolText(unexpected)).toContain("DraftRelay could not complete the operation");
    expect(toolText(unexpected)).not.toContain(rawSecret);
    expect(toolText(unexpected)).not.toContain("database credential");
  });
});
