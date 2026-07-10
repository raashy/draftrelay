import type {
  McpServer,
  ReadResourceCallback,
  RegisteredResource,
  ResourceMetadata
} from "@modelcontextprotocol/sdk/server/mcp.js";

import { CUTLINE_CARD_HTML } from "./card-html.js";
import { CUTLINE_CARD_MIME_TYPE, CUTLINE_CARD_RESOURCE_URI } from "./contract.js";

export interface CutlineCardUiResourceMeta {
  prefersBorder: boolean;
  permissions: {
    clipboardWrite: Record<string, never>;
  };
}

export type CutlineCardResourceConfig = ResourceMetadata & {
  mimeType: string;
  _meta: {
    ui: CutlineCardUiResourceMeta;
  };
};

/**
 * Structural type of `registerAppResource` from
 * `@modelcontextprotocol/ext-apps/server`. Keeping it injected lets this
 * isolated module compile and test before that package is wired by the server.
 */
export type RegisterAppResource = (
  server: Pick<McpServer, "registerResource">,
  name: string,
  uri: string,
  config: CutlineCardResourceConfig,
  readCallback: ReadResourceCallback
) => RegisteredResource;

function createUiMeta(): CutlineCardUiResourceMeta {
  return {
    prefersBorder: true,
    permissions: {
      clipboardWrite: {}
    }
  };
}

export function createCutlineCardResourceConfig(): CutlineCardResourceConfig {
  return {
    description: "Review and copy the output that was just saved to DraftRelay.",
    mimeType: CUTLINE_CARD_MIME_TYPE,
    _meta: {
      ui: createUiMeta()
    }
  };
}

export const readCutlineCardResource: ReadResourceCallback = async () => ({
  contents: [
    {
      uri: CUTLINE_CARD_RESOURCE_URI,
      mimeType: CUTLINE_CARD_MIME_TYPE,
      text: CUTLINE_CARD_HTML,
      _meta: {
        ui: createUiMeta()
      }
    }
  ]
});

/**
 * Registers the static card through the official MCP Apps server helper.
 *
 * @example
 * ```ts
 * import { registerAppResource } from "@modelcontextprotocol/ext-apps/server";
 * registerCutlineCardResource(server, registerAppResource);
 * ```
 */
export function registerCutlineCardResource(
  server: Pick<McpServer, "registerResource">,
  registerAppResource: RegisterAppResource
): RegisteredResource {
  return registerAppResource(
    server,
    "DraftRelay saved output card",
    CUTLINE_CARD_RESOURCE_URI,
    createCutlineCardResourceConfig(),
    readCutlineCardResource
  );
}
