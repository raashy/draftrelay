import { describe, expect, it } from "vitest";

import { encodeItemCursor } from "./pagination.js";
import { parseCreateItem, parseItemQuery, parseUpdateItem } from "./validation.js";

describe("item validation", () => {
  it("normalizes user-facing fields without damaging Markdown", () => {
    const parsed = parseCreateItem({
      title: "  Client   reply  ",
      contentMarkdown: "\r\n## Hello\r\n\r\n```ts\r\nconst x = 1;\r\n```\r\n",
      project: "  ACME   Launch ",
      tags: [" Urgent ", "client reply", "urgent"],
      sourceClient: " claude-code "
    });

    expect(parsed).toEqual({
      title: "Client reply",
      contentMarkdown: "## Hello\n\n```ts\nconst x = 1;\n```",
      kind: "note",
      project: "ACME Launch",
      tags: ["Urgent", "client reply"],
      sourceClient: "claude-code",
      recipeId: "generic_note",
      recipePayload: {
        contentMarkdown: "## Hello\n\n```ts\nconst x = 1;\n```"
      },
      provenance: undefined,
      idempotencyKey: undefined
    });
  });

  it("enforces the artifact size and tag count limits", () => {
    expect(() =>
      parseCreateItem({
        title: "x".repeat(121),
        contentMarkdown: "Useful"
      })
    ).toThrow();

    expect(() =>
      parseCreateItem({
        title: "Useful",
        contentMarkdown: "x".repeat(12_001)
      })
    ).toThrow();

    expect(() =>
      parseCreateItem({
        title: "Useful",
        contentMarkdown: "Useful",
        tags: Array.from({ length: 9 }, (_, index) => `tag-${index}`)
      })
    ).toThrow();
  });

  it("uses a visible fallback project when the caller does not know one", () => {
    expect(
      parseCreateItem({
        title: "Useful note",
        contentMarkdown: "Keep this."
      }).project
    ).toBe("General");
  });

  it("rejects unknown writes and empty patches", () => {
    expect(() =>
      parseCreateItem({
        title: "Useful",
        contentMarkdown: "Useful",
        unexpected: true
      })
    ).toThrow();
    expect(() => parseUpdateItem({})).toThrow();
  });

  it("defaults list queries to active items", () => {
    expect(parseItemQuery({ q: "  launch  " })).toEqual({
      archived: "false",
      q: "launch",
      limit: 50
    });
    const cursor = encodeItemCursor({
      updatedAt: "2026-07-10T12:00:00.000Z",
      createdAt: "2026-07-10T11:00:00.000Z",
      id: "item-1"
    });
    expect(parseItemQuery({ limit: "25", cursor })).toMatchObject({ limit: 25, cursor });
    expect(() => parseItemQuery({ cursor: "invalid" })).toThrow();
  });

  it("renders and validates typed recipe payloads", () => {
    expect(
      parseCreateItem({
        title: "Launch update",
        recipeId: "slack_update",
        payload: {
          headline: "Launch is ready",
          updateMarkdown: "Production checks passed.",
          blockers: ["Waiting for DNS"]
        }
      })
    ).toMatchObject({
      recipeId: "slack_update",
      kind: "reply",
      contentMarkdown:
        "# Launch is ready\n\nProduction checks passed.\n\n## Blockers\n\n- Waiting for DNS"
    });

    expect(() =>
      parseCreateItem({
        title: "Invalid typed output",
        recipeId: "client_email",
        contentMarkdown: "This bypasses the recipe contract."
      })
    ).toThrow();
  });
});
