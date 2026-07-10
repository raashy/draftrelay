import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CutlinePaths {
  configDir: string;
  dataDir: string;
  stateDir: string;
  backupsDir: string;
  databasePath: string;
  configPath: string;
  installStatePath: string;
}

export interface PathOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
}

function resolved(value: string, cwd: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export function getCutlinePaths(options: PathOptions = {}): CutlinePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const portableHome = env.CUTLINE_HOME?.trim();

  let configDir: string;
  let dataDir: string;
  let stateDir: string;

  if (portableHome !== undefined && portableHome !== "") {
    const base = resolved(portableHome, cwd);
    configDir = path.join(base, "config");
    dataDir = path.join(base, "data");
    stateDir = path.join(base, "state");
  } else if (platform === "darwin") {
    const applicationSupport = path.join(homeDir, "Library", "Application Support", "Cutline");
    configDir = applicationSupport;
    dataDir = applicationSupport;
    stateDir = path.join(applicationSupport, "state");
  } else if (platform === "win32") {
    configDir = path.join(env.APPDATA?.trim() || path.join(homeDir, "AppData", "Roaming"), "Cutline");
    dataDir = path.join(
      env.LOCALAPPDATA?.trim() || path.join(homeDir, "AppData", "Local"),
      "Cutline"
    );
    stateDir = path.join(dataDir, "state");
  } else {
    configDir = path.join(env.XDG_CONFIG_HOME?.trim() || path.join(homeDir, ".config"), "cutline");
    dataDir = path.join(
      env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share"),
      "cutline"
    );
    stateDir = path.join(
      env.XDG_STATE_HOME?.trim() || path.join(homeDir, ".local", "state"),
      "cutline"
    );
  }

  const explicitDataDir = options.dataDir ?? env.CUTLINE_DATA_DIR?.trim();
  if (explicitDataDir !== undefined && explicitDataDir !== "") {
    dataDir = resolved(explicitDataDir, cwd);
  }

  return {
    configDir,
    dataDir,
    stateDir,
    backupsDir: path.join(dataDir, "backups"),
    databasePath: path.join(dataDir, "cutline.sqlite3"),
    configPath: path.join(configDir, "config.json"),
    installStatePath: path.join(stateDir, "install.json")
  };
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
  }
}

export function ensureCutlinePaths(paths: CutlinePaths, includeBackups = false): void {
  const directories = new Set([paths.configDir, paths.dataDir, paths.stateDir]);
  if (includeBackups) {
    directories.add(paths.backupsDir);
  }
  for (const directory of directories) {
    secureDirectory(directory);
  }
}

export function writePrivateFileAtomic(filePath: string, contents: string): void {
  secureDirectory(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      chmodSync(temporaryPath, 0o600);
    }
    if (process.platform === "win32" && existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) {
      rmSync(temporaryPath, { force: true });
    }
  }
}

export function chmodPrivate(filePath: string): void {
  if (process.platform !== "win32" && existsSync(filePath)) {
    chmodSync(filePath, 0o600);
  }
}

export const pathInternals = {
  resolved
};
