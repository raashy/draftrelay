import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  publicBaseUrl: string;
  staticDir: string;
  isProduction: boolean;
}

export interface ConfigOverrides {
  host?: string;
  port?: number;
  dataDir?: string;
  databasePath?: string;
  publicBaseUrl?: string;
  staticDir?: string;
  isProduction?: boolean;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3939;

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }

  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function parsePort(rawPort: string | undefined): number {
  if (rawPort === undefined || rawPort.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function hostForUrl(host: string): string {
  if (host === "::1" || host === "[::1]") {
    return "[::1]";
  }

  return host;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {}
): ServerConfig {
  const requestedHost = overrides.host ?? env.HOST?.trim() ?? DEFAULT_HOST;
  if (!isLoopbackHost(requestedHost)) {
    throw new Error(
      `HOST must be loopback-only (127.0.0.1, localhost, or ::1); received ${JSON.stringify(requestedHost)}`
    );
  }
  const host = requestedHost === "[::1]" ? "::1" : requestedHost;

  const port = overrides.port ?? parsePort(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const dataDir = path.resolve(overrides.dataDir ?? env.DATA_DIR ?? "./data");
  const databasePath = overrides.databasePath ?? path.join(dataDir, "ai-dump.sqlite3");
  const staticDir = path.resolve(overrides.staticDir ?? "dist/client");
  const publicBaseUrl = (
    overrides.publicBaseUrl ?? env.PUBLIC_BASE_URL?.trim() ?? `http://${hostForUrl(host)}:${port}`
  ).replace(/\/$/, "");

  return {
    host,
    port,
    dataDir,
    databasePath,
    publicBaseUrl,
    staticDir,
    isProduction: overrides.isProduction ?? env.NODE_ENV === "production"
  };
}

export const configInternals = {
  isLoopbackHost,
  parsePort
};
