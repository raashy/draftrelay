import { describe, expect, it } from "vitest";

import { decodeItemCursor, encodeItemCursor } from "./pagination.js";

describe("item pagination cursors", () => {
  it("round-trips an opaque keyset and rejects malformed cursors", () => {
    const cursor = encodeItemCursor({
      updatedAt: "2026-07-10T12:00:00.000Z",
      createdAt: "2026-07-10T11:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001"
    });
    expect(decodeItemCursor(cursor)).toMatchObject({
      version: 1,
      updatedAt: "2026-07-10T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001"
    });
    expect(decodeItemCursor("not-json")).toBeUndefined();
  });
});
