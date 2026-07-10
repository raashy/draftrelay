import { createHash, randomBytes } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const password = "correct-horse-battery-staple";
const baseUrl = process.env.E2E_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3941";
const redirectUri = `${baseUrl}/oauth-callback`;
const outputOAuthScope = "outputs:read outputs:write outputs:use";
const claudeOAuthScope = `offline_access ${outputOAuthScope}`;
const fullOAuthScope = `openid offline_access ${outputOAuthScope}`;
const publicPages = [
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

interface OAuthTokenSet {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

interface McpToolResult<T> {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: T;
  isError?: boolean;
}

async function registerPublicClient(
  request: APIRequestContext,
  name: string,
  scope = fullOAuthScope
): Promise<string> {
  const registration = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope
    }
  });
  expect(registration.status()).toBe(201);
  const registered = await registration.json() as { client_id: string };
  expect(registered.client_id).toBeTruthy();
  return registered.client_id;
}

async function authorizePublicClient(
  page: Page,
  clientId: string,
  clientName: string,
  scope = fullOAuthScope
): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const authorize = new URL("/api/auth/oauth2/authorize", baseUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${baseUrl}/mcp`
  }).toString();

  await page.goto(authorize.toString());
  await expect(page).toHaveURL(/\/consent\?/);
  await expect(page.getByText(clientName)).toBeVisible();
  await page.getByRole("button", { name: "Approve connection" }).click();
  await expect(page).toHaveURL(/\/oauth-callback\?/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get("state")).toBe(state);
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  return { code: code ?? "", verifier };
}

async function exchangeAuthorizationCode(
  request: APIRequestContext,
  clientId: string,
  authorization: { code: string; verifier: string }
): Promise<OAuthTokenSet> {
  const response = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: authorization.code,
      code_verifier: authorization.verifier,
      resource: `${baseUrl}/mcp`
    }
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<OAuthTokenSet>;
}

async function refreshAccessToken(
  request: APIRequestContext,
  clientId: string,
  refreshToken: string,
  scope?: string
): Promise<OAuthTokenSet> {
  const response = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource: `${baseUrl}/mcp`,
      ...(scope ? { scope } : {})
    }
  });
  expect(response.status()).toBe(200);
  return response.json() as Promise<OAuthTokenSet>;
}

async function expectInvalidRefresh(
  request: APIRequestContext,
  clientId: string,
  refreshToken: string
): Promise<void> {
  const response = await request.post("/api/auth/oauth2/token", {
    form: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource: `${baseUrl}/mcp`
    }
  });
  expect(response.status()).toBe(400);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toMatchObject({ error: "invalid_grant" });
}

async function callMcpTool<T>(
  request: APIRequestContext,
  accessToken: string,
  id: number,
  name: string,
  arguments_: Record<string, unknown>
): Promise<McpToolResult<T>> {
  const response = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    data: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: arguments_ }
    }
  });
  expect(response.status()).toBe(200);
  const envelope = await response.json() as {
    error?: { code: number; message: string };
    result?: McpToolResult<T>;
  };
  expect(envelope.error).toBeUndefined();
  if (!envelope.result) throw new Error(`MCP tool ${name} returned no result`);
  return envelope.result;
}

function mcpToolText(result: McpToolResult<unknown>): string {
  return result.content
    ?.filter((entry): entry is { type: string; text: string } => typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n") ?? "";
}

function outputScopes(scope: string): string[] {
  return scope.split(/\s+/).filter((entry) => entry.startsWith("outputs:")).sort();
}

async function expectCopiedSetupValue(page: Page, expected: string): Promise<void> {
  await expect(page.locator(".setup-command code")).toContainText(expected);
  if (process.env.E2E_BASE_URL) {
    await expect(page.locator(".setup-panel").getByRole("status")).toContainText("Copied to clipboard");
    return;
  }
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(expected);
}

test("marketing page is crawlable, responsive, and accessible", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/");
  await expect(page).toHaveTitle("DraftRelay — Review and copy output from any AI agent");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your agent finished");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${baseUrl}/`);
  const schemas = page.locator('script[type="application/ld+json"]');
  await expect(schemas).toHaveCount(2);
  const schemaText = (await schemas.allTextContents()).join("\n");
  expect(schemaText).toContain("WebSite");
  expect(schemaText).toContain("FAQPage");
  expect(schemaText).toContain("SoftwareApplication");
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  expect(errors).toEqual([]);

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  const destinationTabs = page.getByRole("tab");
  await destinationTabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(destinationTabs.nth(1)).toBeFocused();
  await expect(destinationTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "destination-tab-email");
  await page.keyboard.press("End");
  await expect(destinationTabs.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(destinationTabs.first()).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Start free" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("public documentation pages are canonical and accessible", async ({ page }) => {
  for (const path of publicPages) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${baseUrl}${path}`
    );
    expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await new AxeBuilder({ page }).analyze()).violations, `${path} at 390px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `${path} has horizontal document overflow at 390px`
    ).toBe(true);
  }
});

