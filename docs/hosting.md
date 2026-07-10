# Hosting and operations

This guide describes how to operate the hosted DraftRelay source. It is a deployment checklist, not evidence that a public service or prebuilt container image exists.

The included `compose.yaml` is for development. Production operators must supply secure PostgreSQL, Redis, HTTPS ingress, secrets, backups, transactional email, Stripe configuration, monitoring, and legal policies.

## Production prerequisites

- Node.js 22.12+ or an image built from the repository Dockerfile
- PostgreSQL 14+ over TLS, with automated backups and a separate migration owner
- Redis 7+ over TLS, reachable only from the application network
- a stable HTTPS origin and reverse proxy/load balancer
- a secret manager for database, Better Auth, Stripe, and Resend credentials
- a verified sending domain and Resend API key
- Stripe test and live accounts configured separately
- Cloudflare Turnstile site and secret keys for signup abuse protection
- centralized stdout log collection with access controls and retention
- an operator-owned backup, restore, incident-response, and security-contact process

Do not expose PostgreSQL or Redis to the public internet. Do not reuse the Compose passwords, development auth secret, or HTTP origin.

## Environment

`NODE_ENV=production` makes HTTPS, TLS PostgreSQL and Redis connections, Stripe, Resend, Turnstile, and a strong Better Auth secret mandatory. The process refuses to start when those required values are absent.

| Variable | Production | Purpose |
| --- | --- | --- |
| `NODE_ENV` | required | Set to `production`. |
| `HOST` | optional | Private bind address; defaults to `0.0.0.0`. |
| `PORT` | optional | HTTP port; defaults to `3941`. |
| `APP_NAME` | optional | Display name; defaults to `DraftRelay`. |
| `APP_URL` | required | Exact public HTTPS origin, for example `https://relay.example.com`; use no path or query. |
| `LEGAL_NAME` | required | Legal operator name rendered in the public privacy and terms pages. |
| `LEGAL_EMAIL` | required | Monitored legal/privacy contact address. |
| `LEGAL_JURISDICTION` | required | Operator jurisdiction used by the generated terms. Obtain legal review. |
| `LEGAL_EFFECTIVE_DATE` | required | Effective date for privacy and terms in `YYYY-MM-DD` form. |
| `DATABASE_URL` | required | PostgreSQL URL for the non-owner runtime role, with `sslmode=require`, `verify-ca`, or preferably `verify-full`. |
| `REDIS_URL` | required | `rediss://` URL for shared API/MCP rate-limit counters. |
| `BETTER_AUTH_SECRET` | required | Random value of at least 32 characters. Store outside the image and repository. |
| `TRUSTED_ORIGINS` | optional | Comma-separated additional exact browser origins. Keep this list narrow. |
| `TRUSTED_PROXY_IPS` | required behind a proxy | Comma-separated proxy IPs/CIDRs that may supply forwarded client addresses. Never trust the whole internet. |
| `STRIPE_SECRET_KEY` | required | Stripe `sk_live_...` or restricted `rk_live_...` key with only required billing permissions. Test-mode keys are rejected in production. |
| `STRIPE_WEBHOOK_SECRET` | required | Signing secret for this environment's webhook endpoint. |
| `STRIPE_PRO_MONTHLY_LOOKUP_KEY` | optional | Defaults to `draftrelay_pro_monthly`. |
| `STRIPE_PRO_YEARLY_LOOKUP_KEY` | optional | Defaults to `draftrelay_pro_yearly`. |
| `RESEND_API_KEY` | required | Resend key for verification and password-reset messages. |
| `EMAIL_FROM` | required | A verified address, optionally in `DraftRelay <hello@example.com>` form. |
| `TURNSTILE_SECRET_KEY` | required | Cloudflare Turnstile server key for signup abuse protection. |
| `TURNSTILE_SITE_KEY` | required | Public Turnstile widget key paired with the secret key. |
| `LOG_LEVEL` | optional | `fatal`, `error`, `warn`, `info`, `debug`, or `trace`; defaults to `info`. |

