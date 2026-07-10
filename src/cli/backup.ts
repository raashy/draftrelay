import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, rmSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { line, type CliIo } from "./common.js";
import { chmodPrivate, ensureCutlinePaths, getCutlinePaths } from "./paths.js";

export interface BackupValues {
  dataDir?: string;
  output?: string;
}

function backupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function createPrivateBackupFile(filePath: string): void {
  const descriptor = openSync(filePath, "wx", 0o600);
  closeSync(descriptor);
  chmodPrivate(filePath);
}

function assertDatabaseIntegrity(database: Database.Database, label: string): void {
  const result = String(database.pragma("quick_check", { simple: true }));
  if (result.toLowerCase() !== "ok") {
    throw new Error(`${label} failed SQLite quick_check: ${result}`);
  }
}

function publishPrivateBackupFile(temporaryPath: string, destination: string): void {
  linkSync(temporaryPath, destination);
  rmSync(temporaryPath);
}

export async function runBackup(values: BackupValues, io: CliIo): Promise<number> {
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  if (!existsSync(paths.databasePath)) {
    throw new Error(`No DraftRelay database exists at ${paths.databasePath}`);
  }
  ensureCutlinePaths(paths, true);
  const destination = path.resolve(
    values.output ?? path.join(paths.backupsDir, `cutline-${backupTimestamp()}.sqlite3`)
  );
  if (existsSync(destination)) {
    throw new Error(`${destination} already exists`);
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });

  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  );
  const source = new Database(paths.databasePath, { readonly: true, fileMustExist: true });
  try {
    assertDatabaseIntegrity(source, "The source database");
    createPrivateBackupFile(temporaryPath);
    await source.backup(temporaryPath);
    const verification = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      assertDatabaseIntegrity(verification, "The backup");
    } finally {
      verification.close();
    }
    publishPrivateBackupFile(temporaryPath, destination);
    chmodPrivate(destination);
  } finally {
    source.close();
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath, { force: true });
    }
  }

  io.stdout(line(`Backed up DraftRelay to ${destination}`));
  return 0;
}

export const backupInternals = {
  assertDatabaseIntegrity,
  backupTimestamp,
  createPrivateBackupFile,
  publishPrivateBackupFile
};
