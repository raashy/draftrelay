import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = (process.env.CUTLINE_URL ?? process.env.AI_DUMP_URL ?? "http://127.0.0.1:3939").replace(/\/$/, "");
const client = new Client({ name: "cutline-smoke-test", version: "0.2.0" });
let savedId: string | undefined;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const home = await fetch(baseUrl);
  assert(home.ok, `UI returned ${home.status}`);
  assert((await home.text()).includes('<div id="root"></div>'), "UI shell is missing");

  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  for (const expected of ["save_output", "read_output", "revise_output", "mark_output_used"]) {
    assert(toolNames.has(expected), `${expected} is not available`);
  }

  const result = await client.callTool({
    name: "save_output",
    arguments: {
      title: "Smoke-test summary",
      contentMarkdown: "- MCP save works\n- The item reached SQLite\n- The browser API can read it",
      kind: "summary",
      project: "Cutline smoke test",
      tags: ["smoke-test"],
      sourceClient: "smoke-test"
    }
  });

  assert(result.isError !== true, "save_output returned an error");
  const receipt = result.structuredContent as { id?: unknown; url?: unknown } | undefined;
  assert(typeof receipt?.id === "string", "MCP receipt is missing an item id");
  assert(typeof receipt.url === "string", "MCP receipt is missing a URL");
  savedId = receipt.id;

  const list = await fetch(`${baseUrl}/api/items?q=Smoke-test`);
  assert(list.ok, `Item API returned ${list.status}`);
  const body = (await list.json()) as { items?: Array<{ id: string }> };
  assert(body.items?.some((item) => item.id === savedId), "Saved item was not returned by the API");

  console.log(`Smoke test passed: ${receipt.url}`);
} finally {
  if (savedId !== undefined) {
    await fetch(`${baseUrl}/api/items/${encodeURIComponent(savedId)}`, {
      method: "DELETE",
      headers: { "X-App-Request": "1" }
    });
  }
  await client.close().catch(() => undefined);
}
