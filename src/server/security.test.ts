import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_SECRET_PATTERNS,
  MAX_MATCHES_PER_SECRET_RULE,
  scanSecrets,
  securityInternals
} from "./security.js";

describe("secret scanner", () => {
  it("blocks high-confidence credentials without returning their value", () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    const findings = scanSecrets(`Use ${secret} here`, "block_high");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "openai_key",
      severity: "high",
      action: "block",
      lineNumber: 1,
      redactedPreview: "OpenAI API key detected on line 1"
    });
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it("warns on medium-confidence assignments and supports safe project globs", () => {
    const builtIn = scanSecrets("api_key=abcdefghijklmnop", "block_high");
    expect(builtIn[0]).toMatchObject({ severity: "medium", action: "warn" });

    const custom = scanSecrets("internal-prod-12345", "block_high", [
      {
        id: "custom",
        label: "Internal credential",
        patternKind: "glob",
        pattern: "internal-prod-*",
        severity: "critical"
      }
    ]);
    expect(custom[0]).toMatchObject({
      ruleId: "project:custom",
      action: "block",
      redactedPreview: "Internal credential detected on line 1"
    });
  });

  it("calculates line numbers and can disable scanning", () => {
    const findings = scanSecrets(
      "safe\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "warn"
    );
    expect(findings[0]?.lineNumber).toBe(2);
    expect(findings[0]?.action).toBe("warn");
    expect(scanSecrets("sk-proj-abcdefghijklmnopqrstuvwxyz", "off")).toEqual([]);
    expect(securityInternals.lineAt("a\nb\nc", 4)).toBe(3);
  });

  it("matches adversarial globs with bounded work and caps aggregate custom rules", () => {
    const adversarial = "*a".repeat(20) + "*b";
    const patterns = Array.from({ length: MAX_CUSTOM_SECRET_PATTERNS }, (_, index) => ({
      id: `bounded-${index}`,
      label: "Bounded wildcard",
      patternKind: "glob" as const,
      pattern: adversarial,
      severity: "low" as const
    }));
    patterns.push({
      id: "over-limit",
      label: "Must not run",
      patternKind: "glob",
      pattern: "needle-*",
      severity: "low"
    });

    const startedAt = performance.now();
    const findings = scanSecrets(`${"a".repeat(12_000)}needle-value`, "warn", patterns);
    const elapsed = performance.now() - startedAt;

    expect(findings).toEqual([]);
    expect(elapsed).toBeLessThan(250);
  });

  it("keeps wildcard segments ordered and reports the matched line", () => {
    const findings = scanSecrets("safe\nPREFIX-one-middle-two", "warn", [{
      id: "ordered",
      label: "Ordered wildcard",
      patternKind: "glob",
      pattern: "prefix-*two",
      severity: "medium"
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      startOffset: 5,
      endOffset: 26,
      lineNumber: 2,
      redactedPreview: "Ordered wildcard detected on line 2"
    });
  });

  it("bounds repeated matches without skipping later custom rules", () => {
    const findings = scanSecrets(`${"aaa ".repeat(5_000)}needle-value`, "block_high", [
      {
        id: "repeated",
        label: "Repeated",
        patternKind: "literal",
        pattern: "aaa",
        severity: "low"
      },
      {
        id: "later",
        label: "Later",
        patternKind: "glob",
        pattern: "needle-*",
        severity: "critical"
      }
    ]);
    expect(findings.filter((finding) => finding.ruleId === "project:repeated"))
      .toHaveLength(MAX_MATCHES_PER_SECRET_RULE);
    expect(findings).toContainEqual(expect.objectContaining({
      ruleId: "project:later",
      action: "block"
    }));
  });
});
