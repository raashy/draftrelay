import type { Destination } from "../shared/items.js";

export const TRANSFORMER_VERSION = 1;

export interface RepresentationContent {
  plainText: string;
  markdownText: string | null;
  htmlText: string | null;
  metadata: Record<string, unknown>;
  warnings: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function inlineHtml(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, "<code>$1</code>");
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  output = output.replace(/\[([^\]]+)]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const url = safeUrl(href);
    return url === null
      ? label
      : `<a href="${escapeHtml(url)}" rel="noreferrer noopener">${label}</a>`;
  });
  return output;
}

export function markdownToSafeHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let listOpen = false;
  let codeOpen = false;
  let codeLines: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${inlineHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      if (codeOpen) {
        output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        codeOpen = false;
      } else {
        codeOpen = true;
      }
      continue;
    }
    if (codeOpen) {
      codeLines.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 2;
      output.push(`<h${level}>${inlineHtml(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    const listItem = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (listItem !== null) {
      flushParagraph();
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${inlineHtml(listItem[1] ?? "")}</li>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  if (codeOpen) {
    output.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushParagraph();
  closeList();
  return output.join("\n");
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^```[^\n]*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "- ")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownToSlack(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*")
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
    .replace(/^\s*[-*+]\s+\[[xX]\]\s+/gm, "• ✅ ")
    .replace(/^\s*[-*+]\s+\[ \]\s+/gm, "• ☐ ")
    .replace(/^\s*[-+]\s+/gm, "• ")
    .trim();
}

function representationWarnings(markdown: string, destination: Destination): string[] {
  const warnings: string[] = [];
  if (destination === "slack" && /^\s*\|.+\|\s*$/m.test(markdown)) {
    warnings.push("Markdown tables may lose their column layout in Slack.");
  }
  if (destination === "plain" && /!\[[^\]]*]\([^)]+\)/.test(markdown)) {
    warnings.push("Images are represented by their alt text in plain text.");
  }
  return warnings;
}

export function buildRepresentation(
  destination: Destination,
  markdown: string,
  recipePayload: Record<string, unknown> | null
): RepresentationContent {
  const plainText = markdownToPlainText(markdown);
  const htmlText = markdownToSafeHtml(markdown);
  const metadata: Record<string, unknown> = {};
  if (
    destination === "email" &&
    recipePayload !== null &&
    typeof recipePayload.subject === "string"
  ) {
    metadata.subject = recipePayload.subject;
  }

  if (destination === "plain") {
    return {
      plainText,
      markdownText: null,
      htmlText: null,
      metadata,
      warnings: representationWarnings(markdown, destination)
    };
  }

  return {
    plainText,
    markdownText: destination === "slack" ? markdownToSlack(markdown) : markdown,
    htmlText,
    metadata,
    warnings: representationWarnings(markdown, destination)
  };
}

export const representationInternals = {
  escapeHtml,
  inlineHtml,
  safeUrl
};
