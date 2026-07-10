# Security policy

## Supported versions

Security fixes are applied to the latest released minor version. The hosted implementation is currently source-only; repository code is not a claim that a public DraftRelay service is deployed or supported under an SLA.

The public name and primary executable are DraftRelay / `draftrelay`. Reports about the v0.2 `cutline` executable alias, `CUTLINE_*` configuration, `.cutline.*` policies, legacy MCP registration, or existing Cutline data paths belong to this same project.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include real credentials, tokens, artifact bodies, database dumps, personal data, or customer material in a report.

Use [GitHub private vulnerability reporting](https://github.com/raashy/draftrelay/security/advisories/new). The maintainer must enable and test that private channel before the repository accepts public contributions or hosts public accounts. Until it is enabled, do not send sensitive details through a public issue. Include:

- affected commit/version and local or hosted mode
- reproduction steps using synthetic data
- expected and observed behavior
- potential confidentiality, integrity, availability, or cross-tenant impact
- whether credentials or production data may be exposed
- any temporary mitigation already applied

Allow maintainers time to investigate and coordinate a fix before public disclosure.

## High-priority report areas

- local-mode escape from the loopback-only boundary
- authentication, session, password-reset, passkey, or account-deletion bypass
- OAuth issuer/audience/scope bypass, token leakage, or consent-revocation failure
- cross-workspace access or PostgreSQL RLS bypass
- CSRF, Host-header, trusted-proxy, or rate-limit bypass
- stored or reflected script execution through Markdown, HTML, URLs, or MCP Apps
- raw secret values appearing in findings, logs, audit metadata, or error responses
- Stripe webhook signature bypass or billing/account ownership confusion
- destructive migration, backup, restore, retention, or deletion behavior
- command execution from saved artifacts or policy files

## Operator responsibilities

Local mode is unauthenticated and must stay on loopback. Hosted mode requires HTTPS, a stable public origin, trusted-proxy configuration, non-owner PostgreSQL runtime access, private PostgreSQL/Redis networking, strong managed secrets, verified email, signed Stripe webhooks, encrypted backups, monitoring, and incident response.

Secret scanning is a safety net, not a guarantee. Backups and exports can contain private client or project material. Read the full [security model](docs/security-model.md) and [hosting guide](docs/hosting.md) before operating the hosted source.
