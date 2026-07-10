import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrationInternals, readMigrationFiles } from "./migrate.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "draftrelay-migrations-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("cloud migration discovery", () => {
  it("sorts numbered SQL files and calculates stable checksums", async () => {
    const directory = temporaryDirectory();
    writeFileSync(path.join(directory, "0002_second.sql"), "SELECT 2;\n");
    writeFileSync(path.join(directory, "0001_first.sql"), "SELECT 1;\n");
    writeFileSync(path.join(directory, "README.md"), "ignored");

    const migrations = await readMigrationFiles(directory);

    expect(migrations.map((migration) => migration.fileName)).toEqual([
      "0001_first.sql",
      "0002_second.sql"
    ]);
    expect(migrations[0]?.checksum).toBe(
      migrationInternals.checksum("SELECT 1;\n")
    );
  });

  it("rejects malformed SQL filenames and duplicate versions", async () => {
    const invalidDirectory = temporaryDirectory();
    writeFileSync(path.join(invalidDirectory, "1_bad.sql"), "SELECT 1;");
    await expect(readMigrationFiles(invalidDirectory)).rejects.toThrow(
      "expected NNNN_lowercase_name.sql"
    );

    const duplicateDirectory = temporaryDirectory();
    writeFileSync(path.join(duplicateDirectory, "0001_first.sql"), "SELECT 1;");
    writeFileSync(path.join(duplicateDirectory, "0001_again.sql"), "SELECT 2;");
    await expect(readMigrationFiles(duplicateDirectory)).rejects.toThrow(
      "Duplicate migration version 0001"
    );

    const zeroDirectory = temporaryDirectory();
    writeFileSync(path.join(zeroDirectory, "0000_zero.sql"), "SELECT 0;");
    await expect(readMigrationFiles(zeroDirectory)).rejects.toThrow(
      "must use a version from 0001 to 9999"
    );
  });
});
