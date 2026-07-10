# DraftRelay

DraftRelay is a delivery outbox for finished AI-agent work. Claude Code, Codex, or another MCP client saves the concise result you actually need—a client email, Slack update, incident summary, decision, pull-request description, or command set—and DraftRelay gives you a quiet place to review, adapt, and copy it.

It is not a notes app, transcript archive, or second chat history. It sits at the last mile between an agent finishing work and a human sending or using the result.

```text
Claude Code / Codex / MCP client
                 │
                 │ save one polished artifact
                 ▼
          DraftRelay MCP tools
                 │
        ┌────────┴─────────┐
        ▼                  ▼
 local SQLite       hosted PostgreSQL
 loopback UI        accounts + OAuth MCP
        └────────┬─────────┘
                 ▼
       review → copy → done
```

## Project status and naming

The repository contains two runnable modes:

| Mode | Intended use | Storage | Access model |
| --- | --- | --- | --- |
| Local | One person on one machine | SQLite in the user's application-data directory | Stdio MCP or unauthenticated loopback HTTP |
| Hosted | Self-hosted multi-user service | PostgreSQL for durable data and Redis for shared HTTP rate limits | Better Auth browser sessions, passkeys, and OAuth bearer access for MCP |

The public product, package manifest, primary executable, and new MCP registration are **DraftRelay** / `draftrelay`. The following v0.2 `cutline` interfaces remain supported compatibility surfaces, not accidental leftovers:

- `cutline` remains an executable alias for the `draftrelay` CLI.
- Existing managed MCP registrations named `cutline` are migrated by `draftrelay setup`; unmanaged registrations are left alone unless the operator uses `--force`.
- Policy files remain `.cutline.yml`, `.cutline.yaml`, `cutline.yml`, or `cutline.yaml`.
- Local environment variables remain `CUTLINE_HOME`, `CUTLINE_DATA_DIR`, `CUTLINE_POLICY_FILE`, and `CUTLINE_URL`.
- The local database remains `cutline.sqlite3` under the existing Cutline application-data directory.
- `AI_DUMP_URL` remains a smoke-test fallback for older checkouts.

Do not rename local directories or configuration by hand. A future migration release must move these interfaces without losing data or client registrations.

This source tree includes a Dockerfile and a development Compose stack. It does **not** claim that an npm package, container image, MCP Registry entry, or public DraftRelay service has been deployed.

## Why DraftRelay instead of Notion?

Notion and other knowledge bases collect and organize information. DraftRelay completes a delivery handoff:

- Agents save one polished artifact instead of a conversation dump.
- Typed recipes define what a finished deliverable contains.
- One Markdown source becomes Slack, email, GitHub, Markdown, or plain-text output.
- Immutable revisions preserve the original result and later human edits.
- Provenance records supplied source context and verification status.
- Review, copy, completion, and retry-safe copy receipts are explicit lifecycle events.
- Project policy can require review, acknowledge secret warnings, limit destinations, and apply retention.

Use a knowledge base for durable project knowledge. Use DraftRelay for the thing you are about to read, paste, send, or act on.

## Local quick start

Requirements:

- Node.js 22.12 or newer
- pnpm 10
- Claude Code and/or Codex on `PATH` for automatic MCP setup

```bash
git clone https://github.com/raashy/draftrelay.git
cd draftrelay
pnpm install
pnpm build
npm link
draftrelay setup --dry-run
draftrelay setup
draftrelay serve --open
```

`draftrelay setup` creates private per-user directories and registers a user-scoped stdio MCP server. The client launches that process when needed. Select clients explicitly when preferred:

```bash
draftrelay setup --client claude --client codex
```

The equivalent registrations are:

```bash
# Claude Code, user scope
claude mcp add --transport stdio --scope user draftrelay -- draftrelay mcp --client claude-code

# Codex
codex mcp add draftrelay -- draftrelay mcp --client codex
```

Open the local review inbox with:

```bash
draftrelay open
draftrelay open <item-id>
```

`draftrelay serve` also exposes an optional Streamable HTTP endpoint at `http://127.0.0.1:3939/mcp`. It is unauthenticated and refuses non-loopback binds. Never place the local server behind a reverse proxy, public tunnel, container port, or LAN address.

If a native script calls a state-changing local `/api` route directly, it must send `X-App-Request: 1`. Browser writes are restricted to the configured local origin; Origin-less requests are reserved for explicit non-browser clients without Fetch Metadata.

Scripts that still invoke `cutline` continue to run the same CLI:

```bash
cutline --version
```