The signup page loads the Cloudflare widget and Better Auth verifies its single-use response, expected `signup` action, hostname, and client address. Production refuses missing or one-key configuration. Turnstile supplements email verification, per-address rate limits, per-account quotas, and OAuth-client limits; it does not replace them.

Generate the auth secret without printing or committing it to a project file:

```bash
openssl rand -base64 32
```

Insert the result directly into the deployment secret manager. Treat rotation as a planned incident because it can invalidate authentication state. Keep live and test credentials completely separate.

See [`.env.example`](../.env.example) for development-oriented placeholders. Do not pass a real `.env` into an image build.

## PostgreSQL roles and migrations

Use two database roles:

- a migration owner that can create and alter the schema
- a runtime role with DML access but no ownership, superuser, `CREATEDB`, `CREATEROLE`, or `BYPASSRLS`

Forced row-level security is defense in depth, but only if the running application cannot disable or bypass it. A representative grant pattern is:

```sql
-- Run once as a PostgreSQL administrator; use a generated secret.
CREATE ROLE draftrelay_app LOGIN PASSWORD 'replace-from-secret-manager'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
```

After migrations, the repository helper validates the existing role and grants current/future table and sequence DML while revoking schema creation. It grants read-only migration-history access so startup and readiness can attest the running build:

```bash
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
RUNTIME_DATABASE_ROLE=draftrelay_app \
  pnpm db:grant-runtime
```

The helper must connect as the same migration owner that owns the schema. Keep `draftrelay_app` distinct from that owner; the helper rejects superuser and `BYPASSRLS` roles but the operator must also ensure it owns no application tables. Adapt database and role names to the provider, and rerun/verify grants after every migration. Authentication tables and `webhook_event` are service data without tenant RLS; never grant direct database access to end users.

Migrations are forward-only and do not run at application startup:

```bash
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:migrate
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime
```

The runner:

- acquires a PostgreSQL advisory lock
- applies numbered SQL files in order, one transaction per file
- records names and SHA-256 checksums in `cloud_schema_migration`
- rejects changed, missing, or back-filled migration history
- is safe to run again when the database is current

Before migration, take a tested backup. Apply migrations once with the migration owner, apply/verify runtime grants, then start the matching application build. Never edit a migration that may have run anywhere, delete a migration-history row, or invent a manual down migration during an incident.

Startup compares the complete applied migration list and checksums with the files in the running image, then verifies that every tenant table exists with row-level security forced and the exact expected `USING` and `WITH CHECK` workspace predicates, command, role, and policy mode. `/health/ready` repeats this attestation and also checks PostgreSQL, Redis, and the validated Stripe catalog. A mismatch or unavailable dependency keeps the instance out of service; apply the matching migrations and grants instead of bypassing the check. The production image's Docker health check uses this readiness endpoint, while `/health/live` reports process liveness only.

## Development with Docker

The Compose stack binds all published ports to loopback and uses named volumes:

```bash
docker compose up -d postgres redis
docker compose --profile app build cloud
docker compose --profile app run --rm \
  -e DATABASE_URL=postgres://draftrelay:draftrelay@postgres:5432/draftrelay \
  cloud node dist/cloud/migrate.js
docker compose --profile app run --rm \
  -e MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@postgres:5432/draftrelay \
  -e RUNTIME_DATABASE_ROLE=draftrelay_app \
  cloud node dist/cloud/grant-runtime-role.js
docker compose --profile app up -d cloud
docker compose ps
```

Verify it:

```bash
curl --fail --silent --show-error http://localhost:3941/health/live
curl --fail --silent --show-error http://localhost:3941/health/ready
docker compose exec postgres pg_isready -U draftrelay -d draftrelay
docker compose exec redis redis-cli ping
```

The `cloud` profile intentionally runs in development mode. Build and configure a separate immutable image for production. The Dockerfile runs as the non-root `draftrelay` user, but the platform must still provide a read-only root filesystem where practical, dropped Linux capabilities, resource limits, private networking, and runtime secrets.

