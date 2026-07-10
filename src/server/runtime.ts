import type { Server as HttpServer } from "node:http";
import { chmodSync, existsSync } from "node:fs";

import { createApp, type AppInstance, type CreateAppOptions } from "./app.js";

export interface HttpRuntime {
  instance: AppInstance;
  server: HttpServer;
  close: () => Promise<void>;
}

export async function startHttpServer(options: CreateAppOptions = {}): Promise<HttpRuntime> {
  const instance = createApp(options);
  if (process.platform !== "win32") {
    for (const filePath of [
      instance.config.databasePath,
      `${instance.config.databasePath}-wal`,
      `${instance.config.databasePath}-shm`
    ]) {
      if (existsSync(filePath)) {
        chmodSync(filePath, 0o600);
      }
    }
  }
  const server = instance.app.listen(instance.config.port, instance.config.host);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error: unknown) {
    instance.close();
    throw error;
  }

  let closed = false;
  return {
    instance,
    server,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }).finally(() => instance.close());
    }
  };
}
