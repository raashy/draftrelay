import { existsSync, readFileSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";

import { line, type CliIo } from "./common.js";
import {
  clientCommands,
  commandDisplay,
  normalizeClients,
  runCommand,
  type McpClient
} from "./integrations.js";
import { getCutlinePaths, writePrivateFileAtomic } from "./paths.js";

interface InstallState {
  version: 1;
  clients: McpClient[];
}

export interface UninstallValues {
  dataDir?: string;
  clients?: string[];
  dryRun?: boolean;
  force?: boolean;
  purgeData?: boolean;
  yes?: boolean;
}

function installState(filePath: string): InstallState {
  if (!existsSync(filePath)) {
    return { version: 1, clients: [] };
  }
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<InstallState>;
    return {
      version: 1,
      clients: Array.isArray(value.clients)
        ? value.clients.filter((client): client is McpClient => client === "claude" || client === "codex")
        : []
    };
  } catch {
    return { version: 1, clients: [] };
  }
}

function purgeFiles(paths: ReturnType<typeof getCutlinePaths>): void {
  for (const filePath of [
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
    `${paths.databasePath}-journal`,
    paths.configPath,
    paths.installStatePath
  ]) {
    rmSync(filePath, { force: true });
  }
  if (existsSync(paths.backupsDir)) {
    for (const entry of readdirSync(paths.backupsDir, { withFileTypes: true })) {
      if (entry.isFile() && /^cutline-.+\.sqlite3$/.test(entry.name)) {
        rmSync(path.join(paths.backupsDir, entry.name), { force: true });
      }
    }
    try {
      rmdirSync(paths.backupsDir);
    } catch {
      // Preserve unrecognized files rather than deleting a shared or manually chosen directory.
    }
  }

  const directories = [...new Set([paths.stateDir, paths.configDir, paths.dataDir])].sort(
    (left, right) => right.length - left.length
  );
  for (const directory of directories) {
    try {
      rmdirSync(directory);
    } catch {
      // Preserve directories containing files that do not belong to DraftRelay.
    }
  }
}

export async function runUninstall(values: UninstallValues, io: CliIo): Promise<number> {
  if (values.purgeData === true && values.yes !== true && values.dryRun !== true) {
    throw new Error("Deleting local data requires both --purge-data and --yes");
  }

  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const state = installState(paths.installStatePath);
  const clients = normalizeClients(values.clients, state.clients);
  const remaining = new Set(state.clients);

  for (const client of clients) {
    if (!remaining.has(client) && values.force !== true) {
      io.stderr(line(`${client} was not recorded as a DraftRelay-managed integration; skipped.`));
      continue;
    }
    const commands = clientCommands(client, values.dataDir === undefined ? {} : { dataDir: paths.dataDir });
    if (values.dryRun === true) {
      io.stdout(line(`Would run: ${commandDisplay(commands.remove)}`));
      continue;
    }

    const existing = runCommand(commands.get);
    const legacy = clientCommands(client, {
      ...(values.dataDir === undefined ? {} : { dataDir: paths.dataDir }),
      executable: "cutline",
      serverName: "cutline"
    });
    const activeCommands = existing.ok
      ? commands
      : runCommand(legacy.get).ok
        ? legacy
        : undefined;
    if (activeCommands) {
      const removed = runCommand(activeCommands.remove);
      if (!removed.ok) {
        throw new Error(`Could not remove the ${client} integration: ${removed.stderr.trim()}`);
      }
      io.stdout(line(`Removed the DraftRelay integration from ${client}.`));
    } else {
      io.stderr(line(`No active DraftRelay registration was found in ${client}.`));
    }
    remaining.delete(client);
  }

  if (values.dryRun === true) {
    if (values.purgeData === true) {
      io.stdout(line(`Would delete DraftRelay database and backups under ${paths.dataDir}.`));
    } else {
      io.stdout(line(`Would preserve local data at ${paths.dataDir}.`));
    }
    return 0;
  }

  if (values.purgeData === true) {
    purgeFiles(paths);
    io.stdout(line("Deleted DraftRelay's database, backups, configuration, and install state."));
  } else {
    writePrivateFileAtomic(
      paths.installStatePath,
      `${JSON.stringify({ version: 1, clients: [...remaining] } satisfies InstallState, null, 2)}\n`
    );
    io.stdout(line(`Local data was preserved at ${paths.dataDir}.`));
  }
  io.stdout(line("Remove the npm package separately with your package manager when ready."));
  return 0;
}

export const uninstallInternals = {
  installState,
  purgeFiles
};
