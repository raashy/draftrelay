const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

export function safeReturnTo(
  value: string | null,
  fallback = "/app",
  origin = globalThis.location?.origin
): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  if (CONTROL_CHARACTER.test(value) || origin === undefined) return fallback;

  try {
    const base = new URL(origin);
    const target = new URL(value, base);
    if (target.origin !== base.origin) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}
