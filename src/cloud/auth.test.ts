import { describe, expect, it } from "vitest";

import {
  addOfflineAccessForRefreshRegistration,
  shouldUseSecureCookies
} from "./auth.js";

describe("OAuth dynamic registration compatibility", () => {
  it("adds offline_access when an explicit-scope public client requests refresh tokens", () => {
    expect(addOfflineAccessForRefreshRegistration({
      scope: "outputs:read outputs:write outputs:use",
      grant_types: ["authorization_code", "refresh_token"]
    })).toEqual({
      scope: "outputs:read outputs:write outputs:use offline_access",
      grant_types: ["authorization_code", "refresh_token"]
    });
  });

  it("does not broaden clients that cannot use the refresh-token grant", () => {
    const registration = {
      scope: "outputs:read outputs:write outputs:use",
      grant_types: ["authorization_code"]
    };
    expect(addOfflineAccessForRefreshRegistration(registration)).toBe(registration);
  });

  it("keeps an existing offline_access scope stable", () => {
    const registration = {
      scope: "profile offline_access outputs:read",
      grant_types: ["authorization_code", "refresh_token"]
    };
    expect(addOfflineAccessForRefreshRegistration(registration)).toBe(registration);
  });
});

describe("hosted auth cookies", () => {
  it("uses secure cookies for every HTTPS deployment, including previews", () => {
    expect(shouldUseSecureCookies("https://draftrelay.onrender.com")).toBe(true);
    expect(shouldUseSecureCookies("http://localhost:3941")).toBe(false);
  });
});
