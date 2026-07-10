import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ITEM_KINDS, type ArchivedFilter, type ItemKind, type ItemQuery } from "../shared/items.js";
import { ItemStore } from "../server/store.js";
import { chmodPrivate, ensureCutlinePaths, type CutlinePaths } from "./paths.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

export function line(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function parsePort(value: string | undefined, fallback = 3939): number {
  if (value === undefined) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return port;
}

export function publicBaseUrl(host: string, port: number): string {
  const urlHost = host === "::1" || host === "[::1]" ? "[::1]" : host;
  return `http://${urlHost}:${port}`;
}

export function parseArchived(value: string | undefined, fallback: ArchivedFilter): ArchivedFilter {
  const archived = value ?? fallback;
  if (archived !== "false" && archived !== "true" && archived !== "all") {
    throw new Error("--archived must be false, true, or all");
  }
  return archived;
}

export function parseKind(value: string | undefined): ItemKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(ITEM_KINDS as readonly string[]).includes(value)) {
    throw new Error(`--kind must be one of: ${ITEM_KINDS.join(", ")}`);
  }
  return value as ItemKind;
}

export interface QueryValues {
  archived?: string;
  query?: string;
  project?: string;
  kind?: string;
  tag?: string;
}

export function itemQuery(values: QueryValues, defaultArchived: ArchivedFilter): ItemQuery {
  return {
    archived: parseArchived(values.archived, defaultArchived),
    ...(values.query === undefined || values.query.trim() === "" ? {} : { q: values.query.trim() }),
    ...(values.project === undefined || values.project.trim() === ""
      ? {}
      : { project: values.project.trim() }),
    ...(values.kind === undefined ? {} : { kind: parseKind(values.kind) }),
    ...(values.tag === undefined || values.tag.trim() === "" ? {} : { tag: values.tag.trim() })
  };
}

export function openStore(paths: CutlinePaths): ItemStore {
  ensureCutlinePaths(paths);
  const store = new ItemStore({ databasePath: paths.databasePath });
  for (const filePath of [
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`
  ]) {
    chmodPrivate(filePath);
  }
  return store;
}

export function resolveStaticDir(cwd = process.cwd(), moduleUrl = import.meta.url): string {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDirectory, "../client"),
    path.resolve(cwd, "dist/client"),
    path.resolve(moduleDirectory, "../../dist/client")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

export function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") {
    return true;
  }
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}