### Local data and backup

The local mode has no account and sends no artifact data to the hosted mode. It stores artifacts, revisions, provenance, policy, findings, and receipts in SQLite using WAL mode.

| Platform | Default data location |
| --- | --- |
| macOS | `~/Library/Application Support/Cutline` |
| Windows | `%LOCALAPPDATA%\Cutline` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/cutline` |

Use the online backup command instead of copying a live SQLite/WAL file:

```bash
draftrelay backup
draftrelay backup --output ./cutline-backup.sqlite3
draftrelay export --format json --output ./draftrelay-export.json
```

To import a v0.1 checkout database, stop the old process and use:

```bash
draftrelay setup --client none --migrate-from ./data/ai-dump.sqlite3
```

Setup refuses to overwrite an existing destination. `draftrelay uninstall` preserves data unless both `--purge-data` and `--yes` are supplied.

## Hosted development quick start

Hosted mode is a separate application entry point. It requires PostgreSQL; Redis is optional in development and mandatory when `NODE_ENV=production`.

Production additionally requires TLS database/cache URLs and Cloudflare Turnstile signup keys; the process fails closed if these or the expected migration and forced-RLS state are absent.

Start the development dependencies:

```bash
docker compose up -d postgres redis
pnpm install
pnpm build

MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay \
  pnpm db:migrate
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime
```

Then export development configuration in your shell and start the hosted app:

```bash
export NODE_ENV=development
export HOST=127.0.0.1
export PORT=3941
export APP_URL=http://localhost:3941
export DATABASE_URL=postgres://draftrelay_app:draftrelay_app@localhost:5432/draftrelay
export REDIS_URL=redis://localhost:6380
export BETTER_AUTH_SECRET=development-only-change-before-shared-use
pnpm dev:cloud
```

Open `http://localhost:3941/signup`. Email verification and external email delivery are not required in development. Billing needs Stripe test-mode configuration before its buttons can complete checkout.

To exercise the app container as well as its dependencies:

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
curl --fail --silent --show-error http://localhost:3941/health/ready
```

The Compose credentials and HTTP origin are development defaults. They are not safe production configuration. `docker compose down` preserves named volumes; `docker compose down --volumes` permanently deletes the development databases.

For production prerequisites, role separation, migrations, Stripe setup, proxy requirements, backup/restore, and incident rollback, read [Hosting and operations](docs/hosting.md).

## Connect hosted MCP

After creating an account, register the authenticated hosted endpoint:

```bash
claude mcp add --transport http --scope user draftrelay https://your-draftrelay-origin.example/mcp
codex mcp add draftrelay --url https://your-draftrelay-origin.example/mcp
codex mcp login draftrelay
```

The client discovers DraftRelay's OAuth metadata, opens the browser for consent, and receives a short-lived access token plus a refresh token. Tokens are audience-bound to the exact `/mcp` URL. Hosted scopes are `outputs:read`, `outputs:write`, and `outputs:use`; users can revoke a connected client from Account settings.

The hosted source currently supports three connected MCP clients on Free and twenty on Pro. Abandoned, unconsented dynamic registrations are cleaned up after one day.

## MCP tools

| Tool | Local | Hosted | Purpose |
| --- | :---: | :---: | --- |
| `save_output` | yes | yes | Save one free-form Markdown artifact or validated typed-recipe artifact. |
| `read_output` | yes | yes | Read an artifact's current revision and lifecycle status. |
| `list_outputs` | — | yes | Return concise metadata for recent matching artifacts. |
| `revise_output` | yes | yes | Create an immutable revision with a `baseRevision` concurrency guard. |
| `mark_output_used` | yes | yes | Enforce policy, record a use receipt, and optionally complete the artifact. |

For a typed deliverable, `save_output` receives `recipeId` and `payload` instead of `contentMarkdown`:

```json
{
  "title": "Acme launch update",
  "project": "Acme",
  "tags": ["launch"],
  "recipeId": "slack_update",
  "payload": {
    "headline": "Launch is ready for review",
    "updateMarkdown": "The production build passed the release checks.",
    "bullets": ["Preview is live", "Rollback is documented"],
    "ask": "Please approve the 16:00 UTC release window."
  },
  "provenance": {
    "branch": "release/acme",
    "verificationStatus": "passed",
    "verificationSummary": "Typecheck, tests, and production build passed."
  },
  "idempotencyKey": "acme-launch-update-2026-07-10"
}
```

Never provide `contentMarkdown` and a typed payload in the same call.

## Recipes, lifecycle, and policy

Built-in typed recipes cover Slack updates, client emails, GitHub pull requests, incident summaries, decisions, and command sets. Generic reply, summary, action, snippet, and note recipes preserve the v0.1 free-form workflow.

Artifacts move through `new → reviewed → copied → done`. A project can require review before copy, select allowed destinations, configure secret handling, choose the post-copy transition, and set retention for completed items. Editing creates a new immutable revision rather than overwriting history.

Local mode can discover a strict repository policy file:

```yaml
version: 1
project: Acme
policy:
  defaultRecipeId: github_pr
  defaultDestination: github
  allowedDestinations: [github, markdown]
  secretMode: block_high
  requireSecretAck: true
  requireReviewBeforeCopy: true
  copyBehavior: mark_copied
  retentionDays: 30
