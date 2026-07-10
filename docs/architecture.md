# DraftRelay architecture

DraftRelay has one artifact model and two deployment modes. Local mode optimizes for a single user and zero account setup. Hosted mode adds accounts, tenant isolation, OAuth-protected MCP, shared rate limits, and billing without changing the core delivery workflow.

## System shape

```text
                              shared contracts
                    recipes / validation / transforms
                                  │
             ┌────────────────────┴────────────────────┐
             │                                         │
       local mode                                hosted mode
             │                                         │
 Claude/Codex ─ stdio MCP                 Claude/Codex ─ HTTPS MCP
 browser ─ loopback JSON API              browser ─ session JSON API
             │                                         │
   Express + SQLite store                 Express + Better Auth + CloudStore
             │                                         │
   one OS-user boundary                PostgreSQL + Redis + Stripe/Resend
```

The canonical artifact is Markdown. Destination-specific Slack, email, GitHub, Markdown, and plain-text representations are derived and versioned. Neither mode sends those representations to third-party destinations automatically.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/shared` | Transport-neutral artifact, recipe, lifecycle, policy, destination, revision, and provenance contracts |
| `src/server/recipes.ts` | Typed recipe schemas and deterministic canonical-Markdown rendering |
| `src/server/representations.ts` | Destination transforms and safe HTML generation |
| `src/server/security.ts` | Shared built-in and project-specific secret scanning |
| `src/server/validation.ts` | Strict request and MCP input validation used in both modes |
| `src/server/store.ts` | Local SQLite schema evolution, transactions, revisions, policy, findings, representations, and events |
| `src/server/mcp.ts` / `src/server/stdio.ts` | Local MCP tools and stdio lifecycle |
| `src/server/app.ts` | Local loopback Express API, HTTP MCP transport, and static UI |
| `src/cli` | `draftrelay` setup, diagnostics, browser/clipboard helpers, export, backup, and uninstall, with the v0.2 `cutline` executable alias |
| `src/client` | Shared/local React review inbox |
| `src/mcp-app` | Optional local MCP Apps saved-output card |
| `src/cloud/config.ts` | Hosted environment validation and plan-limit defaults |
| `src/cloud/auth.ts` | Better Auth email/password, passkey, JWT, OAuth provider, and Stripe plugins |
| `src/cloud/store.ts` | PostgreSQL tenant transactions, quotas, lifecycle, policy, exports, and audit events |
| `src/cloud/mcp.ts` | OAuth-scoped hosted MCP tools |
| `src/cloud/app.ts` | Hosted health, discovery, auth, MCP, session API, static app, and error surfaces |
| `src/cloud/rate-limit.ts` | Redis-backed hosted API/MCP request limiting |
| `src/cloud/maintenance.ts` | Expired auth-token/session and webhook-inbox cleanup |
| `src/cloud-client` | Hosted marketing, authentication, consent, account, and review UI |
| `migrations` | Forward-only hosted PostgreSQL schema migrations |

The primary CLI and new MCP registration are `draftrelay`. The `cutline` executable alias, `CUTLINE_*` variables, `.cutline.*` policies, and existing Cutline data paths remain the local v0.2 compatibility surface until a dedicated migration release.

## Local mode

### Persistence

`items` is the current SQLite projection used for fast outbox queries. Durable history is separate:

- `item_revisions` keeps immutable content revisions and idempotency keys.
- `item_provenance` and `revision_files` attach source context to a revision.
- `item_secret_findings` records redacted scanner findings and acknowledgement state.
- `destination_representations` caches deterministic output per revision and transformer version.
- `item_events` records create, review, copy, complete, reopen, revise, and acknowledgement events.
- `project_policies` and `project_secret_patterns` hold local delivery rules.
- `schema_migrations` records additive SQLite changes.

SQLite runs with foreign keys, a busy timeout, and WAL journaling. Multi-record mutations use transactions. Copy receipts accept a client event ID so retrying a completed browser action does not duplicate lifecycle events.

Opening the store purges `done` items whose policy-derived expiry has passed. Cascades remove their related history. Active or reopened items are not retention-purged.

### Local network boundary

`draftrelay serve` accepts only loopback hosts. The local HTTP MCP endpoint is unauthenticated because the operating-system user and loopback network are its primary boundaries. It must never be exposed through a public proxy, tunnel, LAN bind, or container port.

Local JSON API writes require the non-simple `X-App-Request: 1` header. Browser writes additionally require an exact UI/server origin and reject cross-site Fetch Metadata. An Origin-less native request is accepted only with the explicit header and without browser Fetch Metadata, which keeps CLI automation available while rejecting cross-site forms.

Stdio is the preferred local MCP transport because it does not open a listening MCP socket.

### Workspace policy files

Local stdio and HTTP startup search upward from the working directory for `.cutline.yml`, `.cutline.yaml`, `cutline.yml`, or `cutline.yaml`. Discovery stops at the first Git repository boundary. `CUTLINE_POLICY_FILE` selects an explicit file.

The YAML document is limited to 64 KiB, parsed as declarative data, and checked by a strict schema:

```yaml
version: 1
project: Project name
policy:
  defaultRecipeId: generic_note
  defaultDestination: markdown
  allowedDestinations: [plain, markdown, slack, email, github]
  secretMode: block_high
  requireSecretAck: true
  requireReviewBeforeCopy: false
  copyBehavior: mark_copied
  retentionDays: null
