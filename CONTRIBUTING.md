# Contributing to DraftRelay

DraftRelay is an outbox for finished AI deliverables. Contributions should protect that narrow job: move one clean artifact from an agent to a human quickly and safely without turning the project into a transcript archive or general notes platform.

`draftrelay` is the primary package, CLI, and new MCP registration. The v0.2 `cutline` executable alias, legacy registration handling, policy filenames, `CUTLINE_*` environment variables, and existing Cutline data paths are compatibility contracts. Do not remove or rename them in an ordinary feature change. A naming migration needs a dedicated release, data/client migration, rollback plan, and documentation.

## Development

Requirements:

- Node.js 22.12 or newer
- pnpm 10
- Docker with Compose for hosted PostgreSQL/Redis work

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm check
```

For hosted work:

```bash
docker compose up -d postgres redis
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay pnpm db:migrate:source
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime:source
docker compose exec postgres createdb -U draftrelay draftrelay_test
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test pnpm db:migrate:source
MIGRATION_DATABASE_URL=postgres://draftrelay:draftrelay@localhost:5432/draftrelay_test \
  RUNTIME_DATABASE_ROLE=draftrelay_app pnpm db:grant-runtime:source
TEST_DATABASE_URL=postgres://draftrelay_app:draftrelay_app@localhost:5432/draftrelay_test pnpm test
REDIS_URL=redis://localhost:6380 pnpm dev:cloud
```

Use only disposable databases for integration tests. The PostgreSQL suite creates and deletes test users and tenant data.

## Change requirements

Before opening a pull request:

1. Add or update focused tests for behavior changes.
2. Run `pnpm check`; run `pnpm test:e2e` for user-flow or browser changes.
3. Test local SQLite behavior when shared recipes, validation, representations, scanner rules, or UI components change.
4. Test hosted auth, tenant isolation, scopes, quotas, and audit behavior when CloudStore or request boundaries change.
5. Keep SQLite changes additive and preserve existing artifact IDs/content.
6. Add a new forward-only PostgreSQL migration for hosted schema changes. Never edit an applied migration.
7. Verify the app with a non-owner, non-superuser PostgreSQL runtime role whenever RLS or grants change.
8. Never log or persist raw secret matches, tokens, cookies, passwords, OAuth codes, Stripe signatures, or artifact bodies in audit metadata.
9. Update README, architecture, security, hosting, environment, and release docs when public behavior or operational requirements change.
10. Test clipboard and path behavior on every operating system touched by the change.

## Pull requests

Keep changes focused. Explain:

- the user problem and selected tradeoff
- whether local, hosted, or both modes change
- migration and backward-compatibility impact
- security, privacy, quota, or billing impact
- exact verification performed

UI changes should include screenshots or a short recording when possible. Hosted deployment examples must not include real domains, account IDs, secrets, customer data, or claims that an unverified service/image/package is live.

Report security vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in an issue or pull request.

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
