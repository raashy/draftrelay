import { describe, expect, it } from "vitest";

import { loadCloudConfig } from "./config.js";

describe("cloud configuration", () => {
  it("provides safe development defaults and concrete free/paid limits", () => {
    const config = loadCloudConfig({ NODE_ENV: "test" });
    expect(config.appUrl).toBe("http://localhost:3941");
    expect(config.mcpUrl).toBe("http://localhost:3941/mcp");
    expect(config.limits.free.monthlySaves).toBe(500);
    expect(config.limits.paid.monthlySaves).toBe(10_000);
    expect(config.passkeyRpId).toBe("localhost");
  });

  it("normalizes trusted origins and proxy IPs", () => {
    const config = loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "https://app.draftrelay.com/",
      TRUSTED_ORIGINS: "https://preview.draftrelay.com, https://app.draftrelay.com",
      TRUSTED_PROXY_IPS: "10.0.0.1,10.0.0.0/24"
    });
    expect(config.trustedOrigins).toEqual([
      "https://app.draftrelay.com",
      "https://preview.draftrelay.com"
    ]);
    expect(config.trustedProxyIps).toEqual(["10.0.0.1", "10.0.0.0/24"]);
  });

  it("rejects application URLs that are not exact origins", () => {
    expect(() => loadCloudConfig({
      NODE_ENV: "test",
      APP_URL: "https://user:secret@app.draftrelay.com/path?x=1"
    })).toThrow(/APP_URL/);
    expect(() => loadCloudConfig({
      NODE_ENV: "test",
      TRUSTED_ORIGINS: "javascript:alert(1)"
    })).toThrow(/Invalid trusted origin/);
  });

  it("fails closed when production secrets or HTTPS are missing", () => {
    expect(() => loadCloudConfig({ NODE_ENV: "production" })).toThrow();
  });

  it("accepts a complete production configuration without weakening defaults", () => {
    const config = loadCloudConfig({
      NODE_ENV: "production",
      APP_URL: "https://relay.example.com",
      DATABASE_URL: "postgresql://draftrelay_app:secret@db.example.com/draftrelay?sslmode=require",
      REDIS_URL: "rediss://cache.example.com:6379",
      BETTER_AUTH_SECRET: "a-production-secret-that-is-longer-than-32-characters",
      STRIPE_SECRET_KEY: "sk_live_example",
      STRIPE_WEBHOOK_SECRET: "whsec_example",
      RESEND_API_KEY: "re_example",
      EMAIL_FROM: "DraftRelay <hello@example.com>",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: "turnstile-site",
      LEGAL_NAME: "Example Company LLC",
      LEGAL_EMAIL: "legal@example.com",
      LEGAL_JURISDICTION: "Dubai, United Arab Emirates",
      LEGAL_EFFECTIVE_DATE: "2026-07-10"
    });
    expect(config.environment).toBe("production");
    expect(config.appUrl).toBe("https://relay.example.com");
    expect(config.legal.name).toBe("Example Company LLC");
    expect(config.turnstile?.siteKey).toBe("turnstile-site");
  });

  it("requires encrypted PostgreSQL and Redis connections in production", () => {
    const completeProduction = {
      NODE_ENV: "production",
      APP_URL: "https://relay.example.com",
      DATABASE_URL: "postgresql://draftrelay_app:secret@db.example.com/draftrelay?sslmode=require",
      REDIS_URL: "rediss://cache.example.com:6379",
      BETTER_AUTH_SECRET: "a-production-secret-that-is-longer-than-32-characters",
      STRIPE_SECRET_KEY: "sk_live_example",
      STRIPE_WEBHOOK_SECRET: "whsec_example",
      RESEND_API_KEY: "re_example",
      EMAIL_FROM: "DraftRelay <hello@example.com>",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: "turnstile-site",
      LEGAL_NAME: "Example Company LLC",
      LEGAL_EMAIL: "legal@example.com",
      LEGAL_JURISDICTION: "Dubai, United Arab Emirates",
      LEGAL_EFFECTIVE_DATE: "2026-07-10"
    } satisfies NodeJS.ProcessEnv;

    expect(() => loadCloudConfig({
      ...completeProduction,
      DATABASE_URL: "postgresql://draftrelay_app:secret@db.example.com/draftrelay"
    })).toThrow(/DATABASE_URL must require TLS/);
    expect(() => loadCloudConfig({
      ...completeProduction,
      DATABASE_URL: "postgresql://draftrelay_app:secret@db.example.com/draftrelay?sslmode=require&sslmode=disable"
    })).toThrow(/DATABASE_URL must require TLS/);
    expect(() => loadCloudConfig({
      ...completeProduction,
      REDIS_URL: "redis://cache.example.com:6379"
    })).toThrow(/REDIS_URL must use rediss/);
    expect(() => loadCloudConfig({
      ...completeProduction,
      STRIPE_SECRET_KEY: "sk_test_wrong-environment"
    })).toThrow(/live-mode key/);
  });

  it("requires Turnstile in production", () => {
    expect(() => loadCloudConfig({
      NODE_ENV: "production",
      APP_URL: "https://relay.example.com",
      DATABASE_URL: "postgresql://draftrelay_app:secret@db.example.com/draftrelay?sslmode=require",
      REDIS_URL: "rediss://cache.example.com:6379",
      BETTER_AUTH_SECRET: "a-production-secret-that-is-longer-than-32-characters",
      STRIPE_SECRET_KEY: "sk_live_example",
      STRIPE_WEBHOOK_SECRET: "whsec_example",
      RESEND_API_KEY: "re_example",
      EMAIL_FROM: "DraftRelay <hello@example.com>",
      LEGAL_NAME: "Example Company LLC",
      LEGAL_EMAIL: "legal@example.com",
      LEGAL_JURISDICTION: "Dubai, United Arab Emirates",
      LEGAL_EFFECTIVE_DATE: "2026-07-10"
    })).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it("requires both Turnstile keys and accepts a display-name email sender", () => {
    expect(() => loadCloudConfig({
      NODE_ENV: "test",
      TURNSTILE_SECRET_KEY: "turnstile-secret"
    })).toThrow(/configured together/);

    const config = loadCloudConfig({
      NODE_ENV: "test",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: "turnstile-site",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "DraftRelay <hello@example.com>"
    });
    expect(config.turnstile).toEqual({
      secretKey: "turnstile-secret",
      siteKey: "turnstile-site"
    });
    expect(config.email?.from).toBe("DraftRelay <hello@example.com>");
  });

  it("rejects header injection in the email sender", () => {
    expect(() => loadCloudConfig({
      NODE_ENV: "test",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "hello@example.com\r\nBcc: attacker@example.com"
    })).toThrow();
  });
});
