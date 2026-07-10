import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("server config", () => {
  it("normalizes bracketed IPv6 for Node while preserving a valid public URL", () => {
    const config = loadConfig(
      { HOST: "[::1]", PORT: "4040" },
      { dataDir: "/tmp/ai-dump-config-test" }
    );

    expect(config.host).toBe("::1");
    expect(config.publicBaseUrl).toBe("http://[::1]:4040");
  });

  it("rejects non-loopback hosts and invalid ports", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow("loopback-only");
    expect(() => loadConfig({ PORT: "70000" })).toThrow("PORT");
  });

  it("uses the configured public URL for development links", () => {
    const config = loadConfig({ PUBLIC_BASE_URL: "http://127.0.0.1:5173/" });
    expect(config.publicBaseUrl).toBe("http://127.0.0.1:5173");
  });
});
