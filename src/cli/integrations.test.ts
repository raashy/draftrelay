import { describe, expect, it } from "vitest";

import { clientCommands, commandDisplay, normalizeClients } from "./integrations.js";

describe("MCP client integration commands", () => {
  it("uses the official Claude Code stdio option ordering", () => {
    const add = clientCommands("claude").add;
    expect(add).toEqual({
      command: "claude",
      args: [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "draftrelay",
        "--",
        "draftrelay",
        "mcp",
        "--client",
        "claude-code"
      ]
    });
  });

  it("uses Codex's stdio command form and forwards explicit storage", () => {
    const add = clientCommands("codex", { dataDir: "/tmp/Cutline data" }).add;
    expect(add.args).toEqual([
      "mcp",
      "add",
      "draftrelay",
      "--",
      "draftrelay",
      "mcp",
      "--data-dir",
      "/tmp/Cutline data",
      "--client",
      "codex"
    ]);
    expect(commandDisplay(add)).toContain("'/tmp/Cutline data'");
  });

  it("can address the v0.2 executable and registration during a managed migration", () => {
    const commands = clientCommands("claude", {
      executable: "cutline",
      serverName: "cutline"
    });
    expect(commands.get.args).toEqual(["mcp", "get", "cutline"]);
    expect(commands.add.args).toContain("cutline");
    expect(commands.remove.args).toEqual(["mcp", "remove", "--scope", "user", "cutline"]);
  });

  it("normalizes repeated and comma-separated client selections", () => {
    expect(normalizeClients(["claude,codex", "claude"], [])).toEqual(["claude", "codex"]);
    expect(normalizeClients(["none"], ["claude"])).toEqual([]);
    expect(() => normalizeClients(["unknown"], [])).toThrow("--client");
  });
});
