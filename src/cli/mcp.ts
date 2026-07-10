import { isLoopbackHost, line, parsePort, publicBaseUrl, type CliIo } from "./common.js";
import { getCutlinePaths } from "./paths.js";
import { startStdioServer } from "../server/stdio.js";

export interface McpValues {
  dataDir?: string;
  host?: string;
  port?: string;
  client?: string;
}

export async function runMcp(values: McpValues, io: CliIo): Promise<number> {
  const host = values.host?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("--host must be loopback-only");
  }
  const defaultSourceClient = values.client?.trim();
  if (defaultSourceClient !== undefined && (defaultSourceClient.length === 0 || defaultSourceClient.length > 64)) {
    throw new Error("--client must contain between 1 and 64 characters");
  }
  const port = parsePort(values.port);
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const runtime = await startStdioServer({
    databasePath: paths.databasePath,
    publicBaseUrl: publicBaseUrl(host, port),
    defaultSourceClient,
    onError: (error) => {
      io.stderr(line(`DraftRelay MCP error: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  let resolveShutdown: (() => void) | undefined;
  const onShutdown = (): void => resolveShutdown?.();
  try {
    await new Promise<void>((resolve) => {
      resolveShutdown = resolve;
      process.stdin.once("end", onShutdown);
      process.once("SIGINT", onShutdown);
      process.once("SIGTERM", onShutdown);
    });
  } finally {
    process.stdin.off("end", onShutdown);
    process.off("SIGINT", onShutdown);
    process.off("SIGTERM", onShutdown);
    await runtime.close();
  }
  return 0;
}
