import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CliIo } from "./common.js";
import { CLI_VERSION, runCli } from "./index.js";

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

describe("DraftRelay CLI parsing", () => {
  it("prints help and version without side effects", async () => {
    const help = capture();
    expect(await runCli([], help.io)).toBe(0);
    expect(help.stdout.join("")).toContain("draftrelay <command>");

    const version = capture();
    expect(await runCli(["--version"], version.io)).toBe(0);
    expect(version.stdout.join("").trim()).toBe(CLI_VERSION);
  });

  it("supports a setup dry run with no selected clients", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cutline-cli-"));
    const result = capture();
    expect(
      await runCli(["setup", "--dry-run", "--client", "none", "--data-dir", root], result.io)
    ).toBe(0);
    expect(result.stdout.join("")).toContain(`Would use data directory: ${root}`);
    expect(result.stderr.join("")).toContain("No supported MCP clients");
  });

  it("returns a concise error for unknown commands and invalid options", async () => {
    const unknown = capture();
    expect(await runCli(["wat"], unknown.io)).toBe(1);
    expect(unknown.stderr.join("")).toContain("Unknown command");

    const invalid = capture();
    expect(await runCli(["doctor", "--port", "70000"], invalid.io)).toBe(1);
    expect(invalid.stderr.join("")).toContain("--port");
  });
});