On a fresh volume, Compose creates `draftrelay_app` as a non-owner runtime role and the `cloud` service uses it. The owner credential remains a development default used only by the explicit migration/grant commands above. The server also refuses an owner, superuser, `BYPASSRLS`, or `row_security=off` role in production. Replace both Compose passwords and use a managed secret flow before any shared deployment.

`docker compose down` keeps the data volumes. `docker compose down --volumes` destroys them and must never be part of a normal restart or rollback.

## TLS, proxy, and domain constraints

The public origin is an authentication boundary:

- `APP_URL` must exactly match the browser origin used by users and MCP clients.
- Production cookies are secure, and passkeys require a secure context.
- The passkey RP ID is the `APP_URL` hostname. Moving to another hostname can strand existing passkeys.
- OAuth issuer and audience values include the exact origin, `/api/auth`, and `/mcp`. Changing them can invalidate tokens and client registrations.
- Allowed Host checks derive from `APP_URL` and `TRUSTED_ORIGINS`.
- Cookie-authenticated mutations require the exact `APP_URL` origin.
- Native MCP clients may omit `Origin`; any supplied browser `Origin` must exactly match the configured MCP origin or the request is rejected.

Terminate TLS at a trusted proxy and forward the original Host and HTTPS scheme. Configure `TRUSTED_PROXY_IPS` only with the actual proxy addresses so untrusted clients cannot forge `X-Forwarded-For`. Do not use `0.0.0.0/0` or an equivalent universal trust rule.

Do not cache `/api`, `/api/auth`, or `/mcp`. Do not parse or re-encode the Stripe webhook body; signature verification requires the original bytes. Allow `POST` to `/mcp` and `/api/auth/stripe/webhook`, and allow public `GET` access to health and `/.well-known/` discovery routes.

Production responses enable HSTS with `includeSubDomains` and `preload`. Use a domain only when HTTPS is ready for every affected subdomain and the organization accepts the long-lived HSTS commitment. Review this code-level policy before using a shared parent domain.

WebSockets and sticky sessions are not required. Multiple application instances can share PostgreSQL and Redis. Keep proxy request timeouts above the server's 30-second request timeout and drain instances during rollout.

## Better Auth, passkeys, and email

Production signup requires email verification. Password reset and verification messages use Resend.

Before launch:

1. Verify the sending domain with Resend.
2. Publish SPF and DKIM records and establish a DMARC policy.
3. Use a dedicated, monitored sender address in `EMAIL_FROM`.
4. Test verification, expiration, resend, password reset, and revoked-session behavior.
5. Add and use a passkey on each supported browser/device family.
6. Keep password login available as the documented recovery path until a separate recovery design exists.

Passkey credentials are scoped to the RP ID. Do not promise cross-domain passkey portability. A database restore preserves credential records, but users still need authenticators holding the corresponding private keys.

## Stripe pricing and webhooks

The source expects one `pro` product with two recurring USD prices:

| Billing | Amount | Stripe lookup key |
| --- | ---: | --- |
| Monthly | $1.00 each month | `draftrelay_pro_monthly` |
| Yearly | $10.00 each year | `draftrelay_pro_yearly` |

Create equivalent prices separately in Stripe test mode and live mode. Lookup keys point to Price objects; the application does not create products or prices. Startup requires each lookup key to resolve to exactly one active, licensed, recurring USD Price with interval count one, the exact amount above, the expected test/live mode, and a shared active Product. Readiness revalidates that catalog periodically. If replacing a Price, transfer the lookup key deliberately and verify checkout before deactivating the old Price.

The checkout flow enables automatic tax and billing-address collection. It serializes checkout per account, checks Stripe's complete bounded subscription inventory, blocks every nonterminal remote subscription, and reuses any unexpired subscription Checkout Session for that customer/user even if a retry changes monthly/yearly intent. Inventory beyond the bounded ten-page check fails closed. Configure Stripe Tax registrations, product tax behavior, billing portal settings, cancellation policy, and customer communications before live use.

Register this webhook endpoint:

