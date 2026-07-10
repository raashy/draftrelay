import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { ItemStore } from "../server/store.js";
import { backupInternals } from "./backup.js";
import { line, type CliIo } from "./common.js";
import {
  clientCommands,
  commandDisplay,
  installedClients,
  normalizeClients,
  runCommand,
  type McpClient
} from "./integrations.js";
import {
  chmodPrivate,
  ensureCutlinePaths,
  getCutlinePaths,
  writePrivateFileAtomic
} from "./paths.js";

interface InstallState {
  version: 1;
  clients: McpClient[];
}

export interface SetupValues {
  dataDir?: string;
  clients?: string[];
  dryRun?: boolean;
  force?: boolean;
  migrateFrom?: string;
}

function readInstallState(filePath: string): InstallState {
  if (!existsSync(filePath)) {
    return { version: 1, clients: [] };
  }
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<InstallState>;
    const clients = Array.isArray(value.clients)
      ? value.clients.filter((client): client is McpClient => client === "claude" || client === "codex")
      : [];
    return { version: 1, clients };
  } catch {
    return { version: 1, clients: [] };
  }
}

async function migrateDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    throw new Error(`Migration source does not exist: ${sourcePath}`);
  }
  if (existsSync(destinationPath)) {
    throw new Error(`Refusing to overwrite the existing database at ${destinationPath}`);
  }
  const temporaryPath = `${destinationPath}.${process.pid}.migration.tmp`;
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    backupInternals.assertDatabaseIntegrity(source, "The migration source");
    const sourceColumns = new Set(
      source
        .prepare<[], { name: string }>("PRAGMA table_info(items)")
        .all()
        .map((column) => column.name)
    );
    const requiredColumns = [
      "id",
      "title",
      "content_markdown",
      "kind",
      "project",
      "tags_json",
      "source_client",
      "created_at",
      "updated_at",
      "archived_at"
    ];
    if (requiredColumns.some((column) => !sourceColumns.has(column))) {
      throw new Error("Migration source is not a compatible DraftRelay or Cutline SQLite database");
    }
    backupInternals.createPrivateBackupFile(temporaryPath);
    await source.backup(temporaryPath);
    const migrated = new ItemStore({ databasePath: temporaryPath });
    try {
      backupInternals.assertDatabaseIntegrity(migrated.database, "The migrated database");
      migrated.database.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      migrated.close();
    }
    const verification = new Database(temporaryPath, { readonly: true, fileMustExist: true });
    try {
      backupInternals.assertDatabaseIntegrity(verification, "The migrated database");
    } finally {
      verification.close();
    }
    backupInternals.publishPrivateBackupFile(temporaryPath, destinationPath);
    chmodPrivate(destinationPath);
  } finally {
    source.close();
    rmSync(temporaryPath, { force: true });
    rmSync(`${temporaryPath}-wal`, { force: true });
    rmSync(`${temporaryPath}-shm`, { force: true });
  }
}

export async function runSetup(values: SetupValues, io: CliIo): Promise<number> {
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const clients = normalizeClients(values.clients, installedClients());

  io.stdout(line(`${values.dryRun === true ? "Would use" : "Using"} data directory: ${paths.dataDir}`));
  if (values.dryRun !== true) {
    ensureCutlinePaths(paths, true);
    if (!existsSync(paths.configPath)) {
      writePrivateFileAtomic(
        paths.configPath,
        `${JSON.stringify({ version: 1, port: 3939 }, null, 2)}\n`
      );
    }
    chmodPrivate(paths.configPath);
  }

  if (values.migrateFrom !== undefined) {
    const sourcePath = path.resolve(values.migrateFrom);
    if (values.dryRun === true) {
      io.stdout(line(`Would migrate ${sourcePath} to ${paths.databasePath} using SQLite backup.`));
    } else {
      await migrateDatabase(sourcePath, paths.databasePath);
      io.stdout(line(`Migrated ${sourcePath} to ${paths.databasePath}.`));
    }
  } else {
    const legacyPath = path.resolve("data/ai-dump.sqlite3");
    if (!existsSync(paths.databasePath) && existsSync(legacyPath)) {
      io.stderr(
        line(`Legacy data detected at ${legacyPath}. Re-run with --migrate-from ${legacyPath} to copy it safely.`)
      );
    }
  }

  const state = readInstallState(paths.installStatePath);
  const configured = new Set(state.clients);
  for (const client of clients) {
    const commands = clientCommands(client, { dataDir: paths.dataDir });
    if (values.dryRun === true) {
      io.stdout(line(`Would run: ${commandDisplay(commands.add)}`));
      continue;
    }

    const existing = runCommand(commands.get);
    let migratedLegacy: ReturnType<typeof clientCommands> | undefined;
    if (!existing.ok) {
      const legacy = clientCommands(client, {
        dataDir: paths.dataDir,
        executable: "cutline",
        serverName: "cutline"
      });
      const legacyExisting = runCommand(legacy.get);
      if (legacyExisting.ok) {
        if (!configured.has(client) && values.force !== true) {
          io.stderr(line(`${client} has an unmanaged legacy MCP server named cutline; skipped. Use --force to replace it.`));
          continue;
        }
        const removed = runCommand(legacy.remove);
        if (!removed.ok) {
          throw new Error(`Could not migrate the legacy ${client} registration: ${removed.stderr.trim()}`);
        }
        migratedLegacy = legacy;
        io.stdout(line(`Removed the managed legacy cutline registration from ${client}.`));
      }
    }
    if (existing.ok && values.force !== true) {
      io.stderr(line(`${client} already has an MCP server named draftrelay; skipped. Use --force to replace it.`));
      continue;
    }
    if (existing.ok && values.force === true) {
      const removed = runCommand(commands.remove);
      if (!removed.ok) {
        throw new Error(`Could not replace the existing ${client} registration: ${removed.stderr.trim()}`);
      }
    }

    const added = runCommand(commands.add);
    if (!added.ok) {
      if (migratedLegacy) {
        const restored = runCommand(migratedLegacy.add);
        if (!restored.ok) {
          throw new Error(
            `Could not configure ${client}, and the legacy registration could not be restored: ` +
            `${added.stderr.trim() || added.stdout.trim()}; restore error: ${restored.stderr.trim()}`
          );
        }
      }
      throw new Error(`Could not configure ${client}: ${added.stderr.trim() || added.stdout.trim()}`);
    }
    configured.add(client);
    writePrivateFileAtomic(
      paths.installStatePath,
      `${JSON.stringify({ version: 1, clients: [...configured] } satisfies InstallState, null, 2)}\n`
    );
    io.stdout(line(`Configured DraftRelay for ${client}.`));
  }

  if (values.dryRun !== true) {
    writePrivateFileAtomic(
      paths.installStatePath,
      `${JSON.stringify({ version: 1, clients: [...configured] } satisfies InstallState, null, 2)}\n`
    );
  }
  if (clients.length === 0) {
    io.stderr(line("No supported MCP clients were selected or found on PATH."));
  }
  return 0;
}

export const setupInternals = {
  migrateDatabase,
  readInstallState
};
