import { createApp } from "./app.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

const instance = createApp();

const httpServer = instance.app.listen(instance.config.port, instance.config.host, () => {
  console.log(`DraftRelay is ready at ${instance.config.publicBaseUrl}`);
  console.log(`MCP endpoint: ${instance.config.publicBaseUrl}/mcp`);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  httpServer.close((error) => {
    instance.close();
    if (error !== undefined) {
      console.error("Failed to close HTTP server cleanly", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
