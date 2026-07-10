import { describe, expect, it } from "vitest";

import { requestFingerprint } from "./idempotency.js";

describe("request fingerprints", () => {
  it("is stable across object key order and distinguishes scope and payload", () => {
    expect(requestFingerprint("create", { b: 2, a: { y: true, x: "value" } }))
      .toBe(requestFingerprint("create", { a: { x: "value", y: true }, b: 2 }));
    expect(requestFingerprint("create", { value: "one" }))
      .not.toBe(requestFingerprint("create", { value: "two" }));
    expect(requestFingerprint("create", { value: "one" }))
      .not.toBe(requestFingerprint("revision", { value: "one" }));
  });
});
