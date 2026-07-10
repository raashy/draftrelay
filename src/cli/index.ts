#!/usr/bin/env node

import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { runBackup } from "./backup.js";
import { line, processIo, type CliIo } from "./common.js";
import { runDoctor } from "./doctor.js";
import { runExport } from "./export.js";
import { runLatest } from "./latest.js";
import { runMcp } from "./mcp.js";
import { runOpen, runServe } from "./serve.js";
import { runSetup } from "./setup.js";
import { runUninstall } from "./uninstall.js";

export const CLI_VERSION = "0.3.0";

const HELP = `DraftRelay — the review inbox for AI agent output

Usage: draftrelay <command> [options]

Commands:
  setup       Create local directories and configure MCP clients
  mcp         Run the stdio MCP server
  serve       Run the browser UI and HTTP MCP server
  open        Open DraftRelay, starting a foreground server if needed
  doctor      Check local storage, assets, clients, and server health
  latest      Print or copy the latest matching artifact
  export      Export artifacts as JSON or Markdown
  backup      Create a consistent SQLite backup
  uninstall   Remove managed MCP registrations; preserve data by default

Run draftrelay <command> --help for command-specific options.
The former cutline executable remains available as a compatibility alias.
`;

const COMMAND_HELP: Record<string, string> = {
  setup: `Usage: draftrelay setup [--client claude|codex|all|none] [--dry-run] [--force]

Options:
  --data-dir <path>       Override the per-user data directory
  --client <name>         Configure a client; repeatable (defaults to detected clients)
  --migrate-from <file>   Safely import an existing SQLite database
  --dry-run               Print actions without changing files or client configuration
  --force                 Replace existing MCP entries named draftrelay
`,
  mcp: `Usage: draftrelay mcp [--data-dir <path>] [--client <name>]

Runs a stdio MCP server. Standard output is reserved exclusively for MCP messages.
`,
  serve: `Usage: draftrelay serve [--open] [--port 3939] [--data-dir <path>]

Options:
  --host <loopback>       Defaults to 127.0.0.1; non-loopback hosts are rejected
  --port <number>         Defaults to 3939
  --static-dir <path>     Override packaged browser assets
  --open                  Open the UI after listening
`,
  open: `Usage: draftrelay open [item-id] [--no-start] [--port 3939]

Opens a running DraftRelay UI. If it is not running, starts a foreground server unless
--no-start is supplied.
`,
  doctor: `Usage: draftrelay doctor [--json] [--data-dir <path>] [--port 3939]
`,
  latest: `Usage: draftrelay latest [filters] [--copy <destination>] [--json]

Filters: --project, --kind, --tag, --query, --archived false|true|all
Copy destinations: plain, markdown, github, slack, email
`,
  export: `Usage: draftrelay export [--format json|markdown] [--output <file>|-] [--force]

Filters: --project, --kind, --tag, --query, --archived false|true|all
`,
  backup: `Usage: draftrelay backup [--output <file>] [--data-dir <path>]
`,
  uninstall: `Usage: draftrelay uninstall [--client <name>] [--dry-run] [--purge-data --yes]

Local data is preserved by default. Only integrations recorded by setup are removed
unless --force is supplied.
`
};

const helpOption = { type: "boolean" as const, short: "h" };
const dataDirOption = { type: "string" as const };

function parsed<T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  allowPositionals = false
) {
  const optionsWithHelp = { ...options, help: helpOption } as T & { help: typeof helpOption };
  return parseArgs({ args, options: optionsWithHelp, allowPositionals, strict: true });
}

function ensureNoPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments: ${positionals.join(" ")}`);
  }
}

export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    const requested = command === "help" ? args[0] : undefined;
    io.stdout(requested !== undefined && COMMAND_HELP[requested] !== undefined ? COMMAND_HELP[requested] : HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(line(CLI_VERSION));
    return 0;
  }

  try {
    switch (command) {
      case "setup": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          client: { type: "string", multiple: true },
          "dry-run": { type: "boolean" },
          force: { type: "boolean" },
          "migrate-from": { type: "string" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.setup);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runSetup(
          {
            dataDir: result.values["data-dir"],
            clients: result.values.client,
            dryRun: result.values["dry-run"],
            force: result.values.force,
            migrateFrom: result.values["migrate-from"]
          },
          io
        );
      }
      case "mcp": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          host: { type: "string" },
          port: { type: "string" },
          client: { type: "string" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.mcp);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runMcp(
          {
            dataDir: result.values["data-dir"],
            host: result.values.host,
            port: result.values.port,
            client: result.values.client
          },
          io
        );
      }
      case "serve": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          host: { type: "string" },
          port: { type: "string" },
          "static-dir": { type: "string" },
          open: { type: "boolean" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.serve);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runServe(
          {
            dataDir: result.values["data-dir"],
            host: result.values.host,
            port: result.values.port,
            staticDir: result.values["static-dir"],
            open: result.values.open
          },
          io
        );
      }
      case "open": {
        const result = parsed(
          args,
          {
            "data-dir": dataDirOption,
            host: { type: "string" },
            port: { type: "string" },
            "static-dir": { type: "string" },
            "no-start": { type: "boolean" }
          },
          true
        );
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.open);
          return 0;
        }
        if (result.positionals.length > 1) {
          throw new Error("open accepts at most one item ID");
        }
        return await runOpen(
          {
            itemId: result.positionals[0],
            dataDir: result.values["data-dir"],
            host: result.values.host,
            port: result.values.port,
            staticDir: result.values["static-dir"],
            noStart: result.values["no-start"]
          },
          io
        );
      }
      case "doctor": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          host: { type: "string" },
          port: { type: "string" },
          "static-dir": { type: "string" },
          json: { type: "boolean" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.doctor);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runDoctor(
          {
            dataDir: result.values["data-dir"],
            host: result.values.host,
            port: result.values.port,
            staticDir: result.values["static-dir"],
            json: result.values.json
          },
          io
        );
      }
      case "latest": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          project: { type: "string" },
          kind: { type: "string" },
          tag: { type: "string" },
          query: { type: "string", short: "q" },
          archived: { type: "string" },
          copy: { type: "string" },
          json: { type: "boolean" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.latest);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runLatest(
          {
            dataDir: result.values["data-dir"],
            project: result.values.project,
            kind: result.values.kind,
            tag: result.values.tag,
            query: result.values.query,
            archived: result.values.archived,
            copy: result.values.copy,
            json: result.values.json
          },
          io
        );
      }
      case "export": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          project: { type: "string" },
          kind: { type: "string" },
          tag: { type: "string" },
          query: { type: "string", short: "q" },
          archived: { type: "string" },
          format: { type: "string" },
          output: { type: "string", short: "o" },
          force: { type: "boolean" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.export);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runExport(
          {
            dataDir: result.values["data-dir"],
            project: result.values.project,
            kind: result.values.kind,
            tag: result.values.tag,
            query: result.values.query,
            archived: result.values.archived,
            format: result.values.format,
            output: result.values.output,
            force: result.values.force
          },
          io
        );
      }
      case "backup": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          output: { type: "string", short: "o" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.backup);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runBackup(
          { dataDir: result.values["data-dir"], output: result.values.output },
          io
        );
      }
      case "uninstall": {
        const result = parsed(args, {
          "data-dir": dataDirOption,
          client: { type: "string", multiple: true },
          "dry-run": { type: "boolean" },
          force: { type: "boolean" },
          "purge-data": { type: "boolean" },
          yes: { type: "boolean" }
        });
        if (result.values.help === true) {
          io.stdout(COMMAND_HELP.uninstall);
          return 0;
        }
        ensureNoPositionals(result.positionals, command);
        return await runUninstall(
          {
            dataDir: result.values["data-dir"],
            clients: result.values.client,
            dryRun: result.values["dry-run"],
            force: result.values.force,
            purgeData: result.values["purge-data"],
            yes: result.values.yes
          },
          io
        );
      }
      default:
        throw new Error(`Unknown command ${JSON.stringify(command)}. Run draftrelay --help.`);
    }
  } catch (error: unknown) {
    io.stderr(line(`Error: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(realpathSync(path.resolve(invokedPath))).href === import.meta.url
) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
