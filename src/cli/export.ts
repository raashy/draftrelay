import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import type { OutputItem } from "../shared/items.js";
import { itemQuery, line, openStore, type CliIo, type QueryValues } from "./common.js";
import { getCutlinePaths, writePrivateFileAtomic } from "./paths.js";

export interface ExportValues extends QueryValues {
  dataDir?: string;
  format?: string;
  output?: string;
  force?: boolean;
}

function markdownItem(item: OutputItem): string {
  const metadata = {
    id: item.id,
    title: item.title,
    kind: item.kind,
    project: item.project,
    tags: item.tags,
    sourceClient: item.sourceClient,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    archivedAt: item.archivedAt
  };
  return [
    "---",
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    "",
    `# ${item.title}`,
    "",
    item.contentMarkdown.trim(),
    ""
  ].join("\n");
}

export function serializeExport(
  items: OutputItem[],
  format: "json" | "markdown",
  exportedAt = new Date().toISOString()
): string {
  if (format === "json") {
    return `${JSON.stringify({ schemaVersion: 1, exportedAt, items }, null, 2)}\n`;
  }
  const header = [
    "---",
    "cutlineExportVersion: 1",
    `exportedAt: ${JSON.stringify(exportedAt)}`,
    `itemCount: ${items.length}`,
    "---",
    "",
    "# DraftRelay export",
    ""
  ].join("\n");
  return `${header}${items.map(markdownItem).join("\n---\n\n")}`.trimEnd() + "\n";
}

function exportFormat(value: string | undefined): "json" | "markdown" {
  const format = value ?? "json";
  if (format !== "json" && format !== "markdown" && format !== "md") {
    throw new Error("--format must be json or markdown");
  }
  return format === "md" ? "markdown" : format;
}

export async function runExport(values: ExportValues, io: CliIo): Promise<number> {
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const store = openStore(paths);
  let contents: string;
  try {
    const items = store.list(itemQuery(values, "all")).items;
    contents = serializeExport(items, exportFormat(values.format));
  } finally {
    store.close();
  }

  if (values.output === undefined || values.output === "-") {
    io.stdout(contents);
    return 0;
  }

  const outputPath = path.resolve(values.output);
  if (existsSync(outputPath) && values.force !== true) {
    throw new Error(`${outputPath} already exists; pass --force to replace it`);
  }
  if (existsSync(outputPath) && values.force === true && process.platform === "win32") {
    rmSync(outputPath, { force: true });
  }
  writePrivateFileAtomic(outputPath, contents);
  io.stdout(line(`Exported DraftRelay items to ${outputPath}`));
  return 0;
}

export const exportInternals = {
  exportFormat,
  markdownItem
};