```

Only declared fields are applied to the named project's SQLite policy. Invalid policy fails startup rather than being silently ignored. Hosted mode does not inspect a remote user's repository; its project policy lives in PostgreSQL and is managed through the authenticated UI/API.

## Hosted mode

### Identity and access

Better Auth provides:

- email/password signup, verification, reset, and database sessions
- Argon2id password hashing
- WebAuthn passkeys tied to the hostname in `APP_URL`
- JWT signing keys stored in PostgreSQL
- OAuth authorization-server metadata, dynamic client registration, consent, access tokens, and refresh tokens
- Stripe customer/subscription records and checkout/billing-portal flows

Browser `/api` routes require a valid session. Mutating cookie-authenticated requests additionally require the exact configured origin, same-site browser context, JSON content type, and `X-App-Request: 1` header.

Hosted `/mcp` accepts only bearer tokens issued for the exact configured issuer and MCP audience. It publishes authorization-server and protected-resource metadata under `/.well-known/`. Tools enforce `outputs:read`, `outputs:write`, or `outputs:use` individually. Revoking a consent disconnects that OAuth client even if a previously issued token has not reached its nominal expiry.

Hosted v1 creates one personal workspace per user on first data access. Team workspaces and workspace switching are not implemented.

### Tenant transaction boundary

Every CloudStore operation runs in a PostgreSQL transaction:

1. Lock the user ID for workspace bootstrap consistency.
2. Set transaction-local `app.user_id` from the verified session or access-token subject.
3. Resolve or create that user's personal workspace.
4. Set transaction-local `app.workspace_id`.
5. Confirm the workspace is active.
6. Purge expired completed items for that workspace.
7. Execute the requested operation and commit or roll back atomically.

The domain schema uses composite `(workspace_id, id)` keys and forced row-level security. `workspace_member` has a narrow self-lookup policy for initial tenant resolution; all other tenant reads and writes require the active workspace setting. The production runtime role must not own the tables and must not be a superuser or have `BYPASSRLS`.

Better Auth tables and the Stripe webhook inbox are deliberately outside tenant RLS because they are service-level data. They must be reachable only through the application role and operational roles, never a tenant-facing database connection.

### Hosted persistence

Core PostgreSQL tables include:

- `workspace`, `workspace_member`, `project`, and `project_secret_pattern`
- `output_item`, `output_revision`, `output_provenance`, and `referenced_file`
- `secret_finding`, `output_representation`, and `output_event`
- `usage_counter`, `audit_event`, `workspace_entitlement`, and `webhook_event`
- Better Auth user, session, account, verification, passkey, JWT key, OAuth, subscription, and database-rate-limit tables

The current item points to a deferrable, immutable revision. Initial item and revision insertion therefore occurs in one transaction. Idempotency keys are unique within a workspace and are bound to a SHA-256 fingerprint of the operation scope and canonical request payload. An exact retry returns the prior artifact without another write; reusing a key for a different operation, item, content, or destination returns a conflict.

Artifact bodies are intentionally absent from `audit_event`; audit metadata identifies action, actor, resource, outcome, request ID, IP, and user agent. Stripe webhook storage retains a minimized event envelope rather than the entire provider object.

PostgreSQL is the durable source of truth. Redis holds shared HTTP rate-limit counters only; losing Redis must not lose accounts or artifacts, although it temporarily resets those counters.

### Billing and quota boundary

Stripe subscriptions are user-referenced. Active or trialing Pro subscriptions select the paid limits only while their last authoritative Stripe sync is less than 24 hours old; a workspace-level `pro` or `enterprise` override can also select them. One PostgreSQL entitlement predicate drives store limits, the durable OAuth-consent cap, and active-client ranking so those enforcement paths cannot disagree. Save operations atomically enforce daily/monthly counters, stored-item count, and total revision bytes before writing.

An OAuth-consent database trigger enforces the connected-client cap independently of the UI. Dynamic registration remains unauthenticated for MCP compatibility and is separately IP-rate-limited; unused registrations are removed by maintenance.

### Hosted network surfaces

| Method | Path | Boundary |
| --- | --- | --- |
| `GET` | `/health`, `/health/live` | Process liveness; public |
| `GET` | `/health/ready` | PostgreSQL readiness; public |
| `GET` | `/api/health` | Compatibility health response; public |
| `GET` | `/.well-known/oauth-authorization-server` | OAuth discovery; public |
| `GET` | `/.well-known/openid-configuration` | OpenID discovery; public |
| `GET` | `/.well-known/oauth-protected-resource/mcp` | MCP protected-resource discovery; public |
| `*` | `/api/auth/*` | Better Auth endpoints, including Stripe webhook |
| `POST` | `/mcp` | OAuth bearer token plus per-tool scopes |
| `GET/POST/...` | `/api/*` | Better Auth browser session and CSRF checks |

Authenticated application routes include usage, account-data export at `/api/account/export`, OAuth connection revocation, artifacts, revisions, transitions, representations, copy receipts, findings, projects, policies, and custom secret patterns. The repeatable-read export streams bounded cursor pages covering sanitized profile, linked-account, session, passkey, OAuth-connection and subscription metadata plus workspace membership, projects and policy, artifacts, immutable revisions, provenance, referenced files, redacted findings, generated representations, copy/events, entitlements, usage, and content-free audit rows. It deliberately excludes password hashes, raw auth/OAuth tokens, session tokens, private/public passkey material, internal content/secret fingerprints, IP addresses, provider-only records, logs, and backups.

The server is stateless at the HTTP layer. Multiple instances can share PostgreSQL and Redis. A reverse proxy must preserve the public origin and forward only trusted client-address headers as described in [Hosting and operations](hosting.md).

Artifact browsing uses opaque keyset cursors over updated/created time and ID, with at most 100 rows per page. Facet counts are aggregated across the complete archived scope rather than the current page, and the web inbox keeps already loaded pages during background refreshes.

## Shared mutation and copy flow

### Create or revise

1. Strictly parse and normalize the input.
2. Render a typed payload into canonical Markdown when applicable.
3. Resolve project policy.
4. Scan title and body before persistence.
5. Reject blocked content or commit item/revision, provenance, redacted findings, and events atomically.
6. Reset copied/done state when a new revision becomes current.

Revision creation includes `baseRevision`. A stale writer receives the current revision number instead of silently replacing newer work.

### Prepare and copy

1. Request a representation for the current revision and destination.
2. Confirm recipe and project policy allow it.
3. Re-scan content and evaluate review/acknowledgement rules.
4. Build or reuse a versioned representation.
5. Let the browser perform the clipboard write.
6. Post a copy receipt only after success.
7. Apply `no_change`, `mark_copied`, or `mark_done` and append an idempotent event.

Previewing a representation is not recorded as a copy.

## Design constraints

- Agent output, Markdown, paths, URLs, provenance, and recipe payloads are untrusted input.
- No saved command is executed.
- No destination is sent automatically.
- Provenance is descriptive and client-supplied, not a cryptographic attestation.
- Raw secret matches are not copied into finding records or logs.
- MCP Apps is an optional local presentation enhancement, never a core dependency.
- Local backups use SQLite's online backup API while WAL may be active, write through a private temporary file, verify integrity, and publish without replacing an existing destination.
- Hosted migrations are forward-only and are never applied automatically at server startup.