```text
https://your-draftrelay-origin.example/api/auth/stripe/webhook
```

Subscribe at minimum to:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

For local test-mode forwarding:

```bash
stripe listen --forward-to http://localhost:3941/api/auth/stripe/webhook
```

Use the signing secret printed by that `stripe listen` process as the local `STRIPE_WEBHOOK_SECRET`, restart the app, and trigger test events. Production must use the signing secret created for the Dashboard webhook endpoint, not the CLI secret.

DraftRelay verifies the signature against the raw body before recording a minimized webhook envelope and unique provider event ID. After that durable insert commits, it acknowledges the delivery immediately and performs authoritative retrieval/reconciliation asynchronously; invalid signatures, mode mismatch, or a failed durable insert are not acknowledged as successful. Reconciliation retrieves the current Subscription under a per-subscription database lock, so duplicate and out-of-order deliveries cannot restore stale state. Transient failures use bounded exponential retry; permanent ownership/catalog failures and events that exhaust eight attempts move to `dead_letter`. A periodic sweep refreshes nonterminal local subscriptions whose last authoritative sync is older than 15 minutes. Opening the account billing page also lists that user's Stripe subscriptions and recovers a completed Checkout whose webhook was lost.

Only an exact configured Price in `active` or `trialing` state with an authoritative sync less than 24 hours old grants Pro. Stale state falls back to Free limits, including the three-client OAuth cap, until Stripe can be verified again. This deliberately favors under-entitlement over granting paid capacity from an indefinitely stale local row.

Inspect dead letters using a read-only query that does not select the minimized payload:

```sql
SELECT provider_event_id, event_type, attempts, last_error, received_at
FROM webhook_event
WHERE provider = 'stripe' AND status = 'dead_letter'
ORDER BY received_at;
```

After correcting the catalog, ownership, or provider problem, replay a specific stored event with the same runtime environment and schema as the application:

```bash
pnpm build:cloud
pnpm billing:webhook:replay -- evt_STRIPE_EVENT_ID
# Built image equivalent:
node dist/cloud/replay-stripe-webhook.js evt_STRIPE_EVENT_ID
```

Replay accepts only existing `failed` or `dead_letter` Stripe event IDs, revalidates the schema and exact catalog, retrieves current Stripe state, and exits nonzero if reconciliation does not succeed. It does not accept a raw event body. Stripe remains authoritative for billing; after an outage or restore, open affected accounts or replay known failed events instead of assuming the database snapshot is current.

## Rate and quota limits

The hosted source enforces both request-rate limits and account quotas.

### Network and auth rate limits

| Surface | Current limit |
| --- | ---: |
| Protected browser API | 180 requests/minute per client address |
| Hosted MCP | 300 requests/minute per client address |
| Better Auth default | 100 requests/minute per key |
| Email sign-in | 8/minute |
| Signup | 5/hour |
| Password-reset request | 5/hour |
| Passkey sign-in | 12/minute |
| OAuth dynamic registration | 20/hour |
| OAuth token endpoint | 60/minute |
| Authenticated MCP account, Free | 60 requests/minute |
| Authenticated MCP account, Pro | 300 requests/minute |

Redis shares the browser API and pre-authentication MCP address counters across instances and fails closed on store errors. Better Auth's configured limits use its PostgreSQL table. An atomic PostgreSQL counter then applies the Free/Pro request ceiling to the authenticated workspace. Correct proxy trust is essential; DraftRelay overwrites its private auth IP header with Express's socket/trusted-proxy result so a caller cannot choose a rate-limit bucket directly.

### Account quotas

| Metric | Free | Pro | Configurable environment variable |
| --- | ---: | ---: | --- |
| Saves/month | 500 | 10,000 | `FREE_MONTHLY_SAVES`, `PAID_MONTHLY_SAVES` |
| Saves/day | 50 | 1,000 | `FREE_DAILY_SAVES`, `PAID_DAILY_SAVES` |
| Stored items | 2,000 | 50,000 | `FREE_STORED_ITEMS`, `PAID_STORED_ITEMS` |
| Revision bytes | 10 MiB | 250 MiB | `FREE_STORAGE_BYTES`, `PAID_STORAGE_BYTES` |
| Connected OAuth clients | 3 | 20 | fixed in current application and migration trigger |

