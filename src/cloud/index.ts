import { createServer } from "node:http";

import { createCloudApp } from "./app.js";
import { createCloudAuth } from "./auth.js";
import { loadCloudConfig } from "./config.js";
import {
  createCloudDatabase,
  createCloudSchemaAttestor,
  databaseRoleSafetyIssue,
  inspectCloudDatabaseRole
} from "./db.js";
import { createCloudLogger } from "./security.js";
import { CloudStore } from "./store.js";
import { createCloudRateLimits } from "./rate-limit.js";
import { startCloudMaintenance } from "./maintenance.js";
import {
  createStripeBillingService,
  createStripeCheckoutHandler,
  createStripeClient
} from "./stripe-billing.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

const config = loadCloudConfig();
const logger = createCloudLogger(config);
const database = createCloudDatabase(config);

try {
  await database.query("SELECT 1");
} catch (error: unknown) {
  logger.fatal({ err: error }, "Cloud database is unavailable during startup");
  await database.end().catch(() => undefined);
  throw error;
}

const databaseRole = await inspectCloudDatabaseRole(database);
const databaseRoleIssue = databaseRoleSafetyIssue(databaseRole);
if (databaseRoleIssue) {
  if (config.environment === "production") {
    logger.fatal(
      { databaseRole: databaseRole.name },
      `Unsafe database configuration: ${databaseRoleIssue}`
    );
    await database.end().catch(() => undefined);
    throw new Error(`Unsafe database configuration: ${databaseRoleIssue}`);
  }
  logger.warn(
    { databaseRole: databaseRole.name },
    `Development database role is unsafe for production: ${databaseRoleIssue}`
  );
}

let schemaAttestation: () => Promise<void>;
try {
  schemaAttestation = await createCloudSchemaAttestor(database);
} catch (error: unknown) {
  logger.fatal({ err: error }, "Cloud database schema safety attestation failed during startup");
  await database.end().catch(() => undefined);
  throw error;
}

const rateLimits = await createCloudRateLimits(config);
const stripeClient = createStripeClient(config);
const stripeBilling = await createStripeBillingService(config, database, logger, {
  client: stripeClient
});
const auth = createCloudAuth(config, database, stripeClient);
const store = new CloudStore(database, config);
const { app } = createCloudApp({
  config,
  database,
  schemaAttestation,
  auth,
  logger,
  store,
  rateLimits,
  readinessChecks: [
    rateLimits.ready,
    ...(stripeBilling ? [stripeBilling.ready] : [])
  ],
  ...(stripeBilling ? {
    stripeWebhookHandler: stripeBilling.webhookHandler,
    stripeReconcileUser: stripeBilling.reconcileUser
  } : {}),
  ...(stripeBilling ? {
    stripeCheckoutHandler: createStripeCheckoutHandler(
      config,
      database,
      auth,
      stripeClient,
      stripeBilling.catalog
    )
  } : {})
});
const stopMaintenance = startCloudMaintenance(database, logger);
const server = createServer(app);

server.requestTimeout = 30_000;
server.headersTimeout = 35_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      appUrl: config.appUrl,
      mcpUrl: config.mcpUrl
    },
    "Cloud server is ready"
  );
});

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Cloud server is shutting down");

  const forceTimer = setTimeout(() => {
    logger.error("Cloud shutdown deadline exceeded; closing active connections");
    server.closeAllConnections();
  }, 10_000);
  forceTimer.unref();

  await new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) logger.error({ err: error }, "Cloud HTTP server did not close cleanly");
      resolve();
    });
    server.closeIdleConnections();
  });

  clearTimeout(forceTimer);
  stopMaintenance();
  stripeBilling?.close();
  await database.end().catch((error: unknown) => {
    logger.error({ err: error }, "Cloud database pool did not close cleanly");
  });
  await rateLimits.close().catch((error: unknown) => {
    logger.error({ err: error }, "Cloud rate-limit store did not close cleanly");
  });
}

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});
process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});
