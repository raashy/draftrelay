import { describe, expect, it, vi } from "vitest";

import type { CloudDatabase } from "./db.js";
import { runCloudMaintenance, runWorkspaceMaintenance } from "./maintenance.js";

describe("cloud maintenance", () => {
  it("purges expired OAuth client-assertion replay tombstones", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 }));

    await runCloudMaintenance({ query } as unknown as CloudDatabase);

    expect(query.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes('DELETE FROM "oauthClientAssertion"')
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("status = 'dead_letter'") && sql.includes("180 days")
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      typeof sql === "string" && sql.includes("DELETE FROM usage_counter")
    )).toBe(false);
  });

  it("purges RLS-protected usage counters inside an explicit workspace context", async () => {
    const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));

    await runWorkspaceMaintenance({ query } as never, "00000000-0000-4000-8000-000000000001");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE workspace_id = $1"),
      ["00000000-0000-4000-8000-000000000001"]
    );
  });
});
