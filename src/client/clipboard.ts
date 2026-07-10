import type { Destination, Representation } from "./types";

export type CopyFormat = "rich" | "text" | "markdown";

async function writePlainText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based compatibility path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.setAttribute("aria-hidden", "true");
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable.");
}

export async function copyText(text: string): Promise<void> {
  await writePlainText(text);
}

export async function copyRepresentation(
  representation: Representation,
  preferred: CopyFormat = "rich"
): Promise<CopyFormat> {
  if (!representation.copyAllowed) {
    throw new Error(representation.blockReasons[0] ?? "This output is blocked by project policy.");
  }

  if (preferred === "markdown") {
    await writePlainText(representation.markdownText ?? representation.plainText);
    return "markdown";
  }

  if (representation.destination === "slack") {
    await writePlainText(representation.markdownText ?? representation.plainText);
    return "text";
  }

  if (
    preferred === "rich" &&
    representation.htmlText &&
    navigator.clipboard?.write &&
    "ClipboardItem" in window
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([representation.plainText], { type: "text/plain" }),
          "text/html": new Blob([representation.htmlText], { type: "text/html" })
        })
      ]);
      return "rich";
    } catch {
      // Plain text is the reliable fallback across terminals and browser hosts.
    }
  }

  await writePlainText(
    preferred === "text" || representation.destination === "plain"
      ? representation.plainText
      : representation.markdownText ?? representation.plainText
  );
  return "text";
}

export function destinationLabel(destination: Destination): string {
  const labels: Record<Destination, string> = {
    slack: "Slack",
    email: "Email",
    github: "GitHub",
    plain: "Plain text",
    markdown: "Markdown"
  };
  return labels[destination];
}