Calendar-day and calendar-month counters are calculated in UTC. Revisions count toward storage; deleting an item cascades its revisions and releases that storage. Quota failures return HTTP 429 or an MCP tool error without committing the requested artifact.

Paid limits and the 20-client cap use the same database predicate: either a fresh (under 24 hours) authoritative active/trialing Stripe Pro record or an operator-managed `pro`/`enterprise` workspace override. A stale Stripe record fails closed to Free limits unless that workspace override is present.

## Implemented retention behavior

The process runs maintenance at startup and every six hours:

- expired access tokens, refresh tokens, sessions, and verification records receive a short cleanup grace period
- refresh tokens revoked for more than seven days are deleted
- unowned OAuth registrations older than one day are deleted when they have no consent or tokens
- succeeded or ignored webhook-inbox rows are deleted after 90 days
- dead-letter webhook rows are retained for 180 days, then deleted
- per-minute MCP usage counters are deleted after one day; ended daily/monthly counters are deleted after 90 days
- pending and failed webhook rows are retained for automatic retry; operators have a 180-day window to inspect a dead-letter row and run `pnpm billing:webhook:replay -- evt_...` after correcting the cause

Artifact retention is project-controlled. A `done` artifact with an expiry is purged on the next operation in that workspace; active/reopened artifacts remain. Audit events do not currently have automatic time-based deletion.

These database behaviors do not delete provider data, application logs, replicas, snapshots, logical backups, user-created exports, or pasted destination copies. Define operational jobs and public policy for every copy.

## Backup and restore

PostgreSQL backups contain account identifiers, password hashes, sessions, passkey public credentials, OAuth clients/tokens, artifact bodies, immutable history, provenance, and audit data. Encrypt them, restrict access, and apply the same retention/deletion policy as the primary database.

A basic logical backup is:

```bash
umask 077
pg_dump --format=custom --no-owner --no-acl \
  --file="draftrelay-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$BACKUP_DATABASE_URL"
```

For production, combine regular logical backups with provider snapshots or PostgreSQL point-in-time recovery. Back up before every migration and test restores on a schedule. Record recovery-point and recovery-time objectives.

Redis contains rate-limit counters, not canonical artifacts or accounts. Redis persistence can reduce counter resets, but PostgreSQL is the required durable backup. Never restore Redis as a substitute for PostgreSQL.

Restore into a new empty database rather than overwriting the only production copy:

```bash
createdb "$RESTORE_DATABASE_NAME"
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="$RESTORE_DATABASE_URL" draftrelay-backup.dump
DATABASE_URL="$RESTORE_MIGRATION_DATABASE_URL" pnpm db:migrate
```

Then:

1. Reapply and inspect runtime grants.
2. Start the matching application build against the restored database in an isolated environment.
3. Verify table/migration counts, readiness, login, passkey login, OAuth discovery, MCP save/read/list, tenant isolation, workspace-data export, and retention behavior.
4. Reconcile Stripe subscriptions and missed webhook events.
5. Cut traffic over only after verification; retain the old database read-only until the rollback window closes.

Do not use `pg_restore --clean` against the active database during an incident.

## Observability and verification

The server writes structured JSON logs to stdout and includes an `X-Request-Id`. Authentication headers, cookies, passwords, OTPs, tokens, authorization codes, and response cookies are redacted. Query strings are excluded from logged paths.

Monitor at minimum:

- `/health/live` for process liveness
- `/health/ready` for PostgreSQL connectivity, migration/RLS attestation, Redis availability, and Stripe catalog readiness
- HTTP 401, 403, 409, 422, 429, and 500 rates
- PostgreSQL connections, locks, storage, replication, backups, and restore tests
- Redis availability, latency, memory, and evictions (`noeviction` is recommended)
- email delivery/bounce rates
- Stripe webhook failures and delivery backlog
- OAuth registration/token anomalies and connected-client growth
- artifact count/storage quota saturation

