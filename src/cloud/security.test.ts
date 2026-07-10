import { describe, expect, it } from "vitest";

import { cloudSecurityInternals, trustedClientIpMiddleware } from "./security.js";

describe("cloud security helpers", () => {
  it("does not retain sensitive query strings in log paths", () => {
    expect(
      cloudSecurityInternals.pathWithoutQuery(
        "/api/auth/callback?code=secret-code&state=secret-state"
      )
    ).toBe("/api/auth/callback");
  });

  it("parses only a strict bearer authorization value", () => {
    expect(cloudSecurityInternals.bearerToken("Bearer abc.def-_123")).toBe("abc.def-_123");
    expect(cloudSecurityInternals.bearerToken("bearer abc")).toBeUndefined();
    expect(cloudSecurityInternals.bearerToken("Bearer abc def")).toBeUndefined();
  });

  it("normalizes OAuth scope claims without accepting non-string values", () => {
    expect(cloudSecurityInternals.payloadScopes({ scope: "outputs:use outputs:read" })).toEqual([
      "outputs:use",
      "outputs:read"
    ]);
    expect(cloudSecurityInternals.payloadScopes({ scope: ["outputs:use", 42] })).toEqual([
      "outputs:use"
    ]);
  });

  it("overwrites a spoofed private client-IP header with Express's trusted IP", () => {
    const request = {
      ip: "203.0.113.42",
      headers: { "x-draftrelay-client-ip": "198.51.100.9" }
    };
    let continued = false;
    trustedClientIpMiddleware()(
      request as never,
      {} as never,
      () => { continued = true; }
    );
    expect(request.headers["x-draftrelay-client-ip"]).toBe("203.0.113.42");
    expect(continued).toBe(true);
  });
});
