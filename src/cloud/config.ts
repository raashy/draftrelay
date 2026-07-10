import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const postgresUrl = z.string().url().refine(
  (value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol),
  "DATABASE_URL must use postgres:// or postgresql://"
);
const redisUrl = z.string().url().refine(
  (value) => ["redis:", "rediss:"].includes(new URL(value).protocol),
  "REDIS_URL must use redis:// or rediss://"
).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  },
  "Date must be a real calendar date in YYYY-MM-DD format"
);
const emailFrom = z.string().trim().max(320).refine(
  (value) =>
    !/[\r\n]/.test(value) &&
    /^(?:[^<>]{1,100}\s+<)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}>?$/i.test(value) &&
    (value.includes("<") === value.endsWith(">")),
  "EMAIL_FROM must be an email address or Name <email@example.com>"
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().trim().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3941),
    APP_NAME: z.string().trim().min(2).max(80).default("DraftRelay"),
    APP_URL: z.string().url().default("http://localhost:3941"),
    LEGAL_NAME: z.string().trim().min(2).max(160).optional(),
    LEGAL_EMAIL: z.string().email().optional(),
    LEGAL_JURISDICTION: z.string().trim().min(2).max(160).optional(),
    LEGAL_EFFECTIVE_DATE: isoDate.optional(),
    DATABASE_URL: postgresUrl.default("postgres://draftrelay:draftrelay@localhost:5432/draftrelay"),
    REDIS_URL: redisUrl,
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    TRUSTED_ORIGINS: z.string().optional(),
    TRUSTED_PROXY_IPS: z.string().optional(),
    STRIPE_SECRET_KEY: z.string().regex(/^(?:sk|rk)_(?:test|live)_/, "Invalid Stripe secret key").optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    STRIPE_PRO_MONTHLY_LOOKUP_KEY: z.string().default("draftrelay_pro_monthly"),
    STRIPE_PRO_YEARLY_LOOKUP_KEY: z.string().default("draftrelay_pro_yearly"),
    RESEND_API_KEY: z.string().startsWith("re_").optional(),
    EMAIL_FROM: emailFrom.optional(),
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    TURNSTILE_SITE_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    FREE_MONTHLY_SAVES: positiveInteger.default(500),
    FREE_DAILY_SAVES: positiveInteger.default(50),
    FREE_STORED_ITEMS: positiveInteger.default(2_000),
    FREE_STORAGE_BYTES: positiveInteger.default(10 * 1024 * 1024),
    PAID_MONTHLY_SAVES: positiveInteger.default(10_000),
    PAID_DAILY_SAVES: positiveInteger.default(1_000),
    PAID_STORED_ITEMS: positiveInteger.default(50_000),
    PAID_STORAGE_BYTES: positiveInteger.default(250 * 1024 * 1024)
  })
  .superRefine((value, context) => {
    if (Boolean(value.TURNSTILE_SECRET_KEY) !== Boolean(value.TURNSTILE_SITE_KEY)) {
      context.addIssue({
        code: "custom",
        path: [value.TURNSTILE_SECRET_KEY ? "TURNSTILE_SITE_KEY" : "TURNSTILE_SECRET_KEY"],
        message: "TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY must be configured together"
      });
    }
    const appUrl = new URL(value.APP_URL);
    if (
      appUrl.username || appUrl.password || appUrl.search || appUrl.hash ||
      (appUrl.pathname !== "" && appUrl.pathname !== "/")
    ) {
      context.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "APP_URL must be an origin without credentials, a path, a query, or a fragment"
      });
    }
    if (value.NODE_ENV !== "production") return;
    for (const key of [
      "BETTER_AUTH_SECRET",
      "REDIS_URL",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "EMAIL_FROM",
      "TURNSTILE_SECRET_KEY",
      "TURNSTILE_SITE_KEY",
      "LEGAL_NAME",
      "LEGAL_EMAIL",
      "LEGAL_JURISDICTION",
      "LEGAL_EFFECTIVE_DATE"
    ] as const) {
      if (!value[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production`
        });
      }
    }
    if (!value.APP_URL.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        path: ["APP_URL"],
        message: "APP_URL must use HTTPS in production"
      });
    }
    const databaseSslModes = new URL(value.DATABASE_URL).searchParams
      .getAll("sslmode")
      .map((mode) => mode.toLowerCase());
    if (
      databaseSslModes.length !== 1 ||
      !["require", "verify-ca", "verify-full"].includes(databaseSslModes[0] ?? "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL must require TLS in production with sslmode=require, verify-ca, or verify-full"
      });
    }
    if (value.REDIS_URL && new URL(value.REDIS_URL).protocol !== "rediss:") {
      context.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL must use rediss:// in production"
      });
    }
    if (value.STRIPE_SECRET_KEY && !/^(?:sk|rk)_live_/.test(value.STRIPE_SECRET_KEY)) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY must be a live-mode key in production"
      });
    }
  });

export interface TierLimits {
  monthlySaves: number;
  dailySaves: number;
  storedItems: number;
  storageBytes: number;
  activeOAuthClients: number;
  requestsPerMinute: number;
}

export interface CloudConfig {
  environment: "development" | "test" | "production";
  host: string;
  port: number;
  appName: string;
  appUrl: string;
  authUrl: string;
  mcpUrl: string;
  legal: {
    name: string;
    email: string;
    jurisdiction: string;
    effectiveDate: string;
  };
  databaseUrl: string;
  redisUrl?: string;
  authSecret: string;
  trustedOrigins: string[];
  trustedProxyIps: string[];
  passkeyRpId: string;
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    monthlyLookupKey: string;
    yearlyLookupKey: string;
  };
  email?: { apiKey: string; from: string };
  turnstile?: { secretKey: string; siteKey?: string };
  logLevel: string;
  limits: { free: TierLimits; paid: TierLimits };
}

function list(value: string | undefined): string[] {
  return value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(`Invalid trusted origin: ${value}`);
  }
  return url.origin;
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const value = environmentSchema.parse(env);
  const appUrl = normalizeOrigin(value.APP_URL);
  const parsedUrl = new URL(appUrl);
  const localSecret = value.BETTER_AUTH_SECRET ?? "development-only-auth-secret-change-me-now";
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    appName: value.APP_NAME,
    appUrl,
    authUrl: `${appUrl}/api/auth`,
    mcpUrl: `${appUrl}/mcp`,
    legal: {
      name: value.LEGAL_NAME ?? `${value.APP_NAME} local operator`,
      email: value.LEGAL_EMAIL ?? "legal@example.invalid",
      jurisdiction: value.LEGAL_JURISDICTION ?? "the operator's jurisdiction",
      effectiveDate: value.LEGAL_EFFECTIVE_DATE ?? "2026-07-10"
    },
    databaseUrl: value.DATABASE_URL,
    ...(value.REDIS_URL ? { redisUrl: value.REDIS_URL } : {}),
    authSecret: localSecret,
    trustedOrigins: [...new Set([appUrl, ...list(value.TRUSTED_ORIGINS).map(normalizeOrigin)])],
    trustedProxyIps: list(value.TRUSTED_PROXY_IPS),
    passkeyRpId: parsedUrl.hostname,
    ...(value.STRIPE_SECRET_KEY && value.STRIPE_WEBHOOK_SECRET
      ? {
          stripe: {
            secretKey: value.STRIPE_SECRET_KEY,
            webhookSecret: value.STRIPE_WEBHOOK_SECRET,
            monthlyLookupKey: value.STRIPE_PRO_MONTHLY_LOOKUP_KEY,
            yearlyLookupKey: value.STRIPE_PRO_YEARLY_LOOKUP_KEY
          }
        }
      : {}),
    ...(value.RESEND_API_KEY && value.EMAIL_FROM
      ? { email: { apiKey: value.RESEND_API_KEY, from: value.EMAIL_FROM } }
      : {}),
    ...(value.TURNSTILE_SECRET_KEY
      ? {
          turnstile: {
            secretKey: value.TURNSTILE_SECRET_KEY,
            ...(value.TURNSTILE_SITE_KEY ? { siteKey: value.TURNSTILE_SITE_KEY } : {})
          }
        }
      : {}),
    logLevel: value.LOG_LEVEL,
    limits: {
      free: {
        monthlySaves: value.FREE_MONTHLY_SAVES,
        dailySaves: value.FREE_DAILY_SAVES,
        storedItems: value.FREE_STORED_ITEMS,
        storageBytes: value.FREE_STORAGE_BYTES,
        activeOAuthClients: 3,
        requestsPerMinute: 60
      },
      paid: {
        monthlySaves: value.PAID_MONTHLY_SAVES,
        dailySaves: value.PAID_DAILY_SAVES,
        storedItems: value.PAID_STORED_ITEMS,
        storageBytes: value.PAID_STORAGE_BYTES,
        activeOAuthClients: 20,
        requestsPerMinute: 300
      }
    }
  };
}

export const cloudConfigInternals = { environmentSchema, list, normalizeOrigin };
