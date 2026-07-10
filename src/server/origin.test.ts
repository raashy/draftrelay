import { describe, expect, it } from "vitest";

import { originInternals } from "./origin.js";

describe("supplied Origin validation", () => {
  it("accepts only canonical HTTP origins", () => {
    expect(originInternals.exactOrigin("https://relay.example.com")).toBe(
      "https://relay.example.com"
    );
    expect(originInternals.exactOrigin("https://relay.example.com/path")).toBeUndefined();
    expect(originInternals.exactOrigin("https://user:secret@relay.example.com")).toBeUndefined();
    expect(originInternals.exactOrigin("null")).toBeUndefined();
  });
});