Before routing production traffic, run:

```bash
pnpm install --frozen-lockfile
pnpm check
MIGRATION_DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:migrate
curl --fail --silent --show-error "$APP_URL/health/live"
curl --fail --silent --show-error "$APP_URL/health/ready"
curl --fail --silent --show-error "$APP_URL/.well-known/oauth-authorization-server"
curl --fail --silent --show-error "$APP_URL/.well-known/oauth-protected-resource/mcp"
```

Use a disposable migrated database for the integration test:

```bash
TEST_DATABASE_URL="$DISPOSABLE_TEST_DATABASE_URL" pnpm test
```

Complete one end-to-end browser signup/verification, password login, passkey registration/login, OAuth MCP authorization, each MCP tool, connection revocation, workspace-data export, Stripe test checkout, webhook update, billing portal, and account deletion before a live release.

## Incident and rollback checklist

1. **Declare and contain.** Identify whether the fault is application, PostgreSQL, Redis, email, OAuth, or Stripe. Stop new deploys and restrict traffic or writes if integrity is uncertain.
2. **Preserve evidence.** Save request IDs, sanitized logs, image/commit identity, `cloud_schema_migration` rows, database metrics, and Stripe event IDs. Never paste tokens, cookies, database URLs, or artifact bodies into an incident channel.
3. **Protect data.** Take a snapshot before repair when possible. Revoke exposed credentials at the provider and update the secret manager. Treat `BETTER_AUTH_SECRET` rotation as session-impacting.
4. **Choose rollback type.** Roll application instances back only when the previous build is compatible with the already-forward-migrated schema. Migrations have no automatic down path.
5. **Restore safely when necessary.** Restore to a separate database, run the matching build, reconcile Stripe, verify tenant isolation, then switch traffic. Do not edit migration checksums or history.
6. **Verify recovery.** Check live/ready health, signup/login/passkey, OAuth discovery and consent, save/read/list/revise/use, revocation, quotas, email, Stripe webhook processing, exports, and logs.
7. **Resume gradually.** Drain unhealthy instances, restore normal traffic, watch errors and saturation, and keep the prior environment available during the observation window.
8. **Close responsibly.** Document timeline, root cause, data impact, corrective actions, and whether contractual or legal breach notifications are required.

DraftRelay returns a non-2xx response when signature/mode validation or the durable webhook-inbox insert fails. Once an event is durably queued it returns 2xx promptly and owns retry internally. A signed event with a known permanent invariant failure, or one that exhausts eight internal attempts, moves to `dead_letter`; alert on that queue and use the explicit replay command only after correcting the cause.

## Legal and policy prerequisites

MIT licenses the source code; it does not supply the policies required to operate a service. Before accepting public users or payments, the operator should obtain appropriate legal advice and publish or establish:

- Terms of Service and an Acceptable Use Policy
- a Privacy Notice covering account, artifact, provenance, device, log, billing, and support data
- retention, export, account-deletion, backup-deletion, and legal-hold procedures
- a subprocessor list and data-processing terms for hosting, PostgreSQL, Redis, Resend, Stripe, and any observability provider
- data-residency and cross-border-transfer decisions
- security contact, vulnerability intake, breach response, and notification procedures
- billing, cancellation, refund, tax, invoice, and support policies consistent with the displayed $1/$10 plan
- cookie/session and passkey disclosures appropriate to the served jurisdictions
- age, sanctions, export-control, and prohibited-content rules where applicable
- ownership clearance for the DraftRelay name, domains, and visual assets

Test account-data export and account deletion against those policies. The streamed export covers sanitized app-held profile, linked-account, session, passkey, OAuth-connection, subscription, and workspace records; it intentionally omits credential material, IP addresses, provider-only email/payment records, logs, and backups. Operators need a separate process for those external or operational sources. Database backups and provider retention can outlive primary-row deletion, so public promises must match actual backup expiry and legal-hold behavior.

This checklist is operational guidance, not legal advice.
