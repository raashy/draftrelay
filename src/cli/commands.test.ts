import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { ItemStore } from "../server/store.js";
import { backupInternals, runBackup } from "./backup.js";
import type { CliIo } from "./common.js";
import { runExport } from "./export.js";
import { runLatest } from "./latest.js";
import { getCutlinePaths } from "./paths.js";
import { setupInternals } from "./setup.js";
import { runUninstall } from "./uninstall.js";

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text)
    }
  };
}

function seededDataDir(): { root: string; dataDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cutline-commands-"));
  const dataDir = path.join(root, "data");
  const paths = getCutlinePaths({ dataDir });
  mkdirSync(dataDir, { recursive: true });
  const store = new ItemStore({ databasePath: paths.databasePath });
  store.create({
    title: "Client launch update",
    contentMarkdown: "# Ready\n\n- **Launch** is Friday",
    kind: "reply",
    project: "Acme",
    tags: ["launch"],
    sourceClient: "codex"
  });
  store.close();
  return { root, dataDir };
}

describe("CLI data commands", () => {
  it("prints and destination-copies the latest matching item", async () => {
    const { dataDir } = seededDataDir();
    const output = capture();
    let copied = "";
    expect(
      await runLatest(
        { dataDir, project: "Acme", copy: "slack" },
        output.io,
        async (text) => {
          copied = text;
        }
      )
    ).toBe(0);
    expect(copied).toContain("*Ready*");
    expect(copied).toContain("• *Launch* is Friday");
    expect(output.stderr.join("")).toContain("Copied");
    const store = new ItemStore({ databasePath: getCutlinePaths({ dataDir }).databasePath });
    try {
      expect(store.list({ archived: "all" }).items[0]?.status).toBe("copied");
    } finally {
      store.close();
    }
  }, 20_000);

  it("exports lossless JSON to a private file", async () => {
    const { root, dataDir } = seededDataDir();
    const outputPath = path.join(root, "export.json");
    const output = capture();
    expect(await runExport({ dataDir, format: "json", output: outputPath }, output.io)).toBe(0);
    const exported = JSON.parse(readFileSync(outputPath, "utf8")) as {
      schemaVersion: number;
      items: Array<{ title: string }>;
    };
    expect(exported.schemaVersion).toBe(1);
    expect(exported.items[0]?.title).toBe("Client launch update");
  });

  it("uses SQLite's online backup so WAL-backed records are included", async () => {
    const { root, dataDir } = seededDataDir();
    const backupPath = path.join(root, "snapshot.sqlite3");
    const output = capture();
    expect(await runBackup({ dataDir, output: backupPath }, output.io)).toBe(0);
    expect(existsSync(backupPath)).toBe(true);

    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const count = backup.prepare<[], { count: number }>("SELECT count(*) AS count FROM items").get();
      expect(count?.count).toBe(1);
    } finally {
      backup.close();
    }
  });

  it.runIf(process.platform !== "win32")("creates the SQLite backup target privately before writing content", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cutline-backup-mode-"));
    const temporaryPath = path.join(root, "snapshot.tmp");

    backupInternals.createPrivateBackupFile(temporaryPath);

    expect(statSync(temporaryPath).mode & 0o777).toBe(0o600);
  });

  it("does not replace a backup destination created concurrently", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cutline-backup-publish-"));
    const temporaryPath = path.join(root, "snapshot.tmp");
    const destination = path.join(root, "snapshot.sqlite3");
    writeFileSync(temporaryPath, "new backup", { mode: 0o600 });
    writeFileSync(destination, "existing file", { mode: 0o600 });

    expect(() => backupInternals.publishPrivateBackupFile(temporaryPath, destination)).toThrow();
    expect(readFileSync(destination, "utf8")).toBe("existing file");
    expect(readFileSync(temporaryPath, "utf8")).toBe("new backup");
  });

  it("migrates an existing database with a read-only online backup", async () => {
    const { root, dataDir } = seededDataDir();
    const sourcePath = getCutlinePaths({ dataDir }).databasePath;
    const destinationPath = path.join(root, "migrated.sqlite3");
    await setupInternals.migrateDatabase(sourcePath, destinationPath);

    const migrated = new Database(destinationPath, { readonly: true, fileMustExist: true });
    try {
      const count = migrated.prepare<[], { count: number }>("SELECT count(*) AS count FROM items").get();
      expect(count?.count).toBe(1);
    } finally {
      migrated.close();
    }
  });

  it("rejects an unrelated SQLite file instead of reporting an empty migration", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cutline-invalid-migration-"));
    const sourcePath = path.join(root, "unrelated.sqlite3");
    const destinationPath = path.join(root, "migrated.sqlite3");
    const unrelated = new Database(sourcePath);
    unrelated.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    unrelated.close();

    await expect(setupInternals.migrateDatabase(sourcePath, destinationPath)).rejects.toThrow(
      "not a compatible DraftRelay or Cutline SQLite database"
    );
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("preserves data on uninstall unless purge is explicit and confirmed", async () => {
    const { dataDir } = seededDataDir();
    const paths = getCutlinePaths({ dataDir });
    const preserveOutput = capture();
    expect(await runUninstall({ dataDir, clients: ["none"] }, preserveOutput.io)).toBe(0);
    expect(existsSync(paths.databasePath)).toBe(true);
    expect(preserveOutput.stdout.join("")).toContain("preserved");

    const dryRunOutput = capture();
    expect(
      await runUninstall(
        { dataDir, clients: ["none"], dryRun: true, purgeData: true },
        dryRunOutput.io
      )
    ).toBe(0);
    expect(existsSync(paths.databasePath)).toBe(true);

    const purgeOutput = capture();
    expect(
      await runUninstall(
        { dataDir, clients: ["none"], purgeData: true, yes: true },
        purgeOutput.io
      )
    ).toBe(0);
    expect(existsSync(paths.databasePath)).toBe(false);
  });
});
