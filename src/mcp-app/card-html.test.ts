import { describe, expect, it } from "vitest";

import { CUTLINE_CARD_HTML } from "./card-html.js";

describe("DraftRelay MCP App card HTML", () => {
  it("is a complete single-file document with a restrictive CSP", () => {
    expect(CUTLINE_CARD_HTML).toContain("<!doctype html>");
    expect(CUTLINE_CARD_HTML).toContain('http-equiv="Content-Security-Policy"');
    expect(CUTLINE_CARD_HTML).toContain("default-src 'none'");
    expect(CUTLINE_CARD_HTML).toContain("connect-src 'none'");
    expect(CUTLINE_CARD_HTML).toContain("object-src 'none'");
    expect(CUTLINE_CARD_HTML).not.toMatch(/<script\s+[^>]*src=/i);
    expect(CUTLINE_CARD_HTML).not.toMatch(/<link\s+[^>]*href=/i);
    expect(CUTLINE_CARD_HTML).not.toMatch(/<iframe\b/i);
    expect(CUTLINE_CARD_HTML).not.toContain("fetch(");
    expect(CUTLINE_CARD_HTML).not.toContain("XMLHttpRequest");
  });

  it("uses the standard MCP Apps handshake and result notifications", () => {
    expect(CUTLINE_CARD_HTML).toContain('var PROTOCOL_VERSION = "2026-01-26"');
    expect(CUTLINE_CARD_HTML).toContain('sendRequest("ui/initialize"');
    expect(CUTLINE_CARD_HTML).toContain('sendNotification("ui/notifications/initialized"');
    expect(CUTLINE_CARD_HTML).toContain('message.method === "ui/notifications/tool-input"');
    expect(CUTLINE_CARD_HTML).toContain('message.method === "ui/notifications/tool-result"');
    expect(CUTLINE_CARD_HTML).toContain('message.method === "ui/resource-teardown"');
    expect(CUTLINE_CARD_HTML).toContain('sendRequest("ui/open-link"');
  });

  it("accepts bridge messages only from the parent and validates outbound item URLs", () => {
    expect(CUTLINE_CARD_HTML).toContain("event.source !== window.parent");
    expect(CUTLINE_CARD_HTML).toContain('parsed.protocol !== "http:"');
    expect(CUTLINE_CARD_HTML).toContain('parsed.protocol !== "https:"');
    expect(CUTLINE_CARD_HTML).not.toContain("javascript:");
  });

  it("never assigns untrusted content through innerHTML", () => {
    expect(CUTLINE_CARD_HTML).toContain("node.textContent = text");
    expect(CUTLINE_CARD_HTML).toContain("contentElement.replaceChildren(fragment)");
    expect(CUTLINE_CARD_HTML).not.toMatch(/\.innerHTML\s*=/);
    expect(CUTLINE_CARD_HTML).not.toContain("eval(");
    expect(CUTLINE_CARD_HTML).not.toContain("new Function(");
  });

  it("contains valid JavaScript after TypeScript string escaping", () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(CUTLINE_CARD_HTML)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) {
      throw new Error("Card script was not found");
    }
    expect(() => new Function(script)).not.toThrow();
  });
});
