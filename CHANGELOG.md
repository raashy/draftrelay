# Changelog

All notable source changes to DraftRelay are documented here. The project follows Semantic Versioning while its public contracts stabilize.

## [Unreleased]

### Fixed

- Bound idempotency keys to canonical request fingerprints so changed create, revision, or copy payloads cannot replay as a different successful artifact.
- Re-scan hosted artifacts against the current project secret policy before copy and persist newly discovered warning state for acknowledgement.
- Keep local combined content/project/status updates atomic, purge expired local items during long-running access, and publish SQLite backups from private `0600` temporary files without replacing a concurrently created destination.
- Purge RLS-protected usage counters inside their workspace transaction and retain Stripe dead-letter records for a bounded 180-day operator replay window.
- Add keyset pagination and complete SQL facet counts beyond the former 250/5,000-row browse caps, with an accessible Load more action in the inbox.
- Stream a repeatable-read JSON export in bounded PostgreSQL cursor pages, including sanitized account, passkey, OAuth-connection, subscription, and workspace records while excluding credential material and IP addresses.

## [0.3.0] - 2026-07-10

### Added

- Source for a hosted multi-user DraftRelay server backed by PostgreSQL and Redis.
- Better Auth email/password sessions, email verification/reset, WebAuthn passkeys, OAuth-protected MCP, consent/revocation, and Stripe subscriptions.
- Hosted `list_outputs` plus the existing save, read, revise, and use MCP workflow.
- Personal workspaces, forced PostgreSQL row-level security, tenant-composite foreign keys, quotas, audit events, workspace-data export, account deletion, and webhook inbox.
- Forward-only checksum-verified migration runner, Dockerfile, and development Compose stack.
- Twelve crawlable documentation, integration, guide, pricing, security, and legal pages plus sitemap, robots, and llms discovery files.
- Optional Cloudflare Turnstile signup verification, per-account MCP request ceilings, and non-owner runtime-role startup enforcement.
- Passkey listing and removal from account security settings.
- Hosted operations guidance covering TLS/proxies, roles, migrations, Stripe `$1` monthly and `$10` yearly lookup keys, backup/restore, incident rollback, and legal prerequisites.

### Changed

- Public product name and documentation are now DraftRelay.
- Architecture and security documentation now distinguish local SQLite and hosted account-based trust boundaries.
- Better Auth core, OAuth provider, passkey, and Stripe packages are pinned to 1.7.0-rc.1, with a forward migration for its JWT and OAuth resource schema, to avoid the OAuth provider vulnerability affecting the latest stable line.

### Compatibility

- `draftrelay` is now the primary package, CLI, and new MCP registration.
- The v0.2 `cutline` executable alias, managed legacy registration migration, `.cutline.*` policy files, `CUTLINE_*` environment variables, and existing Cutline data directories/database names remain supported until a dedicated migration release.
- No npm publication, container registry image, MCP Registry listing, or public hosted deployment is implied by the source changes.

## [0.2.0] - 2026-07-10

### Added

- Typed deliverable recipes and destination-specific representations.
- Artifact lifecycle, immutable revisions, provenance, and copy receipts.
- Secret scanning and project output policies.
- Stdio MCP and the cross-platform `cutline` CLI.
- Backup, export, doctor, setup, and uninstall workflows.
- Progressive MCP Apps review card.

## [0.1.0] - 2026-07-10

### Added

- Local Streamable HTTP MCP server with `save_output`.
- SQLite-backed Markdown inbox with search, filters, archive, and copy actions.
