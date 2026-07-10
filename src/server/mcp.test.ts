import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createOutputMcpServer, mcpInternals } from "./mcp.js";
import { ItemStore } from "./store.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("output MCP server", () => {
  it("exposes scoped outbox tools and saves its final artifact", async () => {
    let itemNumber = 0;
    const store = new ItemStore({
      databasePath: ":memory:",
      idGenerator: () => (++itemNumber === 1 ? "saved-item" : `saved-item-${itemNumber}`),
      now: () => new Date("2026-07-10T08:00:00.000Z")
    });
    const server = createOutputMcpServer({
      store,
      publicBaseUrl: "http://127.0.0.1:3939"
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    cleanups.push(() => store.close());
    cleanups.push(() => server.close());
    cleanups.push(() => client.close());

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "save_output",
      "read_output",
      "revise_output",
      "mark_output_used"
    ]);
    expect(tools.tools[0]?.description).toContain("Do not save chain-of-thought");
    expect(tools.tools[0]?._meta).toMatchObject({
      ui: { resourceUri: "ui://cutline/saved-output.html" }
    });
    expect(tools.tools.find((tool) => tool.name === "mark_output_used")?.annotations)
      .toMatchObject({ idempotentHint: false });
    expect(mcpInternals.SAVE_OUTPUT_DESCRIPTION).toContain("only that artifact");

    const resources = await client.listResources();
    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "ui://cutline/saved-output.html" })
      ])
    );

    const result = await client.callTool({
      name: "save_output",
      arguments: {
        title: "Final client reply",
        contentMarkdown: "Thanks — Friday works for us.",
        kind: "reply",
        project: "ACME",
        tags: ["client"],
        sourceClient: "codex"
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      id: "saved-item",
      url: "http://127.0.0.1:3939/?item=saved-item",
      title: "Final client reply",
      revision: 1,
      status: "new",
      item: { id: "saved-item", title: "Final client reply" }
    });
    expect(store.get("saved-item")).toMatchObject({
      title: "Final client reply",
      contentMarkdown: "Thanks — Friday works for us.",
      sourceClient: "codex"
    });

    const read = await client.callTool({
      name: "read_output",
      arguments: { id: "saved-item" }
    });
    expect(read.structuredContent).toMatchObject({ id: "saved-item", revision: 1 });

    const revised = await client.callTool({
      name: "revise_output",
      arguments: {
        id: "saved-item",
        baseRevision: 1,
        contentMarkdown: "Thanks — Monday is even better.",
        changeNote: "Changed the date"
      }
    });
    expect(revised.structuredContent).toMatchObject({ id: "saved-item", revision: 2 });

    const used = await client.callTool({
      name: "mark_output_used",
      arguments: { id: "saved-item", destination: "plain" }
    });
    expect(used.structuredContent).toMatchObject({ id: "saved-item", status: "copied" });

    const typed = await client.callTool({
      name: "save_output",
      arguments: {
        title: "Architecture decision",
        recipeId: "decision",
        payload: {
          decision: "Use immutable revisions.",
          rationale: "It preserves what was copied."
        },
        project: "Cutline"
      }
    });
    expect(typed.isError).not.toBe(true);
    expect(store.get("saved-item-2")).toMatchObject({
      recipeId: "decision",
      kind: "note",
      contentMarkdown:
        "## Decision\n\nUse immutable revisions.\n\n## Rationale\n\nIt preserves what was copied."
    });
  });
});
