import { describe, expect, it } from "vitest";

import {
  PUBLIC_PAGE_PATHS,
  isPublicPagePath,
  renderLlmsTxt,
  renderPublicPage,
  renderRobots,
  renderRobotsTxt,
  renderSitemap,
  renderSitemapXml,
  type PublicPageOptions
} from "./public-pages.js";

const options: PublicPageOptions = {
  appUrl: "https://draftrelay.example",
  appName: "DraftRelay",
  legalName: "DraftRelay LLC",
  legalEmail: "legal@draftrelay.example",
  jurisdiction: "Dubai, United Arab Emirates",
  effectiveDate: "2026-07-10"
};

function requiredPage(path: string, overrides: Partial<PublicPageOptions> = {}): string {
  const page = renderPublicPage(path, { ...options, ...overrides });
  expect(page).not.toBeNull();
  return page ?? "";
}

function capture(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  expect(match, `Expected ${pattern} to match`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("public content pages", () => {
  it("exports the complete, stable public route set", () => {
    expect(PUBLIC_PAGE_PATHS).toEqual([
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
    ]);
    expect(isPublicPagePath("/docs")).toBe(true);
    expect(isPublicPagePath("/docs/")).toBe(false);
    expect(isPublicPagePath("/app")).toBe(false);
  });

  it("renders substantive, crawlable HTML with unique page-level SEO fields", () => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    const headings = new Set<string>();

    for (const path of PUBLIC_PAGE_PATHS) {
      const html = requiredPage(path);
      const title = capture(html, /<title>([^<]+)<\/title>/);
      const description = capture(html, /<meta name="description" content="([^"]+)" \/>/);
      const heading = capture(html, /<h1>([\s\S]*?)<\/h1>/);

      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html.length).toBeGreaterThan(7_000);
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${options.appUrl}${path}" />`);
      expect(html).toContain('<meta name="robots" content="index,follow,max-image-preview:large" />');
      expect(html).toContain('<link rel="stylesheet" href="/assets/cloud.css" />');
      expect(html).toContain('<body class="marketing-body content-page-body">');
      expect(html).toContain('<main class="content-page" id="main" tabindex="-1">');
      expect(html).toContain('class="content-page__toc"');
      expect(html).toContain('class="content-page__article"');
      expect(html).toContain(`<meta property="og:image" content="${options.appUrl}/social-card.png" />`);
      expect(html).toContain('<meta property="og:image:width" content="1200" />');
      expect(html).toContain('<meta property="og:image:height" content="630" />');
      expect(html).toContain(`<meta name="twitter:image" content="${options.appUrl}/social-card.png" />`);
      expect(html).not.toContain("__APP_");

      const tableCount = html.match(/<table\b/g)?.length ?? 0;
      const captionCount = html.match(/<caption>/g)?.length ?? 0;
      const focusableTableCount = html.match(/<table class="content-table" tabindex="0">/g)?.length ?? 0;
      expect(captionCount).toBe(tableCount);
      expect(focusableTableCount).toBe(tableCount);

      const preCount = html.match(/<pre\b/g)?.length ?? 0;
      const focusablePreCount = html.match(/<pre tabindex="0"/g)?.length ?? 0;
      expect(focusablePreCount).toBe(preCount);

      const fragmentLinks = [...html.matchAll(/href="#([a-z0-9-]+)"/g)].map((match) => match[1]);
      for (const id of fragmentLinks) expect(html).toContain(`id="${id}"`);

      titles.add(title);
      descriptions.add(description);
      headings.add(heading);
    }

    expect(titles.size).toBe(PUBLIC_PAGE_PATHS.length);
    expect(descriptions.size).toBe(PUBLIC_PAGE_PATHS.length);
    expect(headings.size).toBe(PUBLIC_PAGE_PATHS.length);
  });

  it("normalizes trailing slashes and query strings but rejects unknown pages", () => {
    const canonical = requiredPage("docs/?utm_source=test");
    expect(canonical).toContain('href="https://draftrelay.example/docs"');
    expect(renderPublicPage("/not-a-page", options)).toBeNull();
  });

  it("keeps the documented five-field render signature valid when no legal date is supplied", () => {
    const terms = renderPublicPage("/terms", {
      appUrl: options.appUrl,
      appName: options.appName,
      legalName: options.legalName,
      legalEmail: options.legalEmail,
      jurisdiction: options.jurisdiction
    });
    expect(terms).toContain("These terms govern use of the hosted DraftRelay service");
    expect(terms).not.toContain("Effective ,");
  });

  it("documents real MCP commands and gives native Claude copy the shortest path", () => {
    const docs = requiredPage("/docs");
    const claude = requiredPage("/integrations/claude-code");
    const codex = requiredPage("/integrations/codex");
    const copyGuide = requiredPage("/guides/copy-claude-code-output");

    expect(docs).toContain(
      "claude mcp add --transport http --scope user draftrelay https://draftrelay.example/mcp"
    );
    expect(docs).toContain("codex mcp add draftrelay --url https://draftrelay.example/mcp");
    expect(docs).toContain("codex mcp login draftrelay");
    expect(claude).toContain("Use <code>/copy</code> when the latest response is already enough.");
    expect(copyGuide).toContain("Start with <code>/copy</code>.");
    expect(codex).toContain("codex mcp list");

    const slackGuide = requiredPage("/guides/markdown-to-slack");
    expect(slackGuide).toContain("&lt;https://example.com/preview|Open the preview&gt;");
    expect(slackGuide).not.toContain("<https://example.com/preview|Open the preview>");
  });

  it("keeps current product limits and local-release boundaries explicit", () => {
    const pricing = requiredPage("/pricing");
    const openSource = requiredPage("/open-source");

    expect(pricing).toContain("500 saves per month");
    expect(pricing).toContain("10,000 saves per month");
    expect(pricing).toContain("$1 when billed monthly or $10 when billed yearly");
    expect(openSource).toContain("Until an npm registry release is confirmed");
    expect(openSource).toContain("https://github.com/raashy/draftrelay");
    expect(openSource).toContain("draftrelay setup --dry-run");
    expect(openSource).toContain("draftrelay mcp --client claude-code");
    expect(openSource).not.toContain("cutline mcp --client");
    expect(openSource).toContain("Do not publish it through a tunnel");
  });

  it("escapes every configurable HTML value, including legal fields", () => {
    const html = requiredPage("/privacy", {
      appName: 'Relay <img src=x onerror="alert(1)"> & Co',
      legalName: "Operator <script>alert(1)</script>",
      legalEmail: 'legal@example.test\" onmouseover=\"alert(1)',
      jurisdiction: "A & B <Court>"
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Operator &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Relay &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; Co");
    expect(html).toContain("A &amp; B &lt;Court&gt;");
    expect(html).not.toContain('mailto:legal@example.test" onmouseover=');
  });

  it("rejects non-web, credential-bearing, and invalid canonical URLs", () => {
    expect(() => requiredPage("/docs", { appUrl: "javascript:alert(1)" })).toThrow(TypeError);
    expect(() => requiredPage("/docs", { appUrl: "https://user:secret@example.com" })).toThrow(TypeError);
    expect(() => requiredPage("/docs", { appUrl: "not a URL" })).toThrow(TypeError);
  });
});

describe("public discovery documents", () => {
  it("generates an XML sitemap for the homepage and every public page", () => {
    const sitemap = renderSitemapXml(options);
    expect(renderSitemap(options)).toBe(sitemap);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap.match(/<url>/g)).toHaveLength(PUBLIC_PAGE_PATHS.length + 1);
    expect(sitemap).toContain("<loc>https://draftrelay.example/</loc>");
    for (const path of PUBLIC_PAGE_PATHS) {
      expect(sitemap).toContain(`<loc>https://draftrelay.example${path}</loc>`);
    }

    const escaped = renderSitemapXml({ ...options, appUrl: "https://example.com/a&b" });
    expect(escaped).toContain("https://example.com/a&amp;b/docs");
  });

  it("allows public content while keeping account and API surfaces out of crawl", () => {
    const robots = renderRobotsTxt(options);
    expect(renderRobots(options)).toBe(robots);
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /app");
    expect(robots).toContain("Disallow: /account");
    expect(robots).toContain("Disallow: /reset-password");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain("Sitemap: https://draftrelay.example/sitemap.xml");
    expect(robots).not.toContain("Disallow: /mcp");
  });

  it("publishes a useful llms.txt without allowing config values to add sections", () => {
    const llms = renderLlmsTxt({
      ...options,
      appName: "DraftRelay\n## injected",
      legalName: "Operator\n## injected",
      legalEmail: "legal@example.test\n- injected"
    });

    expect(llms).toContain("# DraftRelay ## injected");
    expect(llms).toContain("Remote MCP endpoint: https://draftrelay.example/mcp");
    expect(llms).toContain("- https://draftrelay.example/guides/markdown-to-slack");
    expect(llms).toContain("A human reviews and copies the result");
    expect(llms).not.toContain("\n## injected");
    expect(llms).not.toContain("\n- injected");
  });
});
