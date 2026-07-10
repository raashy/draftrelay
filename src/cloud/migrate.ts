import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const ADVISORY_LOCK_NAME = "draftrelay.cloud.migrations";

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  filePath: string;
  checksum: string;
  sql: string;
}

interface AppliedMigrationRow extends QueryResultRow {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationResult {
  applied: MigrationFile[];
  skipped: MigrationFile[];
}

export interface MigrationOptions {
  directory?: string;
  onProgress?: (message: string) => void;
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const absoluteDirectory = path.resolve(directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const match = MIGRATION_FILE_PATTERN.exec(entry.name);
    if (match === null) {
      throw new Error(
        `Invalid migration filename ${entry.name}; expected NNNN_lowercase_name.sql`
      );
    }
    const versionText = match[1];
    const name = match[2];
    if (versionText === undefined || name === undefined) {
      throw new Error(`Could not parse migration filename ${entry.name}`);
    }
    const filePath = path.join(absoluteDirectory, entry.name);
    const sql = await readFile(filePath, "utf8");
    if (sql.trim() === "") {
      throw new Error(`Migration ${entry.name} is empty`);
    }
    const version = Number(versionText);
    if (version <= 0) {
      throw new Error(`Migration ${entry.name} must use a version from 0001 to 9999`);
    }
    files.push({
      version,
      name,
      fileName: entry.name,
      filePath,
      checksum: checksum(sql),
      sql
    });
  }

  files.sort((left, right) => left.version - right.version || left.fileName.localeCompare(right.fileName));
  const versions = new Set<number>();
  for (const file of files) {
    if (versions.has(file.version)) {
      throw new Error(`Duplicate migration version ${String(file.version).padStart(4, "0")}`);
    }
    versions.add(file.version);
  }
  return files;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS cloud_schema_migration (
      version integer PRIMARY KEY CHECK (version > 0),
      name text NOT NULL,
      checksum text NOT NULL CHECK (char_length(checksum) = 64),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0),
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function appliedMigrations(client: PoolClient): Promise<Map<number, AppliedMigrationRow>> {
  const result = await client.query<AppliedMigrationRow>(
    "SELECT version, name, checksum FROM cloud_schema_migration ORDER BY version"
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function applyMigration(client: PoolClient, migration: MigrationFile): Promise<void> {
  const startedAt = performance.now();
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
    await client.query(
      `INSERT INTO cloud_schema_migration (version, name, checksum, execution_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, executionMs]
    );
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(`Migration ${migration.fileName} failed`, { cause: error });
  }
}

export async function runMigrations(
  database: Pool,
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const directory = path.resolve(options.directory ?? path.join(process.cwd(), "migrations"));
  const migrations = await readMigrationFiles(directory);
  const client = await database.connect();
  const applied: MigrationFile[] = [];
  const skipped: MigrationFile[] = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_NAME]);
    await ensureMigrationTable(client);
    const existing = await appliedMigrations(client);
    const available = new Map(migrations.map((migration) => [migration.version, migration]));

    for (const [version, prior] of existing) {
      const migration = available.get(version);
      if (migration === undefined) {
        throw new Error(
          `Applied migration ${String(version).padStart(4, "0")}_${prior.name} is missing from ${directory}`
        );
      }
      if (prior.name !== migration.name || prior.checksum !== migration.checksum) {
        throw new Error(
          `Applied migration ${String(version).padStart(4, "0")}_${prior.name} ` +
            `does not match ${migration.fileName}; never edit an applied migration`
        );
      }
    }

    const lastAppliedVersion = Math.max(0, ...existing.keys());

    for (const migration of migrations) {
      const prior = existing.get(migration.version);
      if (prior !== undefined) {
        skipped.push(migration);
        options.onProgress?.(`Already applied ${migration.fileName}`);
        continue;
      }
      if (migration.version < lastAppliedVersion) {
        throw new Error(
          `Migration ${migration.fileName} was inserted behind already-applied version ` +
            `${String(lastAppliedVersion).padStart(4, "0")}; add a new forward migration instead`
        );
      }

      options.onProgress?.(`Applying ${migration.fileName}`);
      await applyMigration(client, migration);
      applied.push(migration);
      options.onProgress?.(`Applied ${migration.fileName}`);
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_NAME])
      .catch(() => undefined);
    client.release();
  }

  return { applied, skipped };
}

const HELP = `Usage: tsx src/cloud/migrate.ts [--dir <migrations-directory>]

Environment:
  MIGRATION_DATABASE_URL  PostgreSQL URL for the migration-owner role
  DATABASE_URL            Fallback used for local development
`;

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: false,
    strict: true
  });
  if (parsed.values.help === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const databaseUrl = env.MIGRATION_DATABASE_URL?.trim() || env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL for local development) is required");
  }

  const database = new Pool({
    connectionString: databaseUrl,
    application_name: "draftrelay-cloud-migrate",
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000
  });
  try {
    const result = await runMigrations(database, {
      directory: parsed.values.dir,
      onProgress: (message) => process.stdout.write(`${message}\n`)
    });
    process.stdout.write(
      `Cloud database is current (${result.applied.length} applied, ${result.skipped.length} unchanged).\n`
    );
    return 0;
  } finally {
    await database.end();
  }
}

const invokedFile = path.basename(process.argv[1] ?? "");
if (invokedFile === "migrate.js" || invokedFile === "migrate.ts") {
  void main().catch((error: unknown) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export const migrationInternals = {
  ADVISORY_LOCK_NAME,
  MIGRATION_FILE_PATTERN,
  checksum
};
