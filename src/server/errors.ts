import type { ScannedSecretFinding } from "./security.js";

export class ItemNotFoundError extends Error {
  readonly itemId: string;

  constructor(itemId: string) {
    super(`Item ${itemId} was not found`);
    this.name = "ItemNotFoundError";
    this.itemId = itemId;
  }
}

export class StaleRevisionError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`The item has changed; current revision is ${currentRevision}`);
    this.name = "StaleRevisionError";
    this.currentRevision = currentRevision;
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key was already used for a different operation or item");
    this.name = "IdempotencyConflictError";
  }
}

export class SecretBlockedError extends Error {
  readonly findings: Array<Pick<
    ScannedSecretFinding,
    "ruleId" | "label" | "severity" | "lineNumber" | "redactedPreview"
  >>;

  constructor(findings: ScannedSecretFinding[]) {
    super("The output contains content blocked by the project secret policy");
    this.name = "SecretBlockedError";
    this.findings = findings.map(
      ({ ruleId, label, severity, lineNumber, redactedPreview }) => ({
        ruleId,
        label,
        severity,
        lineNumber,
        redactedPreview
      })
    );
  }
}

export class CopyBlockedError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super("Copy is blocked by the current project policy");
    this.name = "CopyBlockedError";
    this.reasons = reasons;
  }
}

export class FindingNotFoundError extends Error {
  constructor(findingId: string) {
    super(`Finding ${findingId} was not found`);
    this.name = "FindingNotFoundError";
  }
}

export class SecretPatternLimitError extends Error {
  constructor(readonly limit: number) {
    super(`A project can have at most ${limit} custom secret patterns`);
    this.name = "SecretPatternLimitError";
  }
}
