interface ItemCursor {
  version: 1;
  updatedAt: string;
  createdAt: string;
  id: string;
}

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function encodeItemCursor(value: Omit<ItemCursor, "version">): string {
  return Buffer.from(JSON.stringify({ version: 1, ...value } satisfies ItemCursor), "utf8")
    .toString("base64url");
}

export function decodeItemCursor(value: string): ItemCursor | undefined {
  if (value.length < 8 || value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ItemCursor>;
    if (
      parsed.version !== 1 ||
      !validIsoTimestamp(parsed.updatedAt) ||
      !validIsoTimestamp(parsed.createdAt) ||
      typeof parsed.id !== "string" ||
      !ITEM_ID_PATTERN.test(parsed.id)
    ) return undefined;
    return parsed as ItemCursor;
  } catch {
    return undefined;
  }
}
