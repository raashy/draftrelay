import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { clientCommands, MCP_CLIENTS, runCommand } from "./integrations.js";
import {
  isLoopbackHost,
  line,
  parsePort,
  publicBaseUrl,
  resolveStaticDir,
  type CliIo
} from "./common.js";
import { getCutlinePaths } from "./paths.js";
import { findExecutable } from "./platform.js";

type CheckLevel = "ok" | "warning" | "error";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  message: string;
}

export interface DoctorValues {
  dataDir?: string;
  host?: string;
  port?: string;
  staticDir?: string;
  json?: boolean;
}

function nodeCheck(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 12);
  return {
    name: "node",
    level: supported ? "ok" : "error",
    message: supported
      ? `Node ${process.versions.node}`
      : `Node ${process.versions.node} is unsupported; install Node 22.12 or newer`
  };
}

function pathCheck(name: string, targetPath: string, file = false): DoctorCheck {
  if (!existsSync(targetPath)) {
    return { name, level: "warning", message: `${targetPath} does not exist yet` };
  }
  try {
    accessSync(targetPath, file ? constants.R_OK | constants.W_OK : constants.R_OK | constants.W_OK);
    if (process.platform !== "win32") {
      const permissions = statSync(targetPath).mode & 0o777;
      if ((permissions & 0o077) !== 0) {
        return {
          name,
          level: "warning",
          message: `${targetPath} permissions are ${permissions.toString(8)}; prefer ${file ? "600" : "700"}`
        };
      }
    }
    return { name, level: "ok", message: targetPath };
  } catch (error: unknown) {
    return {
      name,
      level: "error",
      message: `${targetPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function databaseCheck(databasePath: string): DoctorCheck {
  if (!existsSync(databasePath)) {
    return {
      name: "database",
      level: "warning",
      message: `${databasePath} does not exist yet; save an item to create it`
    };
  }
  let database: Database.Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const result = String(database.pragma("quick_check", { simple: true }));
    return {
      name: "database",
      level: result.toLowerCase() === "ok" ? "ok" : "error",
      message: result.toLowerCase() === "ok" ? "SQLite quick_check passed" : `SQLite quick_check: ${result}`
    };
  } catch (error: unknown) {
    return {
      name: "database",
      level: "error",
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    database?.close();
  }
}

async function serverCheck(baseUrl: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(800)
    });
    const body = response.ok
      ? ((await response.json()) as { status?: unknown; storage?: unknown })
      : undefined;
    const healthy = response.ok && body?.status === "ok" && body.storage === "ok";
    return {
      name: "server",
      level: healthy ? "ok" : "warning",
      message: healthy ? `Healthy at ${baseUrl}` : `${baseUrl} is not a DraftRelay health endpoint`
    };
  } catch {
    return { name: "server", level: "warning", message: `Not running at ${baseUrl}` };
  }
}

function clipboardCheck(): DoctorCheck {
  const candidates =
    process.platform === "darwin"
      ? ["pbcopy"]
      : process.platform === "win32"
        ? ["powershell.exe"]
        : ["wl-copy", "xclip", "xsel"];
  const available = candidates.find((candidate) => findExecutable(candidate) !== undefined);
  return available === undefined
    ? {
        name: "clipboard",
        level: "warning",
        message: `No clipboard helper found (${candidates.join(", ")})`
      }
    : { name: "clipboard", level: "ok", message: available };
}

export async function collectDoctorChecks(values: DoctorValues): Promise<DoctorCheck[]> {
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const port = parsePort(values.port);
  const host = values.host?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("--host must be loopback-only");
  }
  const staticDir = path.resolve(values.staticDir ?? resolveStaticDir());
  const checks: DoctorCheck[] = [
    nodeCheck(),
    pathCheck("data directory", paths.dataDir),
    databaseCheck(paths.databasePath),
    {
      name: "web assets",
      level: existsSync(path.join(staticDir, "index.html")) ? "ok" : "error",
      message: existsSync(path.join(staticDir, "index.html"))
        ? staticDir
        : `Missing ${path.join(staticDir, "index.html")}`
    },
    clipboardCheck(),
    await serverCheck(publicBaseUrl(host, port))
  ];

  for (const client of MCP_CLIENTS) {
    if (findExecutable(client) === undefined) {
      checks.push({ name: client, level: "warning", message: `${client} is not on PATH` });
      continue;
    }
    const registration = runCommand(clientCommands(client).get);
    checks.push({
      name: client,
      level: registration.ok ? "ok" : "warning",
      message: registration.ok ? "DraftRelay MCP registration found" : "DraftRelay MCP registration not found"
    });
  }
  return checks;
}

export async function runDoctor(values: DoctorValues, io: CliIo): Promise<number> {
  const checks = await collectDoctorChecks(values);
  if (values.json === true) {
    io.stdout(`${JSON.stringify({ checks }, null, 2)}\n`);
  } else {
    for (const check of checks) {
      const marker = check.level === "ok" ? "✓" : check.level === "warning" ? "!" : "✗";
      io.stdout(line(`${marker} ${check.name}: ${check.message}`));
    }
  }
  return checks.some((check) => check.level === "error") ? 1 : 0;
}

export const doctorInternals = {
  clipboardCheck,
  databaseCheck,
  nodeCheck,
  pathCheck,
  serverCheck
};