```

`CUTLINE_POLICY_FILE` selects an explicit file. The hosted UI stores equivalent policy per tenant in PostgreSQL; it does not read policy files from a remote user's repository.

Secret scanning is a guardrail, not proof that content is safe. Review every deliverable before sending it and rotate any credential that may have reached an agent session, artifact, export, backup, or clipboard. See [Security model](docs/security-model.md).

## Hosted plans and limits

The included hosted UI describes these plans; running the source does not create Stripe products or publish an offer:

| Limit | Free | Pro |
| --- | ---: | ---: |
| Price | $0 | $1/month or $10/year |
| Saves per day | 50 | 1,000 |
| Saves per calendar month | 500 | 10,000 |
| Stored artifacts | 2,000 | 50,000 |
| Revision storage | 10 MiB | 250 MiB |
| Connected MCP clients | 3 | 20 |
| MCP requests per minute, per account | 60 | 300 |

The expected Stripe Price lookup keys are `draftrelay_pro_monthly` for the recurring $1 USD monthly price and `draftrelay_pro_yearly` for the recurring $10 USD yearly price. Operators must create matching test and live prices on one active Product and configure the correct environment; startup validates mode, currency, amount, interval, and uniqueness exactly. Pro capacity requires a recent authoritative Stripe sync and otherwise fails back to Free. Limits can be overridden with the documented environment variables; connected-client limits are currently fixed at 3 and 20 in both application and database enforcement.

## Local CLI and compatibility reference

The primary command is `draftrelay`; `cutline` is the v0.2-compatible alias:

```text
draftrelay setup       Create storage and configure MCP clients
draftrelay mcp         Run the stdio MCP server
draftrelay serve       Run the local UI and HTTP MCP server
draftrelay open        Open the UI or a specific artifact
draftrelay doctor      Check runtime, storage, clipboard, clients, and server
draftrelay latest      Print or copy the latest matching artifact
draftrelay export      Export matching artifacts as JSON or Markdown
draftrelay backup      Create a consistent SQLite backup
draftrelay uninstall   Remove managed registrations; preserve data by default
```

## Development and verification

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Local live smoke test, with `draftrelay serve` already running:

```bash
CUTLINE_URL=http://127.0.0.1:3939 pnpm smoke
```

Hosted checks after migrations and startup:

```bash
curl --fail --silent --show-error http://localhost:3941/health/live
curl --fail --silent --show-error http://localhost:3941/health/ready
curl --fail --silent --show-error \
  http://localhost:3941/.well-known/oauth-protected-resource/mcp
```

`/health/ready` covers PostgreSQL plus schema/RLS attestation, Redis, and the exact Stripe catalog. The production Docker image uses it for its health check. See [Hosting and operations](docs/hosting.md#stripe-pricing-and-webhooks) for webhook dead-letter inspection and replay.

The PostgreSQL integration suite is opt-in:

```bash
docker compose exec postgres createdb -U draftrelay draftrelay_test
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test \
  pnpm db:migrate
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime
TEST_DATABASE_URL=postgres://draftrelay_app:draftrelay_app@localhost:5432/draftrelay_test \
  pnpm test
```

Read [Architecture](docs/architecture.md), [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and the [Release checklist](docs/releasing.md) before shipping changes.

## Boundaries

DraftRelay does not scrape terminals, read hidden reasoning, execute saved commands, or automatically send to Slack, email, or GitHub. It stores and prepares the final artifact; the human remains the delivery gate.

The local mode is deliberately single-user and loopback-only. The hosted mode is self-hostable but requires an operator to provide secure infrastructure, backups, transactional email, Stripe configuration, TLS, legal policies, and operational response. Repository code is not evidence that any public service is running.

## License

[MIT](LICENSE)
