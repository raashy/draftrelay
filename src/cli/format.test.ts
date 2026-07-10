import { describe, expect, it } from "vitest";

import { formatForDestination, markdownToPlain, markdownToSlack } from "./format.js";

describe("destination formatting", () => {
  const markdown = `# Launch update

- **Ready** for [review](https://example.com/review)
- *Waiting* on ~~old copy~~

\`pnpm check\``;

  it("creates Slack-compatible mrkdwn", () => {
    expect(markdownToSlack(markdown)).toContain("*Launch update*");
    expect(markdownToSlack(markdown)).toContain("• *Ready* for <https://example.com/review|review>");
    expect(markdownToSlack(markdown)).toContain("• _Waiting_ on ~old copy~");
  });

  it("creates readable plain text without dropping URLs", () => {
    const plain = markdownToPlain(markdown);
    expect(plain).toContain("Launch update");
    expect(plain).toContain("• Ready for review (https://example.com/review)");
    expect(plain).not.toContain("**");
  });

  it("preserves exact Markdown for Markdown and GitHub", () => {
    expect(formatForDestination(markdown, "markdown")).toBe(markdown);
    expect(formatForDestination(markdown, "github")).toBe(markdown);
  });
});
