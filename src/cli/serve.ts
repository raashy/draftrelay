import path from "node:path";

import { startHttpServer } from "../server/runtime.js";
import { isLoopbackHost, line, parsePort, publicBaseUrl, resolveStaticDir, type CliIo } from "./common.js";
import { getCutlinePaths } from "./paths.js";
import { openInBrowser } from "./platform.js";

export interface ServeValues {
  dataDir?: string;
  host?: string;
  port?: string;
  staticDir?: string;
  open?: boolean;
}

export async function runServe(values: ServeValues, io: CliIo): Promise<number> {
  const host = values.host?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("--host must be a loopback address (127.0.0.1, localhost, or ::1)");
  }
  const port = parsePort(values.port);
  const baseUrl = publicBaseUrl(host, port);
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const staticDir = path.resolve(values.staticDir ?? resolveStaticDir());
  const runtime = await startHttpServer({
    host,
    port,
    dataDir: paths.dataDir,
    databasePath: paths.databasePath,
    publicBaseUrl: baseUrl,
    staticDir,
    isProduction: true
  });

  io.stdout(line(`DraftRelay is ready at ${baseUrl}`));
  io.stdout(line(`MCP endpoint: ${baseUrl}/mcp`));
  if (values.open === true) {
    try {
      await openInBrowser(baseUrl);
    } catch (error: unknown) {
      io.stderr(line(`Could not open the browser: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  let resolveShutdown: (() => void) | undefined;
  const onShutdown = (): void => resolveShutdown?.();
  try {
    await new Promise<void>((resolve) => {
      resolveShutdown = resolve;
      process.once("SIGINT", onShutdown);
      process.once("SIGTERM", onShutdown);
    });
  } finally {
    process.off("SIGINT", onShutdown);
    process.off("SIGTERM", onShutdown);
    await runtime.close();
  }
  return 0;
}

export interface OpenValues extends Omit<ServeValues, "open"> {
  itemId?: string;
  noStart?: boolean;
}

async function serverIsHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(800)
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: unknown; storage?: unknown };
    return body.status === "ok" && body.storage === "ok";
  } catch {
    return false;
  }
}

export async function runOpen(values: OpenValues, io: CliIo): Promise<number> {
  const host = values.host?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("--host must be loopback-only");
  }
  const port = parsePort(values.port);
  const baseUrl = publicBaseUrl(host, port);
  if (values.itemId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(values.itemId)) {
    throw new Error("The item ID is invalid");
  }
  const target =
    values.itemId === undefined
      ? baseUrl
      : `${baseUrl}/?item=${encodeURIComponent(values.itemId)}`;

  if (await serverIsHealthy(baseUrl)) {
    await openInBrowser(target);
    return 0;
  }
  if (values.noStart === true) {
    throw new Error(`DraftRelay is not running at ${baseUrl}. Run draftrelay serve first.`);
  }

  io.stderr(line(`DraftRelay is not running; starting it at ${baseUrl}. Press Ctrl+C to stop.`));
  const openTarget = values.itemId === undefined ? true : false;
  if (openTarget) {
    return runServe({ ...values, open: true }, io);
  }

  const browserPromise = (async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await serverIsHealthy(baseUrl)) {
        await openInBrowser(target);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })().catch((error: unknown) => {
    io.stderr(line(`Could not open the browser: ${error instanceof Error ? error.message : String(error)}`));
  });
  const result = await runServe({ ...values, open: false }, io);
  await browserPromise;
  return result;
}

export const serveInternals = {
  serverIsHealthy
};
