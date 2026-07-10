export const PUBLIC_PAGE_PATHS = [
  "/docs",
  "/security",
  "/pricing",
  "/open-source",
  "/mcp",
  "/integrations/claude-code",
  "/integrations/codex",
  "/guides/copy-claude-code-output",
  "/guides/save-ai-agent-output",
  "/guides/markdown-to-slack",
  "/privacy",
  "/terms"
] as const;

export type PublicPagePath = (typeof PUBLIC_PAGE_PATHS)[number];

export interface PublicPageOptions {
  appUrl: string;
  appName: string;
  legalName: string;
  legalEmail: string;
  jurisdiction: string;
  effectiveDate?: string;
}

interface PageContext {
  appUrl: string;
  appName: string;
  brandMark: string;
  legalName: string;
  legalEmail: string;
  legalEmailHref: string;
  jurisdiction: string;
  effectiveDate: string | null;
  mcpUrl: string;
  href: (path: string) => string;
}

interface PageDefinition {
  title: (context: PageContext) => string;
  description: (context: PageContext) => string;
  eyebrow: string;
  h1: string;
  lede: (context: PageContext) => string;
  contents: readonly { href: string; label: string }[];
  body: (context: PageContext) => string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function plainTextValue(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAppUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("appUrl must be an absolute HTTP or HTTPS URL");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new TypeError("appUrl must be an absolute HTTP or HTTPS URL without credentials");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function createContext(options: PublicPageOptions): PageContext {
  const rawAppUrl = normalizeAppUrl(options.appUrl);
  const rawAppName = plainTextValue(options.appName);
  const rawEmail = plainTextValue(options.legalEmail);
  const absolute = (path: string) => `${rawAppUrl}${path}`;
  return {
    appUrl: escapeHtml(rawAppUrl),
    appName: escapeHtml(rawAppName),
    brandMark: escapeHtml(rawAppName.slice(0, 1).toUpperCase() || "D"),
    legalName: escapeHtml(plainTextValue(options.legalName)),
    legalEmail: escapeHtml(rawEmail),
    legalEmailHref: escapeHtml(`mailto:${encodeURIComponent(rawEmail).replace(/%40/gi, "@")}`),
    jurisdiction: escapeHtml(plainTextValue(options.jurisdiction)),
    effectiveDate: options.effectiveDate
      ? escapeHtml(plainTextValue(options.effectiveDate))
      : null,
    mcpUrl: escapeHtml(absolute("/mcp")),
    href: (path) => escapeHtml(absolute(path))
  };
}

function codeBlock(command: string, label: string): string {
  return `<div class="content-code"><p>${escapeHtml(label)}</p><pre tabindex="0" aria-label="${escapeHtml(label)}"><code>${escapeHtml(command)}</code></pre></div>`;
}

function relatedLinks(links: readonly { href: string; label: string }[]): string {
  return `<aside class="content-related" aria-labelledby="related-title">
    <h2 id="related-title">Keep reading</h2>
    <ul>${links.map((link) => `<li><a href="${link.href}">${link.label}<span aria-hidden="true"> →</span></a></li>`).join("")}</ul>
  </aside>`;
}

const pages: Record<PublicPagePath, PageDefinition> = {
  "/docs": {
    title: (context) => `${context.appName} Docs: Save and Review AI Agent Output`,
    description: (context) => `Connect ${context.appName} to Claude Code, Codex, or another MCP client, save one useful artifact, review it, and copy the right destination format.`,
    eyebrow: "Product documentation",
    h1: "From agent output to a clean handoff",
    lede: (context) => `${context.appName} is a review inbox for the finished result of an AI-agent session. It stores the artifact you intend to use—not the full transcript—and keeps review, provenance, revisions, safety findings, and destination-ready copy together.`,
    contents: [
      { href: "#choose", label: "Choose hosted or local" },
      { href: "#connect", label: "Connect an MCP client" },
      { href: "#save", label: "Save the first artifact" },
      { href: "#lifecycle", label: "Review and use it" },
      { href: "#tools", label: "MCP tool model" }
    ],
    body: (context) => `
      <section class="content-section" id="choose">
        <p class="kicker"><span>01</span>Choose a mode</p>
        <h2>Hosted when you move between clients. Local when the machine is the boundary.</h2>
        <p>The hosted service gives remote MCP clients one OAuth-protected endpoint at <code>${context.mcpUrl}</code>. It is useful when Claude Code, Codex, and a browser should see the same review inbox. Sign in, authorize each client, and revoke a connection from account settings when it is no longer needed.</p>
        <p>The open-source local edition runs on loopback and stores its data in SQLite. It has no hosted account or cloud sync. Use it when output must remain on one computer, or when you want to inspect and operate the full local stack yourself. Do not expose that unauthenticated local HTTP process to a LAN or the public internet.</p>
        <div class="content-callout"><strong>Pick one first.</strong><p>Hosted and local storage are separate. Neither silently syncs artifacts into the other.</p></div>
      </section>
      <section class="content-section" id="connect">
        <p class="kicker"><span>02</span>Connect</p>
        <h2>Give the client one remote MCP endpoint.</h2>
        <p>Claude Code and Codex can register the hosted Streamable HTTP endpoint from the command line. The first use opens an authorization flow; the client receives revocable OAuth access rather than a long-lived API key pasted into shell history.</p>
        ${codeBlock(`claude mcp add --transport http --scope user draftrelay ${context.mcpUrl}`, "Claude Code")}
        ${codeBlock(`codex mcp add draftrelay --url ${context.mcpUrl}\ncodex mcp login draftrelay`, "Codex")}
        <p>See the <a href="/integrations/claude-code">Claude Code setup</a> or <a href="/integrations/codex">Codex setup</a> for verification and troubleshooting. For another client, register <code>${context.mcpUrl}</code> as a remote Streamable HTTP MCP server with OAuth discovery enabled.</p>
      </section>
      <section class="content-section" id="save">
        <p class="kicker"><span>03</span>Save</p>
        <h2>Ask for a deliverable, not a dump.</h2>
        <p>A good request names the artifact, project, destination, and any evidence the result should carry. The agent should finish the work first, then call <code>save_output</code> with one concise, self-contained result.</p>
        <blockquote>Save the final launch update to DraftRelay under the Acme project. Make it concise for Slack, include the verification result and next action, and attach the current branch and commit as provenance.</blockquote>
        <p>Typed recipes are available for Slack updates, client emails, GitHub pull requests, incident summaries, decisions, and command sets. Free-form Markdown remains available for replies, summaries, actions, snippets, and notes. The service instructs clients not to save chain-of-thought, raw logs, credentials, duplicate drafts, or whole conversations.</p>
      </section>
      <section class="content-section" id="lifecycle">
        <p class="kicker"><span>04</span>Review</p>
        <h2>The human controls the last mile.</h2>
        <ol class="content-steps">
          <li><strong>Open the receipt.</strong><span>The MCP response includes the artifact ID, revision, status, and a direct review URL.</span></li>
          <li><strong>Check source and safety.</strong><span>Review supplied provenance and any redacted secret finding. Scanning is a guardrail, not a guarantee.</span></li>
          <li><strong>Revise without erasing history.</strong><span>Edits create immutable revisions and stale writes are rejected instead of silently overwriting newer work.</span></li>
          <li><strong>Choose the destination.</strong><span>Prepare Slack, email, GitHub, Markdown, or plain text. Conversion warnings call out likely fidelity loss.</span></li>
          <li><strong>Copy, then finish.</strong><span>A successful copy can be recorded and the artifact can move through <code>new → reviewed → copied → done</code>.</span></li>
        </ol>
      </section>
      <section class="content-section" id="tools">
        <p class="kicker"><span>05</span>Tool model</p>
        <h2>Five narrow tools, each with a visible job.</h2>
        <dl class="content-definitions">
          <dt><code>save_output</code></dt><dd>Creates one polished artifact, optionally using a typed recipe and provenance.</dd>
          <dt><code>list_outputs</code></dt><dd>Finds concise metadata by project, lifecycle, kind, tag, or text query.</dd>
          <dt><code>read_output</code></dt><dd>Reads the current content and revision before a follow-up action.</dd>
          <dt><code>revise_output</code></dt><dd>Creates a new immutable revision using a concurrency guard.</dd>
          <dt><code>mark_output_used</code></dt><dd>Checks review and secret policy, records use for a destination, and can complete the artifact.</dd>
        </dl>
      </section>
      ${relatedLinks([
        { href: "/mcp", label: "Understand the MCP server" },
        { href: "/security", label: "Read the security model" },
        { href: "/open-source", label: "Run the local edition" }
      ])}`
  },
  "/security": {
    title: (context) => `Security, Privacy Boundaries, and MCP Access | ${context.appName}`,
    description: (context) => `How ${context.appName} handles OAuth connections, tenant isolation, revisions, secret findings, human review, and the local-only trust boundary.`,
    eyebrow: "Security model",
    h1: "Review is a control, not a decoration",
    lede: (context) => `${context.appName} sits between an agent and the place where you intend to paste its work. The design keeps that boundary explicit: agents save artifacts, policies and scanners surface risk, and a person decides what leaves.`,
    contents: [
      { href: "#boundaries", label: "Trust boundaries" },
      { href: "#identity", label: "Identity and MCP access" },
      { href: "#data", label: "Storage and isolation" },
      { href: "#guardrails", label: "Content guardrails" },
      { href: "#operate", label: "Operate it safely" },
      { href: "#report", label: "Report a vulnerability" }
    ],
    body: (context) => `
      <section class="content-section" id="boundaries">
        <p class="kicker"><span>01</span>Trust boundaries</p>
        <h2>Agent output is untrusted input.</h2>
        <p>Titles, Markdown, recipe fields, tags, paths, repository details, and other provenance can all originate with an AI client. Treat them as content to inspect, not instructions to execute. ${context.appName} does not run saved command blocks, scrape terminal scrollback, read hidden reasoning, or send a saved artifact directly to Slack, email, or GitHub.</p>
        <p>The hosted service and the open-source local server have different boundaries. Hosted access is authenticated and workspace-scoped. The local server is intentionally unauthenticated and loopback-only. Putting the local process behind a public proxy is unsupported; use the hosted architecture when remote access and multi-user isolation are required.</p>
      </section>
      <section class="content-section" id="identity">
        <p class="kicker"><span>02</span>Identity</p>
        <h2>Short-lived OAuth access for remote MCP clients.</h2>
        <p>Hosted users can sign in with an email and password and can add a passkey. Passwords are hashed with Argon2; production email addresses are verified. Remote MCP clients use OAuth discovery and dynamic client registration. Access tokens are short-lived, refresh access is bounded, and the requested output scopes are shown during authorization.</p>
        <p>Connections can be listed and revoked. Revocation removes the relevant access, refresh, and consent records so that a former client cannot continue using that grant. Do not approve a client name you do not recognize, and revoke clients you no longer use.</p>
      </section>
      <section class="content-section" id="data">
        <p class="kicker"><span>03</span>Data</p>
        <h2>Every hosted query carries a workspace boundary.</h2>
        <p>Hosted projects, artifacts, revisions, representations, provenance, findings, copy receipts, and usage records are stored with a workspace identifier. Database operations run inside that tenant context. Item identifiers alone are not treated as authorization.</p>
        <p>Production traffic must use HTTPS and secure cookies. Authentication and MCP endpoints are rate-limited, request logs redact common authorization, cookie, token, password, and secret fields, and security-sensitive events can be audited. These controls reduce risk; they do not make arbitrary output safe to publish.</p>
      </section>
      <section class="content-section" id="guardrails">
        <p class="kicker"><span>04</span>Guardrails</p>
        <h2>Warnings stay attached to the revision that produced them.</h2>
        <p>The scanner checks titles and Markdown for common high-risk patterns such as private keys, bearer tokens, provider credentials, JWTs, credentials embedded in URLs, and likely secret assignments. Projects can warn, block high-severity findings, block all findings, require acknowledgement, or require review before copy. Custom project patterns are also supported.</p>
        <p>Findings shown to a reviewer use a redacted preview and line information rather than returning the matching secret value. Scanners have false positives and false negatives. Always inspect sensitive client, infrastructure, incident, financial, and personal information before copying it elsewhere.</p>
        <div class="content-callout"><strong>Provenance is supplied, not inferred.</strong><p>A branch, commit, test result, or file reference is shown as unknown when the client did not provide it. Its presence records a claim; it does not independently prove that claim.</p></div>
      </section>
      <section class="content-section" id="operate">
        <p class="kicker"><span>05</span>Safe operation</p>
        <h2>Use the narrowest workflow that solves the handoff.</h2>
        <ul>
          <li>Save only the final artifact; remove raw logs and unrelated context before persistence.</li>
          <li>Keep credentials out of prompts and saved content even when scanning is enabled.</li>
          <li>Review destination previews, especially links, commands, tables, and @mentions.</li>
          <li>Use project policies for sensitive work and revoke clients after temporary access.</li>
          <li>Protect local SQLite files, hosted exports, and backups as you would protect the source material.</li>
          <li>Delete artifacts and accounts that are no longer required.</li>
        </ul>
      </section>
      <section class="content-section" id="report">
        <p class="kicker"><span>06</span>Disclosure</p>
        <h2>Report suspected vulnerabilities privately.</h2>
        <p>Do not place exploit details, private artifacts, credentials, or personal data in a public issue. Send a concise description, affected surface, reproduction steps, and likely impact to <a href="${context.legalEmailHref}">${context.legalEmail}</a>. ${context.legalName} will use that information to investigate and coordinate an appropriate response.</p>
      </section>
      ${relatedLinks([
        { href: "/privacy", label: "Read the privacy notice" },
        { href: "/mcp", label: "Review the MCP contract" },
        { href: "/open-source", label: "Inspect the local trust boundary" }
      ])}`
  },
  "/pricing": {
    title: (context) => `${context.appName} Pricing: Free, $1 Monthly, or $10 Yearly`,
    description: (context) => `${context.appName} includes a usable free tier. Pro costs $1 per month or $10 per year and raises save, stored-artifact, and content-storage limits.`,
    eyebrow: "Pricing",
    h1: "A small utility should have a small bill",
    lede: (context) => `${context.appName} has one hosted product with two usage tiers. The workflow, review controls, destination formats, passkeys, and safety features are available on both; Pro raises the capacity for frequent daily use.`,
    contents: [
      { href: "#plans", label: "Compare plans" },
      { href: "#counts", label: "What usage means" },
      { href: "#billing", label: "Billing details" },
      { href: "#local", label: "Local edition" }
    ],
    body: (context) => `
      <section class="content-section" id="plans">
        <p class="kicker"><span>01</span>Plans</p>
        <h2>Use the full handoff loop before you pay.</h2>
        <div class="content-plan-grid">
          <article><header><h3>Free</h3><p><strong>$0</strong></p></header><ul><li>500 saves per month</li><li>50 saves per day</li><li>2,000 stored artifacts</li><li>10 MB of revision content</li></ul><a class="button button--line" href="/signup">Start free</a></article>
          <article><header><h3>Pro</h3><p><strong>$1</strong> per month<br /><small>or $10 billed yearly</small></p></header><ul><li>10,000 saves per month</li><li>1,000 saves per day</li><li>50,000 stored artifacts</li><li>250 MB of revision content</li></ul><a class="button button--signal" href="/signup?plan=pro">Choose Pro</a></article>
        </div>
        <p>Limits shown here are the hosted defaults. An operator can lower or raise deployment limits through configuration, so your signed-in usage screen is the final source for the limits applied to your account.</p>
      </section>
      <section class="content-section" id="counts">
        <p class="kicker"><span>02</span>Usage</p>
        <h2>A save is a new artifact or a new revision.</h2>
        <p>Creating an artifact consumes one daily and one monthly save. Revising an existing artifact also consumes a save because it preserves another immutable revision. Reading, searching, reviewing, preparing a destination representation, and recording a copy do not create a new revision.</p>
        <p>The stored-artifact limit counts items, while storage capacity counts the Markdown held across revisions. Deleting an artifact removes its related revisions and releases item and content capacity. Revoking an unused OAuth connection is still good account hygiene even though it does not consume a save.</p>
      </section>
      <section class="content-section" id="billing">
        <p class="kicker"><span>03</span>Billing</p>
        <h2>Monthly flexibility or two months saved yearly.</h2>
        <p>Pro is $1 when billed monthly or $10 when billed yearly. Applicable taxes can be calculated during checkout. Billing is handled through Stripe, and ${context.appName} does not ask you to place full payment-card details inside an artifact.</p>
        <p>You can manage the subscription from the signed-in account area. Deleting the hosted account cancels an active subscription as part of account deletion. No uptime guarantee, consulting support, or team administration is included in these individual plans unless it is stated in a separate written agreement.</p>
      </section>
      <section class="content-section" id="local">
        <p class="kicker"><span>04</span>Local</p>
        <h2>The open-source local edition has no hosted subscription.</h2>
        <p>The MIT-licensed local server runs on your computer and stores artifacts in SQLite. You provide the machine, backups, updates, and security boundary. It does not include hosted synchronization, hosted OAuth access, or an operated database. Start with the <a href="/open-source">open-source guide</a> if that tradeoff fits your work better.</p>
      </section>
      ${relatedLinks([
        { href: "/docs", label: "Read the product docs" },
        { href: "/open-source", label: "Compare the local edition" },
        { href: "/terms", label: "Read subscription terms" }
      ])}`
  },
  "/open-source": {
    title: (context) => `Open-Source Local AI Output Inbox | ${context.appName}`,
    description: (context) => `Run the MIT-licensed local edition behind ${context.appName}: a loopback MCP server, browser review outbox, and private SQLite database.`,
    eyebrow: "Open source",
    h1: "Keep the handoff on your own machine",
    lede: (context) => `The local edition behind ${context.appName} is an MIT-licensed delivery outbox. It runs as a Node.js CLI, lets Claude Code or Codex launch an stdio MCP server, and keeps artifacts, revisions, policies, and receipts in SQLite.`,
    contents: [
      { href: "#fit", label: "When local fits" },
      { href: "#install", label: "Build from source" },
      { href: "#clients", label: "Connect clients" },
      { href: "#data", label: "Own the data" },
      { href: "#boundary", label: "Know the boundary" }
    ],
    body: (context) => `
      <section class="content-section" id="fit">
        <p class="kicker"><span>01</span>Choose local</p>
        <h2>A local tool is useful when locality is part of the requirement.</h2>
        <p>Choose the local edition when the artifacts should remain on one workstation, when you prefer an inspectable SQLite file, or when your AI clients can launch stdio MCP processes directly. The browser UI, lifecycle, immutable revisions, provenance, recipes, destination transformations, secret policies, backup, and export workflows work without a hosted account.</p>
        <p>Choose hosted ${context.appName} when multiple computers or remote MCP clients need the same inbox, or when you need an authenticated, OAuth-protected HTTP endpoint. The local and hosted stores do not automatically synchronize.</p>
      </section>
      <section class="content-section" id="install">
        <p class="kicker"><span>02</span>Install</p>
        <h2>Build the current release from a source checkout.</h2>
        <p>The <a href="https://github.com/raashy/draftrelay">source repository</a> ships the primary local CLI as <code>draftrelay</code> and requires Node.js 22.12 or newer plus pnpm 10. The former <code>cutline</code> executable remains a compatibility alias for existing scripts. Until an npm registry release is confirmed, build and link an existing checkout rather than assuming the package is published.</p>
        ${codeBlock("cd path/to/draftrelay\npnpm install\npnpm build\nnpm link\ndraftrelay setup --dry-run\ndraftrelay setup\ndraftrelay serve --open", "Build and start the local edition")}
        <p><code>draftrelay setup --dry-run</code> shows the filesystem and client-registration actions before applying them. <code>draftrelay serve --open</code> starts the review UI and optional loopback HTTP MCP endpoint. The stdio registration does not require a server to remain running; the client launches it when needed.</p>
      </section>
      <section class="content-section" id="clients">
        <p class="kicker"><span>03</span>Connect</p>
        <h2>Stdio is the recommended local transport.</h2>
        ${codeBlock("claude mcp add --transport stdio --scope user draftrelay -- draftrelay mcp --client claude-code\ncodex mcp add draftrelay -- draftrelay mcp --client codex", "Equivalent local client registrations")}
        <p>The setup command can manage those registrations for you. If a client specifically requires Streamable HTTP, run <code>draftrelay serve</code> and register <code>http://127.0.0.1:3939/mcp</code>. That endpoint is unauthenticated and intentionally refuses non-loopback hosts.</p>
      </section>
      <section class="content-section" id="data">
        <p class="kicker"><span>04</span>Data ownership</p>
        <h2>SQLite makes inspection and backup ordinary.</h2>
        <p>The local database contains artifacts, all revisions, project policy, supplied provenance, redacted finding records, destination representations, and event receipts. The CLI can create a consistent backup and export filtered artifacts as JSON or Markdown.</p>
        ${codeBlock("draftrelay backup\ndraftrelay export --format json --output ./draftrelay-export.json\ndraftrelay latest --project Acme --copy slack", "Backup, export, and copy examples")}
        <p>Backups and exports can contain sensitive client or project material. Protect them like the database, and verify a backup before deleting the original. Uninstall preserves data unless the explicit purge and confirmation flags are supplied.</p>
      </section>
      <section class="content-section" id="boundary">
        <p class="kicker"><span>05</span>Boundary</p>
        <h2>Self-hosting transfers operational responsibility to you.</h2>
        <p>The current local process has no accounts, remote authorization, cloud sync, or third-party delivery integration. Keep it bound to loopback. Do not publish it through a tunnel, reverse proxy, container port, LAN address, or public hostname. Container packaging alone would not add the authentication and tenant isolation needed for remote use.</p>
        <p>The source license permits use, inspection, modification, and redistribution under the MIT terms. Trademark rights and the hosted service are separate from the source-code license. Review the repository license included with your checkout for the controlling text.</p>
      </section>
      ${relatedLinks([
        { href: "/security", label: "Understand both security boundaries" },
        { href: "/mcp", label: "See the MCP tool contract" },
        { href: "/docs", label: "Use the hosted service" }
      ])}`
  },
  "/mcp": {
    title: (context) => `MCP Server for Claude Code and Codex | ${context.appName}`,
    description: (context) => `${context.appName} is a focused MCP server for saving one final AI-agent artifact, reviewing it, revising it, and preparing copy for a destination.`,
    eyebrow: "Model Context Protocol",
    h1: "One MCP job: hand the useful result back",
    lede: (context) => `${context.appName} does not try to become an agent framework. Its MCP surface gives an agent a narrow place to save a polished deliverable and gives the human a stable receipt for review.`,
    contents: [
      { href: "#contract", label: "The contract" },
      { href: "#tools", label: "Available tools" },
      { href: "#transport", label: "Transport and auth" },
      { href: "#prompt", label: "Prompt the handoff" },
      { href: "#not", label: "What it does not do" }
    ],
    body: (context) => `
      <section class="content-section" id="contract">
        <p class="kicker"><span>01</span>Contract</p>
        <h2>The unit of work is an artifact, not a conversation.</h2>
        <p>An artifact is the thing a person intends to read, paste, send, or act on: a client reply, Slack update, PR description, incident brief, decision, command set, or concise summary. It should stand on its own without terminal chatter. The MCP instructions explicitly exclude chain-of-thought, hidden reasoning, raw research dumps, tool traces, credentials, duplicate drafts, and whole transcripts.</p>
        <p>This distinction keeps the tool smaller than a notes database and more deliberate than clipboard history. The agent composes the result; ${context.appName} records its delivery state, source claims, safety findings, and destination representations.</p>
      </section>
      <section class="content-section" id="tools">
        <p class="kicker"><span>02</span>Tools</p>
        <h2>A small, inspectable surface.</h2>
        <table class="content-table" tabindex="0"><caption>MCP tools and their effects</caption><thead><tr><th>Tool</th><th>Use it for</th><th>Mutation</th></tr></thead><tbody>
          <tr><td><code>save_output</code></td><td>Create one final free-form or typed artifact.</td><td>Creates an item and revision.</td></tr>
          <tr><td><code>list_outputs</code></td><td>Find recent items without returning every body.</td><td>Read-only.</td></tr>
          <tr><td><code>read_output</code></td><td>Fetch current content, revision, and status.</td><td>Read-only.</td></tr>
          <tr><td><code>revise_output</code></td><td>Create a guarded immutable revision.</td><td>Adds a revision.</td></tr>
          <tr><td><code>mark_output_used</code></td><td>Enforce policy, record destination use, and optionally finish.</td><td>Adds a receipt and may change status.</td></tr>
        </tbody></table>
        <p>Write and use operations require the corresponding OAuth scopes. Idempotency keys and client event IDs are available where a retry could otherwise create duplicate work.</p>
      </section>
      <section class="content-section" id="transport">
        <p class="kicker"><span>03</span>Transport</p>
        <h2>Remote HTTP is authenticated; local HTTP is not interchangeable.</h2>
        <p>The hosted endpoint is <code>${context.mcpUrl}</code>. It uses Streamable HTTP, OAuth discovery, dynamic client registration, scoped access, and revocable connections. Register it with a supported client rather than manufacturing or pasting an application token.</p>
        ${codeBlock(`claude mcp add --transport http --scope user draftrelay ${context.mcpUrl}\ncodex mcp add draftrelay --url ${context.mcpUrl}`, "Hosted MCP registration")}
        <p>The open-source local edition recommends stdio. Its optional HTTP endpoint is restricted to <code>127.0.0.1</code> and has no authentication. Never replace the hosted URL with a publicly exposed local endpoint.</p>
      </section>
      <section class="content-section" id="prompt">
        <p class="kicker"><span>04</span>Prompt</p>
        <h2>Name the audience, shape, and evidence.</h2>
        <blockquote>After the implementation and tests are complete, save one GitHub PR description to DraftRelay. Include a concise summary, changed behavior, test plan, risk, branch, commit, and referenced files. Do not include tool logs or hidden reasoning.</blockquote>
        <p>Good prompts say when to save—after the work is finished—and what the result is for. They do not ask the server to infer verification that never happened. If tests were not run, the agent should record that status plainly.</p>
      </section>
      <section class="content-section" id="not">
        <p class="kicker"><span>05</span>Boundaries</p>
        <h2>The server does not monitor or publish for you.</h2>
        <p>${context.appName} cannot see terminal scrollback unless the agent deliberately places text in a tool call. It does not capture keystrokes, run saved commands, verify provenance independently, or post directly to third-party destinations. A human opens the review surface and performs the final copy action.</p>
      </section>
      ${relatedLinks([
        { href: "/integrations/claude-code", label: "Connect Claude Code" },
        { href: "/integrations/codex", label: "Connect Codex" },
        { href: "/guides/save-ai-agent-output", label: "Design a good saved artifact" }
      ])}`
  },
  "/integrations/claude-code": {
    title: (context) => `Connect Claude Code to ${context.appName} with MCP`,
    description: (context) => `Add ${context.appName} to Claude Code as a remote HTTP MCP server, complete OAuth, verify the connection, and save a focused deliverable.`,
    eyebrow: "Integration · Claude Code",
    h1: "Give Claude Code a clean place to finish",
    lede: (context) => `Connect Claude Code to ${context.appName} once, then ask Claude to save the polished result of a session. Use Claude Code’s native copy command for a quick one-off; use the review inbox when the result needs structure, provenance, safety review, revisions, or a destination format.`,
    contents: [
      { href: "#add", label: "Add the server" },
      { href: "#authorize", label: "Authorize and verify" },
      { href: "#use", label: "Save a result" },
      { href: "#copy", label: "When to use /copy" },
      { href: "#remove", label: "Revoke or remove" }
    ],
    body: (context) => `
      <section class="content-section" id="add">
        <p class="kicker"><span>01</span>Add</p>
        <h2>Register the hosted Streamable HTTP endpoint.</h2>
        ${codeBlock(`claude mcp add --transport http --scope user draftrelay ${context.mcpUrl}`, "Run in a terminal")}
        <p><code>--scope user</code> makes the registration available to your Claude Code user rather than writing it into one project. Use a project or local scope only when that narrower placement is intentional. The name <code>draftrelay</code> is the client-side label; the actual protected endpoint is <code>${context.mcpUrl}</code>.</p>
      </section>
      <section class="content-section" id="authorize">
        <p class="kicker"><span>02</span>Authorize</p>
        <h2>Complete the browser sign-in from Claude Code.</h2>
        <p>Start Claude Code and run <code>/mcp</code>. Select the DraftRelay connection and follow the authentication prompt. Review the requested output scopes before approving. Claude Code should return to the session after authorization.</p>
        <p>Use <code>/mcp</code> again to confirm that the server is connected and its tools are visible. If the browser flow fails, verify that the URL is exactly <code>${context.mcpUrl}</code>, sign in to <a href="/login">${context.appName}</a> in the same browser, and retry. Do not substitute a copied session cookie or manually created bearer token.</p>
      </section>
      <section class="content-section" id="use">
        <p class="kicker"><span>03</span>Use</p>
        <h2>Tell Claude what the saved artifact is for.</h2>
        <blockquote>Draft the final client reply, then save only the approved reply to DraftRelay under the Acme project, tagged billing. Keep it under 180 words and include the next action. Do not save our terminal conversation.</blockquote>
        <p>Claude should call <code>save_output</code> once and return a direct review URL. Open it to check Markdown, provenance, and secret warnings. If you ask Claude to revise a saved item later, it can read the current revision and create a new one without erasing the original.</p>
      </section>
      <section class="content-section" id="copy">
        <p class="kicker"><span>04</span>Native copy</p>
        <h2>Use <code>/copy</code> when the latest response is already enough.</h2>
        <p>Claude Code has a built-in <code>/copy</code> command for copying the most recent assistant response. That is the shortest path when you only need that response now and do not need to keep a reviewed artifact.</p>
        <p>${context.appName} solves a different last-mile problem: extract one part from a noisy session, preserve it across clients, organize it by project and tags, keep immutable revisions and supplied provenance, flag likely secrets, and prepare Slack, email, GitHub, Markdown, or plain-text variants. It complements <code>/copy</code>; it should not replace a simpler native command when the native command is sufficient.</p>
      </section>
      <section class="content-section" id="remove">
        <p class="kicker"><span>05</span>Disconnect</p>
        <h2>Remove both sides when access is no longer needed.</h2>
        <p>Remove the MCP registration from Claude Code using its MCP management commands, and revoke the corresponding OAuth connection in ${context.appName} account settings. Removing only the local label does not express your intent as clearly as revoking the server-side grant too.</p>
      </section>
      ${relatedLinks([
        { href: "/guides/copy-claude-code-output", label: "Choose the right Claude Code copy workflow" },
        { href: "/mcp", label: "Understand the MCP tools" },
        { href: "/security", label: "Review OAuth and content safety" }
      ])}`
  },
  "/integrations/codex": {
    title: (context) => `Connect Codex CLI to ${context.appName} with MCP`,
    description: (context) => `Register ${context.appName} in Codex CLI, sign in through OAuth, verify the remote MCP server, and save copy-ready AI output.`,
    eyebrow: "Integration · Codex",
    h1: "Move the finished Codex result out of scrollback",
    lede: (context) => `${context.appName} gives Codex a focused MCP handoff: the agent saves one polished artifact and returns a browser receipt, while you review and copy the destination version you need.`,
    contents: [
      { href: "#add", label: "Add and sign in" },
      { href: "#verify", label: "Verify the server" },
      { href: "#use", label: "Save a result" },
      { href: "#troubleshoot", label: "Troubleshoot" },
      { href: "#disconnect", label: "Disconnect" }
    ],
    body: (context) => `
      <section class="content-section" id="add">
        <p class="kicker"><span>01</span>Add</p>
        <h2>Register the URL, then start the OAuth login.</h2>
        ${codeBlock(`codex mcp add draftrelay --url ${context.mcpUrl}\ncodex mcp login draftrelay`, "Run in a terminal")}
        <p>The first command records a remote MCP server named <code>draftrelay</code>. The second starts the authorization flow. Sign in through the browser, inspect the requested output scopes, and approve only if the hostname and application are the ones you expect.</p>
      </section>
      <section class="content-section" id="verify">
        <p class="kicker"><span>02</span>Verify</p>
        <h2>Check the configured server before relying on it.</h2>
        ${codeBlock("codex mcp list", "List Codex MCP servers")}
        <p>Confirm that <code>draftrelay</code> points to <code>${context.mcpUrl}</code>. In a Codex session, ask the agent to list the DraftRelay tools or save a harmless test note. A successful save returns an item ID, revision, lifecycle status, and review URL.</p>
      </section>
      <section class="content-section" id="use">
        <p class="kicker"><span>03</span>Use</p>
        <h2>Make the handoff part of the finish condition.</h2>
        <blockquote>Implement and verify the change. When the work is complete, save one DraftRelay PR description under the Payments project with summary, test plan, risk, branch, commit, and referenced files. Do not save command output or the conversation.</blockquote>
        <p>Putting the save after verification helps the artifact reflect the actual outcome instead of an early plan. If verification is partial or failed, ask Codex to say that plainly in both the copy and provenance rather than presenting an unverified result as complete.</p>
      </section>
      <section class="content-section" id="troubleshoot">
        <p class="kicker"><span>04</span>Troubleshoot</p>
        <h2>Separate registration, authentication, and policy failures.</h2>
        <dl class="content-definitions">
          <dt>The server is absent</dt><dd>Run <code>codex mcp list</code> and add the URL again if the label is missing.</dd>
          <dt>Login is required</dt><dd>Run <code>codex mcp login draftrelay</code> and complete the browser flow.</dd>
          <dt>A tool lacks permission</dt><dd>Reconnect and approve the required read, write, or use scope.</dd>
          <dt>A save is rejected</dt><dd>Read the returned validation, quota, or redacted secret-policy error; do not retry unchanged content indefinitely.</dd>
          <dt>Copy is blocked</dt><dd>Open the review URL and satisfy the project’s review or acknowledgement policy.</dd>
        </dl>
      </section>
      <section class="content-section" id="disconnect">
        <p class="kicker"><span>05</span>Disconnect</p>
        <h2>Revoke access when the client should stop using the inbox.</h2>
        <p>Remove the Codex MCP registration with the Codex CLI and revoke its OAuth connection from ${context.appName} account settings. A revoked connection loses its access and refresh credentials; reconnecting requires a new authorization.</p>
      </section>
      ${relatedLinks([
        { href: "/mcp", label: "Read the MCP contract" },
        { href: "/guides/save-ai-agent-output", label: "Create better saved artifacts" },
        { href: "/security", label: "Understand hosted access controls" }
      ])}`
  },
  "/guides/copy-claude-code-output": {
    title: (context) => `How to Copy Claude Code Output Cleanly | ${context.appName}`,
    description: () => "Use Claude Code’s native /copy for the latest response, or save a focused, reviewable artifact when terminal output is noisy or needs reuse.",
    eyebrow: "Guide · Claude Code output",
    h1: "Copy the answer, not the terminal session",
    lede: (context) => `The fastest method is Claude Code’s native <code>/copy</code> when the latest assistant response is exactly what you need. When the useful part is buried in a long session or needs to survive as a reviewed deliverable, ask Claude to save that part to ${context.appName}.`,
    contents: [
      { href: "#choose", label: "Choose the shortest path" },
      { href: "#native", label: "Use native /copy" },
      { href: "#extract", label: "Extract a focused artifact" },
      { href: "#review", label: "Review before pasting" },
      { href: "#patterns", label: "Reusable prompts" }
    ],
    body: (context) => `
      <section class="content-section" id="choose">
        <p class="kicker"><span>01</span>Choose</p>
        <h2>Match the tool to the amount of ceremony you need.</h2>
        <table class="content-table" tabindex="0"><caption>Which Claude Code output workflow to use</caption><thead><tr><th>Situation</th><th>Best first move</th></tr></thead><tbody>
          <tr><td>The latest Claude response is already correct.</td><td>Run <code>/copy</code>.</td></tr>
          <tr><td>You need the full session as a record.</td><td>Use Claude Code’s conversation export workflow.</td></tr>
          <tr><td>You need one reply, summary, command set, or update from a noisy session.</td><td>Ask Claude to extract and save one artifact.</td></tr>
          <tr><td>You need revisions, provenance, secret review, projects, tags, or destination formatting.</td><td>Use ${context.appName}.</td></tr>
        </tbody></table>
        <p>Avoid adding a storage system to a one-second copy task. Also avoid copying an entire terminal buffer merely because the useful answer is hard to select.</p>
      </section>
      <section class="content-section" id="native">
        <p class="kicker"><span>02</span>Native copy</p>
        <h2>Start with <code>/copy</code>.</h2>
        <p>In Claude Code, run <code>/copy</code> to copy the most recent assistant response. Paste it into a scratch area and inspect it before sending. This keeps the workflow inside Claude Code and avoids creating another saved item.</p>
        <p>Native copy is less useful when the response contains commentary you do not want, when the desired text appeared earlier, or when the result needs a different shape for Slack, email, or a pull request. In those cases, ask Claude to produce a final version first instead of manually trimming a large selection.</p>
      </section>
      <section class="content-section" id="extract">
        <p class="kicker"><span>03</span>Extract</p>
        <h2>State what the clean artifact must include and exclude.</h2>
        <blockquote>Extract the final client response from this session. Keep it under 150 words, use complete sentences, include the decision and next step, and remove internal implementation details. Save only that reply to DraftRelay under Acme, tagged renewal.</blockquote>
        <p>Claude composes the artifact and calls <code>save_output</code>. ${context.appName} does not read the terminal or decide which lines matter on its own. That constraint is useful: the handoff remains an explicit part of your request.</p>
      </section>
      <section class="content-section" id="review">
        <p class="kicker"><span>04</span>Review</p>
        <h2>Check meaning before formatting.</h2>
        <ol class="content-steps"><li><strong>Read the artifact as the recipient.</strong><span>Make sure it is self-contained and does not refer to unseen terminal context.</span></li><li><strong>Verify names, numbers, links, and claims.</strong><span>Provenance is useful context, not automatic proof.</span></li><li><strong>Resolve safety findings.</strong><span>Remove secrets rather than relying on a warning to protect them.</span></li><li><strong>Choose a destination version.</strong><span>Preview the Slack, email, GitHub, Markdown, or plain-text representation.</span></li><li><strong>Copy and paste manually.</strong><span>Review the final target once more, especially mentions and links, before sending.</span></li></ol>
      </section>
      <section class="content-section" id="patterns">
        <p class="kicker"><span>05</span>Prompt patterns</p>
        <h2>Make the finish condition concrete.</h2>
        <ul><li><strong>Reply:</strong> “Save only the final reply; exclude analysis and internal notes.”</li><li><strong>Summary:</strong> “Save five bullets: outcome, evidence, risk, blocker, next action.”</li><li><strong>Commands:</strong> “Save copy-safe commands with working directories and a warning before destructive steps.”</li><li><strong>Status update:</strong> “Write for Slack, lead with the result, and separate verified facts from next steps.”</li></ul>
      </section>
      ${relatedLinks([
        { href: "/integrations/claude-code", label: "Connect Claude Code" },
        { href: "/guides/save-ai-agent-output", label: "Save durable AI-agent output" },
        { href: "/guides/markdown-to-slack", label: "Prepare Markdown for Slack" }
      ])}`
  },
  "/guides/save-ai-agent-output": {
    title: (context) => `How to Save Useful AI Agent Output | ${context.appName}`,
    description: () => "Turn AI-agent sessions into concise, durable artifacts with a clear audience, recipe, evidence, provenance, review state, and copy destination.",
    eyebrow: "Guide · Agent handoffs",
    h1: "Save the deliverable, not the conversation",
    lede: (context) => `A useful saved output is smaller than a transcript and more complete than a clipboard fragment. It tells a future reader what happened, what is verified, and what they should do next. ${context.appName} makes that artifact the unit of the workflow.`,
    contents: [
      { href: "#artifact", label: "Define the artifact" },
      { href: "#shape", label: "Choose a shape" },
      { href: "#evidence", label: "Carry evidence carefully" },
      { href: "#workflow", label: "Use the lifecycle" },
      { href: "#avoid", label: "Avoid common failures" }
    ],
    body: (context) => `
      <section class="content-section" id="artifact">
        <p class="kicker"><span>01</span>Artifact</p>
        <h2>Begin with the human action at the other end.</h2>
        <p>“Save the output” is vague. Name the thing: a client email to approve, a Slack update to post, a pull-request description to submit, an incident brief to hand over, a decision record to retain, or a command set to run. Then name the audience and the next action.</p>
        <p>The artifact should be readable without the agent session. Replace “as discussed above” with the actual decision. Replace “tests passed” with which checks ran when that detail matters. Remove tool chatter, failed drafts, and branches of reasoning that do not belong in the deliverable.</p>
      </section>
      <section class="content-section" id="shape">
        <p class="kicker"><span>02</span>Shape</p>
        <h2>Use a recipe when missing a field would make the handoff weaker.</h2>
        <p>Typed recipes give Slack updates, client emails, GitHub pull requests, incident summaries, decisions, and command sets explicit fields. That helps the agent remember an ask, test plan, risk, impact, or warning. Use free-form Markdown when the deliverable does not fit a recipe or the structure would add noise.</p>
        <blockquote>Save a DraftRelay incident summary for Payments. Status: mitigated. Include impact, a short UTC timeline, confirmed root cause, follow-up owners, and unresolved questions. Mark unverified details as unverified.</blockquote>
      </section>
      <section class="content-section" id="evidence">
        <p class="kicker"><span>03</span>Evidence</p>
        <h2>Attach source context without pretending it is proof.</h2>
        <p>When a client knows the context, it can supply its name and version, agent or model, session, working directory, repository root and remote, branch, commit, dirty-tree state, verification status, a verification summary, and referenced file lines. Missing fields remain unknown.</p>
        <p>Ask for provenance that helps review. A client email rarely needs a local path. A PR description benefits from branch, commit, tests, and referenced files. An incident brief may need source systems and timestamps, but not a raw log dump. Never place credentials in provenance fields.</p>
      </section>
      <section class="content-section" id="workflow">
        <p class="kicker"><span>04</span>Lifecycle</p>
        <h2>Let the status communicate delivery, not author confidence.</h2>
        <p><code>new</code> means the artifact arrived. <code>reviewed</code> means a human checked it. <code>copied</code> means a destination copy action succeeded. <code>done</code> means the handoff is complete and can leave the active outbox. Revising an item returns it to <code>new</code> because the current text has changed.</p>
        <p>A project can require human review before copy, require acknowledgement of secret findings, restrict destinations, and decide whether a copy marks an item copied or done. These policies make repetitive handoffs consistent without letting the agent send anything automatically.</p>
      </section>
      <section class="content-section" id="avoid">
        <p class="kicker"><span>05</span>Failure modes</p>
        <h2>Most bad artifacts are too broad, too early, or too certain.</h2>
        <ul><li><strong>Too broad:</strong> a transcript or research dump forces the recipient to repeat the agent’s synthesis.</li><li><strong>Too early:</strong> a saved plan is presented as an outcome before implementation or verification finishes.</li><li><strong>Too certain:</strong> inferred facts and unrun tests are written as confirmed.</li><li><strong>Too context-dependent:</strong> the copy refers to terminal lines or files the recipient cannot see.</li><li><strong>Too automatic:</strong> destination formatting is trusted without a final human review.</li></ul>
      </section>
      ${relatedLinks([
        { href: "/mcp", label: "Use the MCP tool model" },
        { href: "/guides/markdown-to-slack", label: "Create a Slack-ready representation" },
        { href: "/security", label: "Apply review and secret policy" }
      ])}`
  },
  "/guides/markdown-to-slack": {
    title: (context) => `Markdown to Slack Without Broken Formatting | ${context.appName}`,
    description: () => "Prepare Markdown for Slack by adapting headings, bold text, links, task lists, and tables, then review mentions and links before posting.",
    eyebrow: "Guide · Markdown to Slack",
    h1: "Make Markdown readable in Slack",
    lede: (context) => `Slack’s message formatting is similar to Markdown, but it is not identical. ${context.appName} prepares a Slack representation from the reviewed source artifact and warns when a structure such as a Markdown table may lose fidelity.`,
    contents: [
      { href: "#differences", label: "Know the differences" },
      { href: "#transform", label: "What gets transformed" },
      { href: "#workflow", label: "Use a safe workflow" },
      { href: "#example", label: "See an example" },
      { href: "#check", label: "Final checks" }
    ],
    body: (context) => `
      <section class="content-section" id="differences">
        <p class="kicker"><span>01</span>Differences</p>
        <h2>Do not treat the Slack composer as a full Markdown renderer.</h2>
        <p>Markdown headings, labeled links, and task-list markers need adaptation for Slack-style text. Tables have no reliable equivalent in an ordinary message. Deeply nested lists, complex HTML, images, and footnotes should be rewritten for the channel rather than passed through mechanically.</p>
        <p>There is also a difference between text pasted into Slack’s composer and <em>mrkdwn</em> sent through Slack APIs. ${context.appName} prepares copyable Slack text; it does not post through the Slack API. Always inspect the pasted result in the actual target before sending.</p>
      </section>
      <section class="content-section" id="transform">
        <p class="kicker"><span>02</span>Transform</p>
        <h2>Preserve meaning with a smaller formatting vocabulary.</h2>
        <table class="content-table" tabindex="0"><caption>Common Markdown-to-Slack transformations</caption><thead><tr><th>Source Markdown</th><th>Slack representation</th></tr></thead><tbody><tr><td><code>## Status</code></td><td><code>*Status*</code></td></tr><tr><td><code>**verified**</code></td><td><code>*verified*</code></td></tr><tr><td><code>[Preview](https://example.com)</code></td><td><code>&lt;https://example.com|Preview&gt;</code></td></tr><tr><td><code>- [x] Tests</code></td><td><code>• ✅ Tests</code></td></tr><tr><td><code>- [ ] Deploy</code></td><td><code>• ☐ Deploy</code></td></tr></tbody></table>
        <p>Code spans and fenced code remain useful when the content is genuinely code. Markdown tables trigger a warning because their columns may collapse. Rewrite a small table as bullets; attach a file or link to a document when the tabular structure is essential.</p>
      </section>
      <section class="content-section" id="workflow">
        <p class="kicker"><span>03</span>Workflow</p>
        <h2>Keep one source and prepare the destination at copy time.</h2>
        <ol class="content-steps"><li><strong>Write readable source Markdown.</strong><span>Use short headings, compact bullets, and explicit links.</span></li><li><strong>Review the source artifact.</strong><span>Verify the facts before spending time on destination syntax.</span></li><li><strong>Select Slack.</strong><span>${context.appName} builds the current revision’s Slack representation and surfaces warnings.</span></li><li><strong>Copy and paste.</strong><span>Nothing is sent by the product; you control the target channel.</span></li><li><strong>Inspect before sending.</strong><span>Confirm line breaks, links, code, and mentions in Slack itself.</span></li></ol>
      </section>
      <section class="content-section" id="example">
        <p class="kicker"><span>04</span>Example</p>
        <h2>Turn a document-shaped update into a channel-shaped update.</h2>
        ${codeBlock("## Checkout retry fix\n\n**Verified:** 92 billing tests passed.\n\n- [x] Reuse the idempotency key\n- [ ] Run one staging checkout\n\n[Open the preview](https://example.com/preview)", "Source Markdown")}
        ${codeBlock("*Checkout retry fix*\n\n*Verified:* 92 billing tests passed.\n\n• ✅ Reuse the idempotency key\n• ☐ Run one staging checkout\n\n<https://example.com/preview|Open the preview>", "Prepared Slack text")}
      </section>
      <section class="content-section" id="check">
        <p class="kicker"><span>05</span>Final checks</p>
        <h2>Slack can turn small syntax into a real notification.</h2>
        <ul><li>Check every <code>@name</code>, user-group mention, and channel reference before sending.</li><li>Open links and confirm the visible label describes the actual destination.</li><li>Remove secrets, internal paths, customer identifiers, and log fragments that the channel should not receive.</li><li>Keep the first two lines scannable on mobile.</li><li>Use a thread or linked document when the update is too long for a channel message.</li></ul>
      </section>
      ${relatedLinks([
        { href: "/guides/save-ai-agent-output", label: "Write a better source artifact" },
        { href: "/integrations/claude-code", label: "Save from Claude Code" },
        { href: "/integrations/codex", label: "Save from Codex" }
      ])}`
  },
  "/privacy": {
    title: (context) => `Privacy Notice | ${context.appName}`,
    description: (context) => `What ${context.legalName} processes when you use ${context.appName}, why it is needed, where user-controlled agent output fits, and how to request access or deletion.`,
    eyebrow: "Legal · Privacy",
    h1: "Privacy notice",
    lede: (context) => `${context.legalName} operates the hosted ${context.appName} service. ${context.effectiveDate ? `Effective ${context.effectiveDate}, this` : "This"} notice describes information processed by the hosted service. The open-source local edition has a separate local-only data path controlled by the person operating it.`,
    contents: [
      { href: "#scope", label: "Scope" },
      { href: "#collect", label: "Information processed" },
      { href: "#use", label: "How it is used" },
      { href: "#providers", label: "Service providers" },
      { href: "#retention", label: "Retention and deletion" },
      { href: "#rights", label: "Choices and contact" }
    ],
    body: (context) => `
      <section class="content-section" id="scope">
        <p class="kicker"><span>01</span>Scope</p>
        <h2>This notice covers the hosted service.</h2>
        <p>It applies when you visit the public site, create a hosted account, connect an MCP client, save or review artifacts, use destination representations, or manage a subscription. If an organization instructs you to use the service, that organization may have its own privacy responsibilities and policies for the content it asks you to process.</p>
        <p>The local open-source server stores data on the operator’s computer and has no hosted account or cloud synchronization. Its operator decides what is saved, how the database is protected, and how long it is retained.</p>
      </section>
      <section class="content-section" id="collect">
        <p class="kicker"><span>02</span>Information</p>
        <h2>The service processes account, artifact, connection, and operational data.</h2>
        <ul><li><strong>Account data:</strong> name, email address, verification state, password hash, passkey records, sessions, and account timestamps.</li><li><strong>User content:</strong> titles, Markdown, recipe fields, projects, tags, revisions, and the destination representations you request.</li><li><strong>Provenance you or a client supplies:</strong> client and model labels, session identifiers, local paths, repository details, branch, commit, verification notes, and referenced files.</li><li><strong>Review and safety data:</strong> lifecycle changes, redacted secret findings, acknowledgements, copy receipts, and project policy.</li><li><strong>Connection and operational data:</strong> OAuth client and consent records, scopes, request identifiers, IP address, user agent, rate-limit and usage counters, security events, and service logs.</li><li><strong>Billing data:</strong> plan and subscription status plus payment-provider customer and subscription identifiers. Full card details are handled by the payment provider rather than stored in artifacts.</li></ul>
      </section>
      <section class="content-section" id="use">
        <p class="kicker"><span>03</span>Purpose</p>
        <h2>Information is used to provide and protect the workflow you request.</h2>
        <p>${context.legalName} uses this information to authenticate users, authorize MCP clients, store and retrieve artifacts, build requested representations, preserve revisions and provenance, apply project and safety policy, record copy actions, enforce capacity and abuse limits, operate billing, send transactional account messages, diagnose failures, respond to support or security reports, and comply with applicable legal obligations.</p>
        <p>Do not save personal data, confidential information, or credentials unless you are authorized to process it and the hosted service is appropriate for that use. Secret scanning is a fallible guardrail and does not change your responsibility for the content you submit.</p>
      </section>
      <section class="content-section" id="providers">
        <p class="kicker"><span>04</span>Providers</p>
        <h2>Specialized providers support the hosted operation.</h2>
        <p>The hosted service uses infrastructure and database providers and uses Stripe for subscription billing. It also uses an email delivery provider for verification and password-reset messages. Depending on deployment configuration, abuse-prevention, caching, and error-monitoring providers may process limited request or diagnostic information.</p>
        <p>Information may also be disclosed when required by applicable law, to investigate abuse or security incidents, to protect users or the service, or as part of a business transaction subject to appropriate safeguards. This notice does not claim that material placed into third-party destinations remains governed by ${context.legalName} after you copy and send it there.</p>
      </section>
      <section class="content-section" id="retention">
        <p class="kicker"><span>05</span>Retention</p>
        <h2>Keep artifacts only while they remain useful.</h2>
        <p>Hosted artifacts and their related revisions remain until a user deletes them or the account, subject to operational backups, security records, billing obligations, and legal requirements. Individual artifact deletion removes the active hosted records associated with that item. Account deletion removes the account through the authentication system and cancels an active subscription; some records may need to remain where law, fraud prevention, dispute handling, or backup integrity requires it.</p>
        <p>No fixed backup-erasure interval is promised on this page. Contact the operator if your use requires a specific retention commitment before placing regulated or sensitive content in the service.</p>
      </section>
      <section class="content-section" id="rights">
        <p class="kicker"><span>06</span>Choices</p>
        <h2>Use account controls first, or contact the operator.</h2>
        <p>You can review and delete artifacts, revoke OAuth clients, manage authentication methods, and delete the hosted account through available product controls. Depending on your location, applicable law may also give you rights to access, correct, delete, restrict, object to, or receive certain personal information.</p>
        <p>Send privacy questions or requests to <a href="${context.legalEmailHref}">${context.legalEmail}</a>. The operator is ${context.legalName}; its stated jurisdiction is ${context.jurisdiction}. The operator may need to verify identity before acting on a request.</p>
      </section>`
  },
  "/terms": {
    title: (context) => `Terms of Service | ${context.appName}`,
    description: (context) => `Terms for accounts, user content, acceptable use, subscriptions, open-source components, termination, and disputes for ${context.appName}.`,
    eyebrow: "Legal · Terms",
    h1: "Terms of service",
    lede: (context) => `${context.effectiveDate ? `Effective ${context.effectiveDate}, these` : "These"} terms govern use of the hosted ${context.appName} service operated by ${context.legalName}. By creating an account or using the hosted service, you agree to these terms and the privacy notice.`,
    contents: [
      { href: "#service", label: "The service" },
      { href: "#accounts", label: "Accounts" },
      { href: "#content", label: "Your content" },
      { href: "#acceptable", label: "Acceptable use" },
      { href: "#subscriptions", label: "Subscriptions" },
      { href: "#ending", label: "Ending use" },
      { href: "#legal", label: "Disclaimers and disputes" }
    ],
    body: (context) => `
      <section class="content-section" id="service">
        <p class="kicker"><span>01</span>Service</p>
        <h2>A review and copy workflow, not an autonomous sender.</h2>
        <p>${context.appName} lets supported MCP clients save final artifacts to a hosted review inbox. It can store revisions and supplied provenance, flag common secret patterns, prepare destination representations, and record review or copy actions. It does not promise that agent output is accurate, lawful, safe, or appropriate for a recipient. You remain responsible for reviewing and deciding whether to use or send it.</p>
        <p>The service may change as protocol clients, security requirements, and product capabilities evolve. Material reductions to a paid service should be communicated through reasonable product or account channels when practicable.</p>
      </section>
      <section class="content-section" id="accounts">
        <p class="kicker"><span>02</span>Accounts</p>
        <h2>Keep account and client access under your control.</h2>
        <p>Provide accurate account information, protect sign-in methods, and promptly revoke devices or OAuth clients you no longer control. You are responsible for activity under your account except to the extent caused by a failure of ${context.legalName} that applicable law places on the operator.</p>
        <p>Use the service only if you can form a binding agreement under applicable law. If you use it for an organization, you confirm that you have authority to accept these terms and process the submitted content for that organization.</p>
      </section>
      <section class="content-section" id="content">
        <p class="kicker"><span>03</span>Content</p>
        <h2>You keep rights in content you are entitled to submit.</h2>
        <p>You grant ${context.legalName} a limited permission to host, process, transform, transmit within the service, back up, and display submitted content only as needed to operate, secure, and support the service and comply with law. This permission does not transfer ownership of your content.</p>
        <p>You confirm that you have the rights and authority needed to submit the content and any personal data it contains. Do not submit credentials, unlawful material, content that violates another person’s rights, or data that contractual or regulatory obligations prohibit you from placing in the service.</p>
      </section>
      <section class="content-section" id="acceptable">
        <p class="kicker"><span>04</span>Acceptable use</p>
        <h2>Do not use the service to harm people, systems, or the shared operation.</h2>
        <ul><li>Do not probe, bypass, or defeat authentication, authorization, tenant isolation, rate limits, or safety controls except through an authorized security test.</li><li>Do not upload malware, executable payloads disguised as content, or material intended to compromise a reviewer or destination.</li><li>Do not use another person’s account, intercept tokens, automate abusive registrations, or access content without permission.</li><li>Do not overload the service, resell an individual account as a multi-tenant service, or use it in violation of law.</li><li>Do not present secret scanning, provenance, or destination conversion as a substitute for human verification.</li></ul>
        <p>The operator may limit or suspend activity reasonably believed to threaten users, third parties, or the service while investigating it.</p>
      </section>
      <section class="content-section" id="subscriptions">
        <p class="kicker"><span>05</span>Subscriptions</p>
        <h2>Free usage is capacity-limited; Pro renews until cancelled.</h2>
        <p>The hosted Free plan has no subscription fee and is subject to the published usage limits. Pro is offered at $1 per month or $10 per year unless checkout clearly states a different price before purchase. Applicable taxes may be added. The selected period renews automatically until the subscription is cancelled.</p>
        <p>Manage or cancel through the account billing controls. Cancellation stops future renewal and access to paid capacity continues as indicated by the billing state. Except where applicable law requires otherwise or checkout states a specific policy, fees already charged are not promised as refundable. If an account returns to Free while stored usage exceeds a free limit, existing content should remain reviewable while new writes can be restricted until usage is reduced or Pro resumes.</p>
      </section>
      <section class="content-section" id="ending">
        <p class="kicker"><span>06</span>Ending use</p>
        <h2>You can delete artifacts or the hosted account.</h2>
        <p>Account deletion cancels an active hosted subscription and begins removal of account data as described in the privacy notice. Export anything you need before deleting it. ${context.legalName} may suspend or terminate access for material breach, security risk, unlawful use, nonpayment, or where continued operation is no longer reasonably possible.</p>
        <p>The open-source local edition is distributed under its included MIT license, not these hosted-service terms. The license covers source code; it does not grant rights in product names, logos, or the operated hosted service.</p>
      </section>
      <section class="content-section" id="legal">
        <p class="kicker"><span>07</span>Legal terms</p>
        <h2>The service is provided without a guarantee that every output is correct.</h2>
        <p>To the extent permitted by law, the service is provided “as is” and “as available,” without implied warranties beyond rights that cannot be excluded. ${context.legalName} is not responsible for decisions, messages, commands, or publications based on agent output that you choose to use without adequate review.</p>
        <p>To the extent permitted by law, ${context.legalName} will not be liable for indirect, incidental, special, consequential, or punitive damages, or loss of profits, data, goodwill, or business opportunity. Any mandatory consumer or statutory rights remain unaffected.</p>
        <p>These terms are governed by the laws applicable in ${context.jurisdiction}, without overriding mandatory protections that apply where you live. Before filing a formal claim, contact <a href="${context.legalEmailHref}">${context.legalEmail}</a> and provide enough detail to try to resolve the issue. Courts with lawful jurisdiction in ${context.jurisdiction} may hear disputes unless applicable law requires another forum.</p>
      </section>`
  }
};

function normalizedPublicPath(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return withLeadingSlash.length > 1 ? withLeadingSlash.replace(/\/+$/, "") : withLeadingSlash;
}

export function isPublicPagePath(path: string): path is PublicPagePath {
  return (PUBLIC_PAGE_PATHS as readonly string[]).includes(path);
}

function header(context: PageContext): string {
  return `<header class="site-header">
    <a class="brand" href="/" aria-label="${context.appName} home"><span class="brand-mark" aria-hidden="true">${context.brandMark}/</span><span><strong>${context.appName}</strong><small>review inbox</small></span></a>
    <nav aria-label="Main navigation"><a href="/docs">Docs</a><a href="/mcp">MCP</a><a href="/security">Security</a><a href="/pricing">Pricing</a></nav>
    <div class="site-actions"><a class="text-link" href="/login">Sign in</a><a class="button button--ink" href="/signup">Start free</a></div>
  </header>`;
}

function footer(context: PageContext): string {
  return `<footer class="site-footer">
    <a class="brand brand--footer" href="/"><span class="brand-mark" aria-hidden="true">${context.brandMark}/</span><span><strong>${context.appName}</strong><small>the review inbox</small></span></a>
    <p>Save the deliverable, not the conversation.</p>
    <nav aria-label="Footer navigation"><a href="/docs">Docs</a><a href="/open-source">Open source</a><a href="/security">Security</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
    <small>${context.legalName} · <a href="${context.legalEmailHref}">${context.legalEmail}</a></small>
  </footer>`;
}

function renderPage(path: PublicPagePath, page: PageDefinition, context: PageContext): string {
  const canonical = context.href(path);
  const title = page.title(context);
  const description = page.description(context);
  const contents = page.contents.map((item) => `<li><a href="${item.href}">${item.label}</a></li>`).join("");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f2efe7" />
    <meta name="robots" content="index,follow,max-image-preview:large" />
    <meta name="description" content="${description}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${context.appName}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${context.href("/social-card.png")}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="A ${context.appName} review card moving a clean agent result to Slack and email." />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${context.href("/social-card.png")}" />
    <meta name="twitter:image:alt" content="A ${context.appName} review card moving a clean agent result to Slack and email." />
    <link rel="canonical" href="${canonical}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/assets/cloud.css" />
    <title>${title}</title>
  </head>
  <body class="marketing-body content-page-body">
    <a class="skip-link" href="#main">Skip to content</a>
    ${header(context)}
    <main class="content-page" id="main" tabindex="-1">
      <header class="content-page__hero">
        <p class="kicker">${page.eyebrow}</p>
        <h1>${page.h1}</h1>
        <p class="content-page__lede">${page.lede(context)}</p>
      </header>
      <div class="content-page__layout">
        <nav class="content-page__toc" aria-label="On this page"><p>On this page</p><ol>${contents}</ol></nav>
        <article class="content-page__article">${page.body(context)}</article>
      </div>
      <aside class="content-cta"><p class="kicker">The useful part is ready</p><h2>Stop hunting through scrollback.</h2><p>Give your agents a clean place to hand work back to you.</p><a class="button button--signal" href="/signup">Create your free inbox</a></aside>
    </main>
    ${footer(context)}
  </body>
</html>`;
}

export function renderPublicPage(path: string, options: PublicPageOptions): string | null {
  const normalized = normalizedPublicPath(path);
  if (!isPublicPagePath(normalized)) return null;
  const context = createContext(options);
  return renderPage(normalized, pages[normalized], context);
}

export function renderSitemapXml(options: PublicPageOptions): string {
  const context = createContext(options);
  const locations = [context.href("/"), ...PUBLIC_PAGE_PATHS.map((path) => context.href(path))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locations.map((location) => `  <url><loc>${location}</loc></url>`).join("\n")}\n</urlset>\n`;
}

export function renderSitemap(options: PublicPageOptions): string {
  return renderSitemapXml(options);
}

export function renderRobotsTxt(options: PublicPageOptions): string {
  const appUrl = normalizeAppUrl(options.appUrl);
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /account",
    "Disallow: /api/",
    "Disallow: /login",
    "Disallow: /signup",
    "Disallow: /reset-password",
    "Disallow: /consent",
    `Sitemap: ${appUrl}/sitemap.xml`,
    ""
  ].join("\n");
}

export function renderRobots(options: PublicPageOptions): string {
  return renderRobotsTxt(options);
}

export function renderLlmsTxt(options: PublicPageOptions): string {
  const appName = plainTextValue(options.appName);
  const baseUrl = normalizeAppUrl(options.appUrl);
  const legalName = plainTextValue(options.legalName);
  const legalEmail = plainTextValue(options.legalEmail);
  return `# ${appName}\n\n> A review inbox for finished AI-agent output. Save the deliverable, not the conversation.\n\nCanonical site: ${baseUrl}/\nRemote MCP endpoint: ${baseUrl}/mcp\n\n## Product facts\n\n- ${appName} accepts focused artifacts from Claude Code, Codex, and compatible MCP clients.\n- The hosted MCP endpoint uses OAuth. The open-source local server recommends stdio and keeps its optional HTTP endpoint on loopback.\n- Agents can save, list, read, and revise artifacts and record destination use.\n- Artifacts support projects, tags, recipes, immutable revisions, supplied provenance, lifecycle state, and secret findings.\n- Destination representations include Slack, email, GitHub, Markdown, and plain text.\n- The product does not read terminal history on its own, store hidden reasoning by design, execute saved commands, or send messages to third parties.\n- A human reviews and copies the result. Secret scanning and provenance are guardrails, not guarantees.\n\n## Documentation\n\n${PUBLIC_PAGE_PATHS.map((path) => `- ${baseUrl}${path}`).join("\n")}\n\n## Preferred source pages\n\n- Product documentation: ${baseUrl}/docs\n- MCP contract: ${baseUrl}/mcp\n- Security model: ${baseUrl}/security\n- Open-source local edition: ${baseUrl}/open-source\n- Privacy notice: ${baseUrl}/privacy\n- Terms: ${baseUrl}/terms\n\n## Contact\n\nOperator: ${legalName}\nEmail: ${legalEmail}\n`;
}

export const publicPageInternals = {
  escapeHtml,
  normalizeAppUrl,
  normalizedPublicPath,
  plainTextValue
};
