import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import Redis from "ioredis";
import { RedisStore, type RedisReply } from "rate-limit-redis";

import type { CloudConfig } from "./config.js";

export interface CloudRateLimits {
  api: RequestHandler;
  mcp: RequestHandler;
  ready: () => Promise<void>;
  close: () => Promise<void>;
}

function handler(code: string, message: string): RequestHandler {
  return (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.status(429).json({ error: { code, message } });
  };
}

export async function createCloudRateLimits(config: CloudConfig): Promise<CloudRateLimits> {
  const redis = config.redisUrl
    ? new Redis(config.redisUrl, {
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        commandTimeout: 2_000,
        connectionName: "draftrelay-rate-limit"
      })
    : undefined;

  if (redis) {
    redis.on("error", () => undefined);
    await redis.connect();
  }

  const store = (prefix: string) => redis
    ? new RedisStore({
        prefix: `draftrelay:limit:${prefix}:`,
        sendCommand: (...args: string[]) =>
          redis.call(args[0]!, ...args.slice(1)) as Promise<RedisReply>
      })
    : undefined;

  const common = {
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
    passOnStoreError: false,
    validate: { xForwardedForHeader: false }
  };

  const api = rateLimit({
    ...common,
    windowMs: 60_000,
    limit: 180,
    store: store("api"),
    handler: handler("rate_limited", "Too many API requests. Try again shortly.")
  });
  const mcp = rateLimit({
    ...common,
    windowMs: 60_000,
    limit: 300,
    store: store("mcp"),
    handler: handler("mcp_rate_limited", "Too many MCP requests. Try again shortly.")
  });

  return {
    api,
    mcp,
    async ready() {
      if (redis && await redis.ping() !== "PONG") {
        throw new Error("Redis readiness check failed");
      }
    },
    async close() {
      if (redis) await redis.quit().catch(() => undefined);
    }
  };
}
