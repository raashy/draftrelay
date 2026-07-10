import { describe, expect, it } from "vitest";

import { nextRovingTabIndex } from "./roving-tabs.js";

describe("nextRovingTabIndex", () => {
  it("moves in both visual directions and wraps", () => {
    expect(nextRovingTabIndex("ArrowRight", 1, 4)).toBe(2);
    expect(nextRovingTabIndex("ArrowDown", 3, 4)).toBe(0);
    expect(nextRovingTabIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextRovingTabIndex("ArrowUp", 2, 4)).toBe(1);
  });

  it("supports Home and End without intercepting unrelated keys", () => {
    expect(nextRovingTabIndex("Home", 2, 4)).toBe(0);
    expect(nextRovingTabIndex("End", 1, 4)).toBe(3);
    expect(nextRovingTabIndex("Enter", 1, 4)).toBeNull();
    expect(nextRovingTabIndex("ArrowRight", -1, 4)).toBeNull();
    expect(nextRovingTabIndex("ArrowRight", 0, 0)).toBeNull();
  });
});
