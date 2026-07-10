# DraftRelay security model

DraftRelay handles copy-ready material that can contain client information, source-code context, or credentials. This document describes implemented safeguards and their limits. It is not a claim that secret scanning, authentication, or tenant isolation can prove content safe.

## Two trust models

### Local mode

The local `draftrelay` process (also available through the v0.2 `cutline` executable alias) is single-user and unauthenticated. Its primary boundary is the operating-system account, private local files, stdio, and a loopback-only HTTP listener. Never expose local mode through port forwarding, a reverse proxy, a public tunnel, a LAN bind, or a container port.

Local `POST`, `PATCH`, and `DELETE` API requests require `X-App-Request: 1`. Browser requests must also carry an exact configured local `Origin`, and cross-site Fetch Metadata is rejected. Native CLI clients may omit `Origin` only when they deliberately send that header and send no browser `Sec-Fetch-Site` metadata. This exception preserves loopback automation without making an origin-less HTML form a valid write request; it does not authenticate another process running as the same OS user.

### Hosted mode

Hosted mode is a network service. It uses Better Auth browser sessions, secure production cookies, exact-origin CSRF checks, passkeys, OAuth bearer tokens for MCP, PostgreSQL tenant transactions and forced row-level security, Redis-backed request limits, Turnstile signup challenges, and structured redacted logging.

The hosted source still depends on correct operator configuration: TLS, trusted proxies, a non-owner database role, protected networks, strong secrets, backups, email, Stripe webhooks, monitoring, and incident response. See [Hosting and operations](hosting.md).

## Untrusted input

Both modes treat these values as untrusted:

- MCP tool arguments and HTTP bodies/query parameters
- Markdown and typed recipe payloads
- titles, projects, tags, paths, URLs, and provenance supplied by an agent
- policy files and custom scanner patterns
- imported databases and restored hosted data
- OAuth client metadata and consent requests
- Stripe webhook requests until signature verification succeeds
- content rendered in the browser or an MCP Apps card

Input schemas reject unknown or malformed fields at the main API/tool boundaries. Hosted JSON bodies are limited to 64 KiB at the Express layer; artifact title, body, tag, and provenance fields have tighter contract limits.

## Authentication and authorization

Hosted browser APIs require a Better Auth session. Passwords are hashed with Argon2id. Production signup requires email verification. Password-reset links expire, reset revokes sessions, and session cookies are secure in production.

Passkeys require user verification and are scoped to the RP ID derived from `APP_URL`. Changing the hostname can make existing passkeys unusable. Passkey records store public credential material; the authenticator retains the private key.

Hosted MCP publishes OAuth authorization-server and protected-resource metadata. Access tokens must be issued by the configured auth origin, audience-bound to the exact `/mcp` URL, and presented in the Authorization header. Tools require `outputs:read`, `outputs:write`, or `outputs:use`. Consent revocation is checked on every MCP request, providing an application-level disconnect beyond token expiry.

Dynamic OAuth client registration is intentionally unauthenticated for MCP compatibility. It is rate-limited, consent is required before artifact access, connected clients are quota-limited, and unused unconsented registrations are cleaned up after one day.

The local MCP transport has none of these account controls. Its safety depends on keeping it local.

## Tenant isolation

Hosted v1 assigns each user one personal workspace. CloudStore operations start a PostgreSQL transaction, set `app.user_id` from a verified session/token subject, resolve membership, and then set transaction-local `app.workspace_id`.

Domain tables use composite workspace keys and forced row-level-security policies. Startup and readiness verify the exact migration history plus the presence of forced RLS and expected tenant policies. The runtime database role must not own the tables and must not be a superuser or have `BYPASSRLS`. Running the application as the migration owner weakens the boundary even when policies are forced because that role can alter schema and policy.

Better Auth tables and the Stripe webhook inbox are service-level and intentionally do not have tenant RLS. Direct database access is therefore an application/operations trust boundary, not a supported user interface.

RLS is defense in depth around application authorization, not a substitute for it. Changes to workspace resolution, database roles, policies, or transaction boundaries require explicit cross-tenant tests.

## Network and browser boundary

Hosted production requires an HTTPS `APP_URL`. Allowed Host checks use that origin and explicitly trusted origins. Cookie-authenticated mutations require the exact origin, a non-cross-site browser context, JSON content type, and an application request header.

Only known reverse-proxy addresses may be configured in `TRUSTED_PROXY_IPS`. Trusting arbitrary forwarded headers can defeat rate-limit attribution and corrupt audit addresses. Native MCP clients may omit the `Origin` header, but local and hosted transports reject any supplied origin that is not an exact configured HTTP(S) origin. The proxy must preserve the raw Stripe webhook body for signature verification and must not cache authentication, API, or MCP responses.

Security headers include a restrictive Content Security Policy, no framing, no referrer, MIME-sniffing protection, a constrained Permissions Policy, and production HSTS. The current HSTS policy includes subdomains and preload; operators must understand that domain-wide commitment before serving production traffic.

PostgreSQL and Redis belong on private networks and production configuration requires TLS for both. Redis stores shared request counters, not canonical artifacts, but an attacker who can alter it can interfere with rate enforcement.

## Content rendering