test("signup, MCP OAuth, passkey login, revocation, and account deletion work", async ({ page, context, request }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3941" });

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });

  await page.goto("/signup");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Create free account" }).click();
  await expect(page).toHaveURL(/\/app/);
  await expect(page.getByRole("heading", { name: "Connect your first agent." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close setup" })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations, "setup dialog at 390px").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Copy command" }).click();
  await expectCopiedSetupValue(page, "/mcp");
  const claudeTab = page.getByRole("tab", { name: "Claude Code" });
  await claudeTab.focus();
  await claudeTab.press("End");
  const genericTab = page.getByRole("tab", { name: "Other MCP client" });
  await expect(genericTab).toBeFocused();
  await expect(genericTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Copy endpoint" }).click();
  await expectCopiedSetupValue(page, `${baseUrl}/mcp`);
  await expect(page.locator(".setup-panel").getByRole("status")).toContainText("Copied to clipboard");
  await page.getByRole("button", { name: "Go to my inbox" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close setup" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Connect your first agent." })).toHaveCount(0);
  await page.evaluate(() => window.localStorage.removeItem("draftrelay.setup.dismissed"));
  await page.goto("/app?welcome=1");
  await page.getByRole("button", { name: "Go to my inbox" }).click();
  await expect(page.getByRole("heading", { name: "Needs review." })).toBeVisible();
  const inboxSkipLink = page.getByRole("link", { name: "Skip to deliverables" });
  await inboxSkipLink.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#draftrelay-main")).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Open account settings" }).click();
  await expect(page).toHaveURL("/account");

  await page.route("**/oauth-callback?**", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>OAuth callback received</title><main>Authorization received.</main>"
  }));
  const firstClientName = "DraftRelay E2E client";
  const firstClientId = await registerPublicClient(request, firstClientName, outputOAuthScope);
  const firstAuthorization = await authorizePublicClient(
    page,
    firstClientId,
    firstClientName,
    claudeOAuthScope
  );
  const token = await exchangeAuthorizationCode(request, firstClientId, firstAuthorization);
  expect(token.token_type.toLowerCase()).toBe("bearer");
  expect(token.expires_in).toBe(900);
  expect(outputScopes(token.scope)).toEqual(["outputs:read", "outputs:use", "outputs:write"]);
  expect(token.refresh_token).toBeTruthy();

  const initialize = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "draftrelay-e2e", version: "1.0.0" }
      }
    }
  });
  expect(initialize.status()).toBe(200);
  expect((await initialize.text()).toLowerCase()).toContain("draftrelay");

  const artifactTitle = `Destination keyboard test ${Date.now()}`;
  const originalContent = "A safe artifact used to verify destination keyboard navigation.";
  const revisedContent = "A revised artifact that keeps the destination keyboard check intact.";
  type Receipt = {
    id: string;
    title: string;
    revision: number;
    status: string;
    url: string;
    project: string;
  };
  const saved = await callMcpTool<Receipt>(request, token.access_token, 2, "save_output", {
    title: artifactTitle,
    contentMarkdown: originalContent,
    kind: "summary",
    project: "E2E",
    tags: ["oauth-e2e"]
  });
  expect(saved.isError).not.toBe(true);
  expect(saved.structuredContent).toMatchObject({
    title: artifactTitle,
    revision: 1,
    status: "new",
    project: "E2E"
  });
  const artifactId = saved.structuredContent?.id;
  expect(artifactId).toMatch(/^[0-9a-f-]{36}$/);
  if (!artifactId) throw new Error("save_output did not return an artifact id");
  expect(saved.structuredContent?.url).toBe(`${baseUrl}/app?item=${artifactId}`);

  const listed = await callMcpTool<{
    items: Array<Receipt & { kind: string; updatedAt: string }>;
    count: number;
  }>(request, token.access_token, 3, "list_outputs", {
    query: artifactTitle,
    project: "E2E",
    kind: "summary",
    status: "new",
    limit: 5
  });
  expect(listed.isError).not.toBe(true);
  expect(listed.structuredContent?.count).toBe(1);
  expect(listed.structuredContent?.items).toEqual([
    expect.objectContaining({
      id: artifactId,
      title: artifactTitle,
      project: "E2E",
      kind: "summary",
      status: "new",
      revision: 1,
      url: `${baseUrl}/app?item=${artifactId}`
    })
  ]);

  type ReadResult = {
    id: string;
    title: string;
    contentMarkdown: string;
    revision: number;
    status: string;
    project: string;
    tags: string[];
    url: string;
  };
  const read = await callMcpTool<ReadResult>(request, token.access_token, 4, "read_output", {
    id: artifactId
  });
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent).toMatchObject({
    id: artifactId,
    title: artifactTitle,
    contentMarkdown: originalContent,
    revision: 1,
    status: "new",
    project: "E2E",
    tags: ["oauth-e2e"]
  });
  const baseRevision = read.structuredContent?.revision;
  expect(baseRevision).toBe(1);
  if (!baseRevision) throw new Error("read_output did not return a base revision");

  const revised = await callMcpTool<Receipt>(request, token.access_token, 5, "revise_output", {
    id: artifactId,
    contentMarkdown: revisedContent,
    changeNote: "Exercise guarded MCP revision creation.",
    baseRevision
  });
  expect(revised.isError).not.toBe(true);
  expect(revised.structuredContent).toMatchObject({
    id: artifactId,
    title: artifactTitle,
    revision: 2,
    status: "new",
    project: "E2E"
  });

  const readRevision = await callMcpTool<ReadResult>(request, token.access_token, 6, "read_output", {
    id: artifactId
  });
  expect(readRevision.structuredContent).toMatchObject({
    id: artifactId,
    contentMarkdown: revisedContent,
    revision: 2
  });

  await page.goto("/app");
  await page.getByRole("button", { name: artifactTitle, exact: true }).click();
  const inboxDestinationTabs = page.locator(".destination-switcher").getByRole("tab");
  await inboxDestinationTabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(inboxDestinationTabs.nth(1)).toBeFocused();
  await expect(inboxDestinationTabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".destination-workbench").getByRole("tabpanel")).toHaveAttribute(
    "aria-labelledby",
    await inboxDestinationTabs.nth(1).getAttribute("id") ?? ""
  );
  expect((await new AxeBuilder({ page }).analyze()).violations, "open deliverable drawer").toEqual([]);
  await page.getByRole("button", { name: "Close detail" }).click();

  const clientEventId = `e2e-slack-${artifactId}`;
  const used = await callMcpTool<{
    id: string;
    revision: number;
    status: string;
    destination: string;
  }>(request, token.access_token, 7, "mark_output_used", {
    id: artifactId,
    destination: "slack",
    completed: true,
    clientEventId
  });
  expect(used.isError).not.toBe(true);
  expect(used.structuredContent).toEqual({
    id: artifactId,
    revision: 2,
    status: "done",
    destination: "slack"
  });
  const usedRetry = await callMcpTool<typeof used.structuredContent>(
    request,
    token.access_token,
    8,
    "mark_output_used",
    { id: artifactId, destination: "slack", completed: true, clientEventId }
  );
  expect(usedRetry.isError).not.toBe(true);
  expect(usedRetry.structuredContent).toEqual(used.structuredContent);

  const initialRefreshToken = token.refresh_token;
  if (!initialRefreshToken) throw new Error("Authorization code exchange did not issue a refresh token");
  const readOnlyToken = await refreshAccessToken(
    request,
    firstClientId,
    initialRefreshToken,
    "outputs:read"
  );
  expect(readOnlyToken.token_type.toLowerCase()).toBe("bearer");
  expect(outputScopes(readOnlyToken.scope)).toEqual(["outputs:read"]);
  expect(readOnlyToken.refresh_token).toBeTruthy();

  const readWithNarrowedScope = await callMcpTool<ReadResult>(
    request,
    readOnlyToken.access_token,
    9,
    "read_output",
    { id: artifactId }
  );
  expect(readWithNarrowedScope.isError).not.toBe(true);
  expect(readWithNarrowedScope.structuredContent).toMatchObject({
    id: artifactId,
    contentMarkdown: revisedContent,
    revision: 2,
    status: "done"
  });
  const writeWithNarrowedScope = await callMcpTool<Receipt>(
    request,
    readOnlyToken.access_token,
    10,
    "save_output",
    { title: "Must not be saved", contentMarkdown: "The read-only token cannot write this." }
  );
  expect(writeWithNarrowedScope.isError).toBe(true);
  expect(writeWithNarrowedScope.structuredContent).toBeUndefined();
  expect(mcpToolText(writeWithNarrowedScope)).toContain("outputs:write");

  await expectInvalidRefresh(request, firstClientId, initialRefreshToken);
  const rotatedReadOnlyRefresh = readOnlyToken.refresh_token;
  if (!rotatedReadOnlyRefresh) throw new Error("Refresh rotation did not issue a replacement token");
  await expectInvalidRefresh(request, firstClientId, rotatedReadOnlyRefresh);

  const secondClientName = "DraftRelay E2E revocation client";
  const secondClientId = await registerPublicClient(
    request,
    secondClientName,
    `openid profile email offline_access ${outputOAuthScope}`
  );
  const secondAuthorization = await authorizePublicClient(page, secondClientId, secondClientName);
  const secondToken = await exchangeAuthorizationCode(request, secondClientId, secondAuthorization);
  const secondInitialRefresh = secondToken.refresh_token;
  if (!secondInitialRefresh) throw new Error("Second OAuth client did not receive a refresh token");
  const secondRotatedToken = await refreshAccessToken(request, secondClientId, secondInitialRefresh);
  expect(outputScopes(secondRotatedToken.scope)).toEqual(["outputs:read", "outputs:use", "outputs:write"]);
  const secondValidRefresh = secondRotatedToken.refresh_token;
  if (!secondValidRefresh) throw new Error("Second OAuth client did not rotate its refresh token");

  const connectionsResponse = await page.request.get("/api/oauth/connections");
  expect(connectionsResponse.status()).toBe(200);
  const connections = await connectionsResponse.json() as {
    connections: Array<{ consentId: string; clientId: string }>;
  };
  const connection = connections.connections.find((entry) => entry.clientId === secondClientId);
  expect(connection).toBeTruthy();
  const revoked = await page.request.delete(
    `/api/oauth/connections/${encodeURIComponent(connection?.consentId ?? "")}`,
    {
      headers: {
        Origin: baseUrl,
        "Content-Type": "application/json",
        "X-App-Request": "1"
      },
      data: {}
    }
  );
  expect(revoked.status()).toBe(204);
  const retiredClient = await page.request.get(
    `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(secondClientId)}`
  );
  expect(retiredClient.status()).toBe(404);
  await expectInvalidRefresh(request, secondClientId, secondValidRefresh);
  const afterRevocation = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${secondRotatedToken.access_token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "draftrelay-e2e", version: "1.0.0" }
      }
    }
  });
  expect(afterRevocation.status()).toBe(401);
  expect(await afterRevocation.text()).toContain("connection_revoked");

  await page.goto("/account");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("status")).toContainText("Passkey added");

  const accountA11y = await new AxeBuilder({ page }).analyze();
  expect(accountA11y.violations).toEqual([]);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/login");
  await page.waitForTimeout(750);
  if (!page.url().includes("/app")) {
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  }
  await expect(page).toHaveURL(/\/app/);
  if (await page.getByRole("heading", { name: "Connect your first agent." }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Go to my inbox" }).click();
  }
  await page.getByRole("button", { name: "Open account settings" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("status")).toContainText("Primary passkey removed");
  await page.getByLabel("Current password").fill(password);
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(page).toHaveURL("/");
  expect(consoleErrors).toEqual([]);
});
