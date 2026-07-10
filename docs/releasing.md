# Release checklist

The public name, package manifest, primary executable, and new MCP registration are DraftRelay / `draftrelay`. The v0.2 `cutline` executable alias, managed legacy registration migration, `CUTLINE_*` configuration, `.cutline.*` policies, and existing Cutline data paths remain compatibility interfaces until a dedicated migration release.

Repository state is not proof that an npm package, container image, MCP Registry listing, or hosted service is publicly available. Verify each channel before changing documentation to claim availability.

## Prepare the source release

1. Confirm the version in `package.json`, the CLI, local MCP server, hosted MCP server, and changelog are intentional. Do not remove the `cutline` alias or silently rename compatibility configuration/data paths.
2. Move completed changelog entries from Unreleased into a dated version.
3. Review dependency and license changes, generated lockfile changes, and the MIT license notice.
4. Confirm README, architecture, security, hosting, privacy/terms links, screenshots, and plan limits match the build.
5. Inspect every migration added since the prior release. Migrations must be new, forward-only files; never edit applied history.
6. Confirm Dependabot is enabled for npm, GitHub Actions, and Docker updates, and that the scheduled CI security run is healthy. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm check
   pnpm test:e2e
   npm pack --dry-run
   PACK_DIR="$(mktemp -d)"
   npm pack --pack-destination "$PACK_DIR"
   ```

7. Inspect the tarball. It should contain intended built CLI/server/UI assets, docs, license, changelog, and security policy. It must not contain databases, WAL/SHM files, exports, backups, `.env` files, credentials, test results, or unintended source maps.
8. Install the packed tarball into an isolated prefix and verify:

   ```bash
   npm install --prefix "$PACK_DIR/install" "$PACK_DIR"/draftrelay-*.tgz
   export PATH="$PACK_DIR/install/node_modules/.bin:$PATH"
   draftrelay --version
   draftrelay --help
   cutline --version
   draftrelay setup --client none --dry-run
   draftrelay doctor --json
   ```

9. With an isolated `CUTLINE_HOME`, exercise stdio initialize/tools/list, save/read/revise/use, local HTTP MCP, UI review/copy, backup, export, and uninstall-with-data-preservation.

## Verify hosted artifacts

Use disposable PostgreSQL and Redis instances with no production data:

```bash
docker compose up -d postgres redis
docker compose exec postgres createdb -U draftrelay draftrelay_test
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test pnpm db:migrate
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime
TEST_DATABASE_URL=postgres://draftrelay_app:draftrelay_app@localhost:5432/draftrelay_test pnpm test
docker compose --profile app build cloud
```

Also verify:

- migrations apply from an empty database and a prior-release snapshot
- a second migration run reports the database current
- runtime database grants and forced RLS prevent cross-tenant reads/writes
- signup, verification, password reset, session revocation, passkey add/login/delete, and account deletion
- OAuth discovery, dynamic registration, consent, all hosted MCP tools/scopes, and connection revocation
- free and Pro quotas, connected-client caps, and rate-limit failure behavior
- Stripe test checkout for the `$1` monthly and `$10` yearly lookup keys, webhook forwarding, subscription changes, cancellation, and billing portal
- concurrent and cross-interval checkout retries create only one open session; a lost checkout webhook recovers on account access
- prompt post-enqueue webhook acknowledgement, duplicate/out-of-order delivery, transient retry, dead-letter inspection/replay, stale-entitlement downgrade, and missed-cancellation reconciliation
- workspace-data export, project policy, retention purge, and backup restore
- live/readiness health (including PostgreSQL/schema, Redis, and Stripe catalog), structured redaction, and graceful shutdown

Build the Dockerfile locally and inspect it for the non-root runtime user, expected assets, migration files, health check, base-image digest policy, and vulnerability scan results. The runtime stage intentionally removes the base image's npm/npx tooling because the service starts with `node` and should not carry an unused package manager. CI fails on fixable high or critical operating-system or library findings reported by Trivy. No container registry publication workflow currently proves a public image exists.

## Hosted rollout gate

Before any operator deploys the hosted build:

1. Confirm a recent restore-tested PostgreSQL backup and documented recovery objectives.
2. Confirm the previous application build is compatible with the new forward schema or document why application rollback is unavailable.
3. Apply migrations once with the migration-owner role.
4. Reapply/verify non-owner runtime grants.
5. Roll out instances gradually behind HTTPS and trusted-proxy configuration.
6. Run health, OAuth metadata, browser auth, passkey, MCP, email, Stripe webhook, quota, and tenant-isolation checks.
7. Watch errors, 429s, database/Redis health, email delivery, and Stripe webhook backlog through the rollback window.

Do not roll a previous application build onto a schema it cannot understand. PostgreSQL migrations have no automatic down path; restore to a separate database when a data rollback is genuinely required. Use the [incident checklist](hosting.md#incident-and-rollback-checklist).

## npm publication

The maintainer must own or have access to the `draftrelay` npm package name. Publish only from the trusted release workflow with provenance:

Before the first release, create `raashy/draftrelay` (or replace every canonical repository URL if a different owner is selected), then configure npm trusted publishing for that exact GitHub repository, the `.github/workflows/release.yml` workflow, and the `npm` environment. The workflow installs npm 11.18.0 because trusted publishing requires npm 11.5.1 or newer; it intentionally has no long-lived registry token.

Also enable GitHub private vulnerability reporting and publish a monitored private conduct contact before accepting external reports. Version 0.3.0 intentionally pins the coordinated Better Auth packages to `1.7.0-rc.1`: the latest stable line is affected by [GHSA-p2fr-6hmx-4528](https://github.com/advisories/GHSA-p2fr-6hmx-4528), while the patched 1.7 line was still a release candidate during this audit. Do not change either side of that tradeoff without rerunning the fresh-schema, passkey, DCR/PKCE, MCP, Stripe checkout/webhook, and account-deletion matrix.

```bash
npm publish --access public --provenance
```

After publication:

1. Resolve the package on the public registry and inspect provenance.
2. Install it on clean supported macOS, Linux, and Windows environments.
3. Verify `draftrelay setup`, managed legacy-registration migration, and the `cutline` executable alias against current Claude Code and Codex releases.
4. Tag the exact source commit and create release notes from the changelog.
5. Update README language only after the registry package is verifiably available.

MCP Registry publication is a separate action with its own namespace and metadata verification. Do not claim availability until the listing resolves and a clean client can connect.

## Legal and operational release gate

A source release under MIT does not create a compliant hosted service. Before accepting public accounts or payments, the operator must complete the legal, privacy, subprocessor, retention/deletion, billing/refund/tax, security contact, and name-ownership work listed in [Hosting and operations](hosting.md#legal-and-policy-prerequisites).

Never publish real secrets, customer data, provider IDs tied to users, production database URLs, or private incident material in release notes, images, examples, test fixtures, or support bundles.

## Not implied by this checklist

- a deployed DraftRelay service
- a published npm or container package
- an MCP Registry listing
- signed native installers
- legal approval for a public service
- a specific cloud provider, domain, SLA, RPO, or RTO
