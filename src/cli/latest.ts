import type { Destination } from "../shared/items.js";
import { COPY_DESTINATIONS, type CopyDestination } from "./format.js";
import { itemQuery, line, openStore, type CliIo, type QueryValues } from "./common.js";
import { getCutlinePaths } from "./paths.js";
import { copyToClipboard } from "./platform.js";

export interface LatestValues extends QueryValues {
  dataDir?: string;
  json?: boolean;
  copy?: string;
}

function parseDestination(value: string): CopyDestination {
  if (!(COPY_DESTINATIONS as readonly string[]).includes(value)) {
    throw new Error(`--copy must be one of: ${COPY_DESTINATIONS.join(", ")}`);
  }
  return value as CopyDestination;
}

export async function runLatest(
  values: LatestValues,
  io: CliIo,
  copy: (text: string) => Promise<void> = copyToClipboard
): Promise<number> {
  if (values.json === true && values.copy !== undefined) {
    throw new Error("--json and --copy cannot be used together");
  }
  const paths = getCutlinePaths({ dataDir: values.dataDir });
  const store = openStore(paths);
  try {
    const item = store.list(itemQuery(values, "false")).items[0];
    if (item === undefined) {
      throw new Error("No matching DraftRelay items were found");
    }

    if (values.json === true) {
      io.stdout(`${JSON.stringify(item, null, 2)}\n`);
      return 0;
    }

    if (values.copy === undefined) {
      io.stdout(line(item.contentMarkdown));
      return 0;
    }

    const destination = parseDestination(values.copy) as Destination;
    const representation = store.getRepresentation(item.id, destination);
    if (!representation.copyAllowed) {
      throw new Error(`Copy blocked: ${representation.blockReasons.join(" ")}`);
    }
    const copyAsMarkdown = destination === "markdown" || destination === "github" || destination === "slack";
    const output = copyAsMarkdown
      ? (representation.markdownText ?? representation.plainText)
      : representation.plainText;
    io.stdout(line(output));
    for (const warning of representation.warnings) {
      io.stderr(line(`Warning: ${warning}`));
    }
    await copy(output);
    store.recordCopy(item.id, {
      representationId: representation.id,
      destination,
      format: copyAsMarkdown ? "markdown" : "plain",
      actorLabel: "cutline-cli"
    });
    io.stderr(line(`Copied “${item.title}” for ${destination}.`));
    return 0;
  } finally {
    store.close();
  }
}

export const latestInternals = {
  parseDestination
};
