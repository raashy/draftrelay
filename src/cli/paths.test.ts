import { chmodSync, mkdtempSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureCutlinePaths, getCutlinePaths, writePrivateFileAtomic } from "./paths.js";

describe("Cutline paths", () => {
  it("uses native per-user directories", () => {
    const mac = getCutlinePaths({ platform: "darwin", homeDir: "/Users/ana", env: {} });
    expect(mac.databasePath).toBe(
      path.join("/Users/ana", "Library", "Application Support", "Cutline", "cutline.sqlite3")
    );

    const linux = getCutlinePaths({
      platform: "linux",
      homeDir: "/home/ana",
      env: {
        XDG_CONFIG_HOME: "/cfg",
        XDG_DATA_HOME: "/shared",
        XDG_STATE_HOME: "/state"
      }
    });
    expect(linux.configPath).toBe(path.join("/cfg", "cutline", "config.json"));
    expect(linux.databasePath).toBe(path.join("/shared", "cutline", "cutline.sqlite3"));
    expect(linux.installStatePath).toBe(path.join("/state", "cutline", "install.json"));
  });

  it("supports a portable home and an explicit data directory", () => {
    const paths = getCutlinePaths({
      platform: "linux",
      homeDir: "/home/ana",
      cwd: "/work",
      env: { CUTLINE_HOME: "portable" },
      dataDir: "records"
    });
    expect(paths.configDir).toBe(path.resolve("/work", "portable", "config"));
    expect(paths.dataDir).toBe(path.resolve("/work", "records"));
    expect(paths.stateDir).toBe(path.resolve("/work", "portable", "state"));
  });

  it("creates private directories and atomically writes private files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cutline-paths-"));
    chmodSync(root, 0o700);
    const paths = getCutlinePaths({ env: { CUTLINE_HOME: root }, homeDir: root });
    ensureCutlinePaths(paths, true);
    writePrivateFileAtomic(paths.configPath, "{}\n");

    if (process.platform !== "win32") {
      expect(statSync(paths.dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
    }
  });
});