Canonical content is Markdown. Destination HTML is generated from an intentionally limited subset with HTML escaping and a safe URL allowlist. Raw artifact HTML is not trusted. Browser previews should not execute artifact scripts, load arbitrary remote Markdown images, or navigate unsafe URL schemes.

Email representations contain sanitized local HTML for rich clipboard writes plus plain text. Slack and GitHub outputs are text/Markdown transformations, not provider API sends. No saved command is executed.

## Secret scanning

Built-in scanner rules cover private-key headers, common provider token shapes, bearer tokens, JWTs, credentials in URLs, and likely API-key/token/secret/password assignments. Projects can add literal or glob patterns and select off, warn, block high/critical, or block all behavior.

For non-blocking findings, DraftRelay stores rule identity, severity, offsets, a one-way fingerprint, acknowledgement state, and a redacted preview. It does not copy the raw match into the finding record. The artifact itself still contains the original value; acknowledgement does not redact it.

Blocking runs before a new artifact or revision commits. Copy-time evaluation runs again against current content and policy. A project can require warnings to be acknowledged and the artifact to be reviewed before copy.

Custom literals and globs use bounded string matching rather than tenant-controlled regular expressions, each rule reports at most 20 occurrences per scan, and each project is limited to 50 custom patterns in local storage, hosted application logic, and PostgreSQL. Pattern matching can still miss encoded, split, short, custom, or novel credentials and can flag harmless text. A clean scan does not mean an artifact is safe to disclose. Rotate any credential that may have entered an agent session, terminal log, artifact, immutable revision, export, backup, clipboard, or destination.

## Data at rest

### Local SQLite

Local mode stores data unencrypted in SQLite. On POSIX systems, managed directories use mode `0700` and private files use `0600`. These permissions do not protect against the same OS user, administrator/root, a compromised account, snapshots, or unencrypted disks. Use full-disk encryption.

### Hosted PostgreSQL

Hosted PostgreSQL stores account identity, password hashes, sessions, passkey public records, OAuth clients/tokens, subscription references, artifacts, immutable revisions, provenance, findings, events, and audit metadata. Use provider or volume encryption, TLS database connections, least-privilege roles, encrypted backups, restricted operator access, and auditable retention.

Redis can persist rate counters but is not the durable source of truth. Stripe and Resend hold separate provider data under the operator's contracts and retention settings.

## Logs and audit data

Hosted logs are structured and include request IDs. Authorization headers, cookies, API keys, passwords, OTPs, authorization codes, client secrets, refresh tokens, and Set-Cookie responses are redacted. Logged request paths omit query strings.

Avoid logging request bodies or artifact contents in future changes. `audit_event` is designed to remain content-free; metadata should never contain output bodies, credentials, raw tokens, or webhook payloads.

The webhook inbox stores a minimized Stripe event envelope and a unique provider event ID only after raw-body signature verification. The endpoint acknowledges promptly after that durable insert, then reconciliation retrieves current Stripe state under a per-subscription lock; transient failures retry internally, while permanent or exhausted events enter an operator-visible dead-letter state. Pro entitlement requires an exact configured Price, an active/trialing subscription, and an authoritative sync less than 24 hours old. Stripe remains the authoritative billing record.

## Clipboard and destinations

The browser writes to the clipboard only after an explicit user action. A copy receipt is recorded after a successful write; preparing a representation is not a receipt. The local CLI uses the platform clipboard helper and reports failure when unavailable.

Clipboard contents can be observed by the operating system, clipboard managers, remote-desktop software, and other applications. DraftRelay does not clear the clipboard automatically.

DraftRelay does not authenticate to or send data directly to Slack, email destinations, or GitHub. Pasting and sending remain outside its security boundary. Resend is used only for hosted account email.

## Revisions, retention, export, and deletion

Creating a revision does not erase earlier content. Permanent artifact deletion cascades its history. A retention policy purges a `done` artifact after its deadline on the next store/workspace access; existing exports, database backups, provider backups, and replicas remain outside that purge.

Local `draftrelay backup` uses SQLite's online backup API, pre-creates its temporary file with private permissions, verifies source and backup integrity, and publishes without replacing an existing destination. Local JSON/Markdown exports and hosted account-data exports contain readable user material and must be protected. The hosted export streams app-held account and workspace records but excludes password hashes, raw tokens, session secrets, passkey key material, internal fingerprints, IP addresses, provider-only records, logs, and backups.

Hosted account deletion first places a durable guard that serializes against checkout, then attempts to cancel relevant Stripe subscriptions and delete the Stripe customer before deleting the Better Auth user. Subscription rows carry a real user foreign key and are removed in the same database transaction as the user. Transient provider cleanup failure stops deletion and preserves the account for retry. The personal workspace then cascades from the user. Provider retention, logs, backups, legal holds, and failed external cleanup can outlive primary deletion, so operator policies must describe actual behavior rather than promise immediate forensic erasure.

## Provenance limitations

Provenance is client-supplied unless its capture method states otherwise. DraftRelay stores it for traceability but does not prove a repository, model, commit, verification result, or referenced file is authentic. Treat it as evidence to inspect, not a cryptographic attestation.

## Vulnerability reporting

Do not publish suspected vulnerabilities in a public issue. Follow [SECURITY.md](../SECURITY.md) for private reporting guidance.
