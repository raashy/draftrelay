export const COPY_DESTINATIONS = ["plain", "markdown", "github", "slack", "email"] as const;
export type CopyDestination = (typeof COPY_DESTINATIONS)[number];

function replaceLinks(markdown: string, renderer: (label: string, url: string) => string): string {
  return markdown.replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) =>
    renderer(String(label), String(url))
  );
}

export function markdownToPlain(markdown: string): string {
  return replaceLinks(
    markdown.replace(/!\[([^\]]*)]\([^)]*\)/g, "$1"),
    (label, url) => (label === url ? url : `${label} (${url})`)
  )
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    .replace(/```[^\n]*\n?/g, "")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownToSlack(markdown: string): string {
  const sections = markdown.split(/(```[\s\S]*?```)/g);
  return sections
    .map((section) => {
      if (section.startsWith("```") && section.endsWith("```")) {
        return section;
      }
      return replaceLinks(section, (label, url) => `<${url}|${label}>`)
        .replace(/^\s*[-*+]\s+/gm, "• ")
        .replace(/~~([^~]+)~~/g, "~$1~")
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "_$1_")
        .replace(/\*\*([^*]+)\*\*/g, "*$1*")
        .replace(/__([^_]+)__/g, "*$1*")
        .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "*$1*");
    })
    .join("")
    .trim();
}

export function formatForDestination(
  markdown: string,
  destination: CopyDestination
): string {
  switch (destination) {
    case "markdown":
    case "github":
      return markdown;
    case "slack":
      return markdownToSlack(markdown);
    case "email":
    case "plain":
      return markdownToPlain(markdown);
  }
}
