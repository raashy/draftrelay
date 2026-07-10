import type { McpServer, ReadResourceCallback, RegisteredResource } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { CUTLINE_CARD_HTML } from "./card-html.js";
import { CUTLINE_CARD_MIME_TYPE, CUTLINE_CARD_RESOURCE_URI } from "./contract.js";
import {
  registerCutlineCardResource,
  type CutlineCardResourceConfig,
  type RegisterAppResource
} from "./register.js";

describe("DraftRelay MCP App resource registration", () => {
  it("passes the exact MCP Apps resource contract to the official helper", async () => {
    const server = {} as Pick<McpServer, "registerResource">;
    let captured:
      | {
          server: Pick<McpServer, "registerResource">;
          name: string;
          uri: string;
          config: CutlineCardResourceConfig;
          read: ReadResourceCallback;
        }
      | undefined;
    const registered = { marker: "registered" } as unknown as RegisteredResource;
    const fakeRegisterAppResource: RegisterAppResource = (
      receivedServer,
      name,
      uri,
      config,
      read
    ) => {
      captured = { server: receivedServer, name, uri, config, read };
      return registered;
    };

    const result = registerCutlineCardResource(server, fakeRegisterAppResource);

    expect(result).toBe(registered);
    expect(captured).toMatchObject({
      server,
      name: "DraftRelay saved output card",
      uri: CUTLINE_CARD_RESOURCE_URI,
      config: {
        mimeType: CUTLINE_CARD_MIME_TYPE,
        _meta: {
          ui: {
            prefersBorder: true,
            permissions: { clipboardWrite: {} }
          }
        }
      }
    });

    const resource = await captured?.read(new URL(CUTLINE_CARD_RESOURCE_URI), {} as never);
    expect(resource).toEqual({
      contents: [
        {
          uri: CUTLINE_CARD_RESOURCE_URI,
          mimeType: CUTLINE_CARD_MIME_TYPE,
          text: CUTLINE_CARD_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              permissions: { clipboardWrite: {} }
            }
          }
        }
      ]
    });
  });
});
