import { constants, existsSync, accessSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

interface ProcessCommand {
  command: string;
  args: string[];
  input?: string;
}

function runProcess(specification: ProcessCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(specification.command, specification.args, {
      env: process.env,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    let settled = false;

    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${specification.command} exited with code ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`
          )
        );
      }
    });

    child.stdin.once("error", fail);
    child.stdin.end(specification.input ?? "");
  });
}

async function runFirstAvailable(commands: ProcessCommand[], purpose: string): Promise<void> {
  const errors: string[] = [];
  for (const command of commands) {
    try {
      await runProcess(command);
      return;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`${purpose} is unavailable. Tried: ${errors.join("; ")}`);
}

export interface PlatformOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function clipboardCommands(text: string, options: PlatformOptions = {}): ProcessCommand[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [], input: text }];
  }
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Set-Clipboard -Value ([Console]::In.ReadToEnd())"
        ],
        input: text
      }
    ];
  }

  const commands: ProcessCommand[] = [];
  if ((env.WAYLAND_DISPLAY?.trim() ?? "") !== "") {
    commands.push({ command: "wl-copy", args: [], input: text });
  }
  commands.push(
    { command: "xclip", args: ["-selection", "clipboard"], input: text },
    { command: "xsel", args: ["--clipboard", "--input"], input: text }
  );
  return commands;
}

export async function copyToClipboard(text: string, options: PlatformOptions = {}): Promise<void> {
  await runFirstAvailable(clipboardCommands(text, options), "Clipboard access");
}

export function browserCommands(url: string, options: PlatformOptions = {}): ProcessCommand[] {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return [{ command: "open", args: [url] }];
  }
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Start-Process -FilePath ([Console]::In.ReadToEnd())"
        ],
        input: url
      }
    ];
  }
  return [
    { command: "xdg-open", args: [url] },
    { command: "gio", args: ["open", url] }
  ];
}

export async function openInBrowser(urlValue: string, options: PlatformOptions = {}): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Refusing to open unsupported URL protocol ${url.protocol}`);
  }
  await runFirstAvailable(browserCommands(url.toString(), options), "Browser opening");
}

export function findExecutable(
  executable: string,
  options: PlatformOptions & { pathValue?: string } = {}
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pathValue = options.pathValue ?? env.PATH ?? "";
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
          .map((extension) => extension.toLowerCase())
      : [""];

  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const hasExtension = path.extname(executable) !== "";
    const candidates = hasExtension
      ? [path.join(directory, executable)]
      : extensions.map((extension) => path.join(directory, `${executable}${extension}`));
    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH for an executable candidate.
      }
    }
  }
  return undefined;
}

export const platformInternals = {
  runProcess
};
