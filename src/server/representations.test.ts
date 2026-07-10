import { describe, expect, it } from "vitest";

import {
  buildRepresentation,
  markdownToPlainText,
  markdownToSafeHtml,
  markdownToSlack
} from "./representations.js";

describe("destination representations", () => {
  const markdown = "# Update\n\n**Ready** with [details](https://example.com).\n\n- [x] Tested";

  it("creates destination-aware Markdown and clean text", () => {
    expect(markdownToPlainText(markdown)).toContain("Ready with details (https://example.com)");
    expect(markdownToSlack(markdown)).toContain("*Update*");
    expect(markdownToSlack(markdown)).toContain("<https://example.com|details>");
    expect(buildRepresentation("github", markdown, null).markdownText).toBe(markdown);
  });

  it("creates escaped HTML and never passes raw HTML through", () => {
    const html = markdownToSafeHtml("# Hello\n\n<script>alert(1)</script> **safe**");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<strong>safe</strong>");
  });

  it("includes email subject metadata and Slack table warnings", () => {
    expect(
      buildRepresentation("email", "Body", { subject: "Launch update" }).metadata
    ).toEqual({ subject: "Launch update" });
    expect(buildRepresentation("slack", "| A | B |\n|---|---|", null).warnings).toHaveLength(1);
  });
});
