import { parseArgs } from "node:util";

import { loadCloudConfig } from "./config.js";
import { createCloudDatabase, createCloudSchemaAttestor } from "./db.js";
import { createCloudLogger } from "./security.js";
import { createStripeBillingService, createStripeClient } from "./stripe-billing.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

const { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length === 0 || positionals.some((value) => !/^evt_[A-Za-z0-9_]+$/.test(value))) {
  process.stderr.write(
    "Usage: pnpm billing:webhook:replay -- evt_STRIPE_EVENT_ID [evt_ANOTHER_ID]\n"
  );
  process.exitCode = 2;
} else {
  const config = loadCloudConfig();
  const logger = createCloudLogger(config);
  const database = createCloudDatabase(config);
  let service: Awaited<ReturnType<typeof createStripeBillingService>>;
  try {
    const attest = await createCloudSchemaAttestor(database);
    await attest();
    const stripeClient = createStripeClient(config);
    service = await createStripeBillingService(config, database, logger, {
      client: stripeClient,
      startWorker: false
    });
    if (!service) throw new Error("Stripe billing is not configured");
    for (const eventId of positionals) {
      await service.replay(eventId);
      logger.info({ stripeEventId: eventId }, "Stripe webhook replay succeeded");
    }
  } catch (error: unknown) {
    logger.fatal({ err: error }, "Stripe webhook replay failed");
    process.exitCode = 1;
  } finally {
    service?.close();
    await database.end().catch(() => undefined);
  }
}
