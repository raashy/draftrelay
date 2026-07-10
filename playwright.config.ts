import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, "");
const baseURL = externalBaseUrl ?? "http://localhost:3941";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    channel: "chrome",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: "MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay pnpm db:migrate && MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime && NODE_ENV=development HOST=127.0.0.1 PORT=3941 APP_URL=http://localhost:3941 DATABASE_URL=postgres://draftrelay_app:draftrelay_app@localhost:5432/draftrelay REDIS_URL=redis://localhost:6380 BETTER_AUTH_SECRET=development-only-auth-secret-change-me-now pnpm dev:cloud",
        url: "http://localhost:3941/health/ready",
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe"
      }
});
