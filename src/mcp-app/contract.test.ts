import { describe, expect, it } from "vitest";

import type { OutputItem } from "../shared/items.js";
import {
  createCutlineCardStructuredContent,
  createCutlineCardToolMeta,
  CUTLINE_CARD_RESOURCE_URI
} from "./contract.js";

const item: OutputItem = {
  id: "item-1",
  title: "Client reply",
  contentMarkdown: "Thanks — Friday works for us.",
  kind: "reply",
  project: "ACME",
  tags: ["client", "launch"],
  sourceClient: "codex",
  createdAt: "2026-07-10T08:00:00.000Z",
  updatedAt: "2026-07-10T08:00:00.000Z",
  archivedAt: null,
  recipeId: "generic_reply",
  recipePayload: null,
  status: "new",
  currentRevision: 1,
  revisionCount: 1,
  reviewedAt: null,
  copiedAt: null,
  doneAt: null,
  expiresAt: null,
  defaultDestination: "markdown",
  provenance: null,
  secretFindings: [],
  availableDestinations: ["plain", "markdown"],
  humanEdited: false
};

describe("DraftRelay MCP App contract", () => {
  it("builds a complete UI payload without leaking unrelated storage fields", () => {
    const content = createCutlineCardStructuredContent(
      item,
      "http://127.0.0.1:3939/?item=item-1"
    );

    expect(content).toEqual({
      item: {
        id: "item-1",
        title: "Client reply",
        contentMarkdown: "Thanks — Friday works for us.",
        kind: "reply",
        project: "ACME",
        tags: ["client", "launch"],
        createdAt: "2026-07-10T08:00:00.000Z",
        url: "http://127.0.0.1:3939/?item=item-1"
      }
    });
    expect(content.item).not.toHaveProperty("sourceClient");
    expect(content.item).not.toHaveProperty("archivedAt");
  });

  it("clones tags so later mutations cannot change the payload", () => {
    const content = createCutlineCardStructuredContent(item, "https://cutline.example/item/item-1");
    item.tags.push("later");

    expect(content.item.tags).toEqual(["client", "launch"]);
    item.tags.pop();
  });

  it("rejects non-HTTP and relative item URLs", () => {
    expect(() => createCutlineCardStructuredContent(item, "javascript:alert(1)")).toThrow(
      "HTTP or HTTPS"
    );
    expect(() => createCutlineCardStructuredContent(item, "/?item=item-1")).toThrow(
      "absolute HTTP(S) URL"
    );
  });

  it("returns fresh modern MCP Apps tool metadata", () => {
    const first = createCutlineCardToolMeta();
    const second = createCutlineCardToolMeta();

    expect(first).toEqual({
      ui: {
        resourceUri: CUTLINE_CARD_RESOURCE_URI,
        visibility: ["model", "app"]
      }
    });
    expect(first).not.toBe(second);
    expect(first.ui).not.toBe(second.ui);
    expect(first.ui.visibility).not.toBe(second.ui.visibility);
  });
});
