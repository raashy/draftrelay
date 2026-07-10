import { describe, expect, it } from "vitest";

import { runtimeRoleInternals } from "./grant-runtime-role.js";

describe("runtime role grant validation", () => {
  it.each(["draftrelay_app", "app2", "_runtime"])("accepts %s", (role) => {
    expect(runtimeRoleInternals.ROLE_PATTERN.test(role)).toBe(true);
  });

  it.each(["DraftRelay", "app-role", "app; DROP ROLE x", "", "9app"])(
    "rejects %s",
    (role) => {
      expect(runtimeRoleInternals.ROLE_PATTERN.test(role)).toBe(false);
    }
  );

  it("quotes identifiers defensively", () => {
    expect(runtimeRoleInternals.quoteIdentifier('role"name')).toBe('"role""name"');
  });
});
