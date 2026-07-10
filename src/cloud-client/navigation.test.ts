import { describe, expect, it } from "vitest";

import { safeReturnTo } from "./navigation.js";

const ORIGIN = "https://app.draftrelay.example";

describe("cloud navigation", () => {
  it("keeps canonical same-origin paths", () => {
    expect(safeReturnTo("/app?welcome=1#setup", "/app", ORIGIN)).toBe(
      "/app?welcome=1#setup"
    );
    expect(safeReturnTo("/app/../account", "/app", ORIGIN)).toBe("/account");
  });

  it.each([
    "//attacker.example",
    "/\\attacker.example",
    "/\\\\attacker.example/path",
    "/\nattacker.example",
    "https://attacker.example/app",
    "account"
  ])("rejects an unsafe return target: %s", (target) => {
    expect(safeReturnTo(target, "/app", ORIGIN)).toBe("/app");
  });

  it("rejects the decoded form of an encoded backslash authority", () => {
    const target = new URLSearchParams("returnTo=%2F%5Cattacker.example").get("returnTo");
    expect(safeReturnTo(target, "/app", ORIGIN)).toBe("/app");
  });
});
