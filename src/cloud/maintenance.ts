import type { Logger } from "pino";
import type { PoolClient } from "pg";

import type { CloudDatabase } from "./db.js";

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export async function runCloudMaintenance(database: CloudDatabase): Promise<void> {
  await database.query(
    `DELETE FROM "oauthAccessToken"
     WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`
  );
  await database.query(
    `DELETE FROM "oauthRefreshToken"
     WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
        OR (revoked IS NOT NULL AND revoked < CURRENT_TIMESTAMP - INTERVAL '7 days')`
  );
  await database.query(
    `DELETE FROM "session"
     WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`
  );
  await database.query(
    `DELETE FROM "verification"
     WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`
  );
  await database.query(
    `DELETE FROM "oauthClientAssertion"
     WHERE "expiresAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'`
  );
  await database.query(
    `DELETE FROM "oauthClient" client
     WHERE client."userId" IS NULL
       AND client."createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 day'
       AND NOT EXISTS (SELECT 1 FROM "oauthConsent" consent WHERE consent."clientId" = client."clientId")
       AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" token WHERE token."clientId" = client."clientId")
       AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" token WHERE token."clientId" = client."clientId")`
  );
  await database.query(
    `DELETE FROM webhook_event
     WHERE status IN ('succeeded', 'ignored')
       AND processed_at < CURRENT_TIMESTAMP - INTERVAL '90 days'`
  );
  await database.query(
    `DELETE FROM webhook_event
     WHERE status = 'dead_letter'
       AND processed_at < CURRENT_TIMESTAMP - INTERVAL '180 days'`
  );
}

export async function runWorkspaceMaintenance(
  client: Pick<PoolClient, "query">,
  workspaceId: string
): Promise<void> {
  await client.query(
    `DELETE FROM usage_counter
     WHERE workspace_id = $1
       AND (
         (metric = 'mcp_requests_minute' AND period_end < CURRENT_TIMESTAMP - INTERVAL '1 day')
         OR (metric <> 'mcp_requests_minute' AND period_end < CURRENT_TIMESTAMP - INTERVAL '90 days')
       )`,
    [workspaceId]
  );
}

export function startCloudMaintenance(database: CloudDatabase, logger: Logger): () => void {
  const run = () => {
    void runCloudMaintenance(database).catch((error: unknown) => {
      logger.warn({ err: error }, "Cloud maintenance failed");
    });
  };
  run();
  const timer = setInterval(run, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export const cloudMaintenanceInternals = { MAINTENANCE_INTERVAL_MS };
