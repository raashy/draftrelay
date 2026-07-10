import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createOutputMcpServer } from "./mcp.js";
import { applyWorkspacePolicy } from "./policy-file.js";
import { ItemStore } from "./store.js";

export interface StdioRuntimeOptions {
  databasePath: string;
  publicBaseUrl: string;
  defaultSourceClient?: string;
  onError?: (error: unknown) => void;
  policyFile?: string;
  policySearchFrom?: string | false;
}

export interface StdioRuntime {
  close: () => Promise<void>;
}

export async function startStdioServer(options: StdioRuntimeOptions): Promise<StdioRuntime> {
  const directory = path.dirname(options.databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
  }

  const store = new ItemStore({ databasePath: options.databasePath });
  if (process.platform !== "win32") {
    for (const filePath of [
      options.databasePath,
      `${options.databasePath}-wal`,
      `${options.databasePath}-shm`
    ]) {
      if (existsSync(filePath)) {
        chmodSync(filePath, 0o600);
      }
    }
  }
  try {
    applyWorkspacePolicy(store, {
      explicitPath: options.policyFile,
      searchFrom: options.policySearchFrom
    });
  } catch (error: unknown) {
    store.close();
    throw error;
  }
  const server = createOutputMcpServer({
    store,
    publicBaseUrl: options.publicBaseUrl,
    defaultSourceClient: options.defaultSourceClient
  });
  const transport = new StdioServerTransport();
  let closed = false;

  transport.onclose = () => {
    if (!closed) {
      closed = true;
      store.close();
    }
  };
  transport.onerror = (error) => options.onError?.(error);

  try {
    await server.connect(transport);
  } catch (error: unknown) {
    store.close();
    throw error;
  }

  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await server.close();
      } finally {
        store.close();
      }
    }
  };
}
