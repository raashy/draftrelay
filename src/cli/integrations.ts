import { spawnSync } from "node:child_process";

import { findExecutable } from "./platform.js";

export const MCP_CLIENTS = ["claude", "codex"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export interface CommandSpec {
  command: string;
  args: string[];
}

export function clientCommands(
  client: McpClient,
  options: { dataDir?: string; executable?: string; serverName?: string } = {}
): { get: CommandSpec; add: CommandSpec; remove: CommandSpec } {
  const executable = options.executable ?? "draftrelay";
  const serverName = options.serverName ?? "draftrelay";
  const serverArguments = [executable, "mcp"];
  if (options.dataDir !== undefined) {
    serverArguments.push("--data-dir", options.dataDir);
  }
  serverArguments.push("--client", client === "claude" ? "claude-code" : "codex");

  if (client === "claude") {
    return {
      get: { command: "claude", args: ["mcp", "get", serverName] },
      add: {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          serverName,
          "--",
          ...serverArguments
        ]
      },
      remove: {
        command: "claude",
        args: ["mcp", "remove", "--scope", "user", serverName]
      }
    };
  }

  return {
    get: { command: "codex", args: ["mcp", "get", serverName] },
    add: { command: "codex", args: ["mcp", "add", serverName, "--", ...serverArguments] },
    remove: { command: "codex", args: ["mcp", "remove", serverName] }
  };
}

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export function runCommand(specification: CommandSpec): CommandResult {
  const result = spawnSync(specification.command, specification.args, {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    windowsHide: true
  });
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
    status: result.status
  };
}

export function commandDisplay(specification: CommandSpec): string {
  const quote = (value: string): string =>
    /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  return [specification.command, ...specification.args].map(quote).join(" ");
}

export function installedClients(): McpClient[] {
  return MCP_CLIENTS.filter((client) => findExecutable(client) !== undefined);
}

export function normalizeClients(values: string[] | undefined, fallback: McpClient[]): McpClient[] {
  if (values === undefined || values.length === 0) {
    return fallback;
  }
  const requested = values.flatMap((value) => value.split(",")).map((value) => value.trim());
  if (requested.includes("none")) {
    return [];
  }
  if (requested.includes("all")) {
    return [...MCP_CLIENTS];
  }
  for (const client of requested) {
    if (!(MCP_CLIENTS as readonly string[]).includes(client)) {
      throw new Error(`--client must be claude, codex, all, or none; received ${client}`);
    }
  }
  return [...new Set(requested)] as McpClient[];
}
