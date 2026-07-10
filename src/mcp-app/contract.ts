import type { OutputItem } from "../shared/items.js";

export const CUTLINE_CARD_RESOURCE_URI = "ui://cutline/saved-output.html";
export const CUTLINE_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export type CutlineCardItem = Pick<
  OutputItem,
  "id" | "title" | "contentMarkdown" | "kind" | "project" | "tags" | "createdAt"
> & {
  url: string;
};

export interface CutlineCardStructuredContent {
  item: CutlineCardItem;
}

export interface CutlineCardToolMeta {
  ui: {
    resourceUri: string;
    visibility: Array<"model" | "app">;
  };
}

function requireSafeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("DraftRelay card URL must be an absolute HTTP(S) URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("DraftRelay card URL must use HTTP or HTTPS");
  }

  return parsed.toString();
}

/**
 * Builds the UI-oriented tool result payload. MCP Apps hosts deliver
 * `structuredContent` to the view without adding it to model context.
 */
export function createCutlineCardStructuredContent(
  item: OutputItem,
  itemUrl: string
): CutlineCardStructuredContent {
  return {
    item: {
      id: item.id,
      title: item.title,
      contentMarkdown: item.contentMarkdown,
      kind: item.kind,
      project: item.project,
      tags: [...item.tags],
      createdAt: item.createdAt,
      url: requireSafeHttpUrl(itemUrl)
    }
  };
}

/** Fresh metadata for `registerAppTool`; callers may safely let the SDK normalize it. */
export function createCutlineCardToolMeta(): CutlineCardToolMeta {
  return {
    ui: {
      resourceUri: CUTLINE_CARD_RESOURCE_URI,
      visibility: ["model", "app"]
    }
  };
}

export const contractInternals = {
  requireSafeHttpUrl
};
