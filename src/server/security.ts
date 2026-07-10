import { createHash } from "node:crypto";

import type {
  ProjectSecretMode,
  SecretSeverity
} from "../shared/items.js";

export interface SecretPattern {
  id: string;
  label: string;
  patternKind: "literal" | "glob";
  pattern: string;
  severity: SecretSeverity;
}

export interface ScannedSecretFinding {
  ruleId: string;
  label: string;
  severity: SecretSeverity;
  action: "warn" | "block";
  startOffset: number;
  endOffset: number;
  lineNumber: number;
  fingerprint: string;
  redactedPreview: string;
}

export const MAX_CUSTOM_SECRET_PATTERNS = 50;
export const MAX_MATCHES_PER_SECRET_RULE = 20;

interface BuiltinRule {
  id: string;
  label: string;
  severity: SecretSeverity;
  expression: RegExp;
}

const BUILTIN_RULES: BuiltinRule[] = [
  {
    id: "private_key",
    label: "Private key",
    severity: "critical",
    expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g
  },
  {
    id: "aws_access_key",
    label: "AWS access key",
    severity: "high",
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
  },
  {
    id: "github_token",
    label: "GitHub token",
    severity: "high",
    expression: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g
  },
  {
    id: "openai_key",
    label: "OpenAI API key",
    severity: "high",
    expression: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g
  },
  {
    id: "slack_token",
    label: "Slack token",
    severity: "high",
    expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
  },
  {
    id: "bearer_token",
    label: "Bearer token",
    severity: "high",
    expression: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi
  },
  {
    id: "jwt",
    label: "JSON Web Token",
    severity: "high",
    expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  {
    id: "credential_url",
    label: "Credentials in URL",
    severity: "high",
    expression: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi
  },
  {
    id: "generic_secret_assignment",
    label: "Possible assigned secret",
    severity: "medium",
    expression:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+~=-]{16,}/gi
  }
];

function actionFor(mode: ProjectSecretMode, severity: SecretSeverity): "warn" | "block" {
  if (mode === "block_all") {
    return "block";
  }
  if (mode === "block_high" && (severity === "high" || severity === "critical")) {
    return "block";
  }
  return "warn";
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function fingerprint(ruleId: string, match: string): string {
  return createHash("sha256").update(ruleId).update("\0").update(match).digest("hex");
}

interface SecretMatch {
  index: number;
  value: string;
}

function literalMatches(
  text: string,
  literal: string,
  limit = MAX_MATCHES_PER_SECRET_RULE
): SecretMatch[] {
  const source = text.toLowerCase();
  const needle = literal.toLowerCase();
  if (needle.length === 0) return [];
  const matches: SecretMatch[] = [];
  let from = 0;
  while (from <= source.length - needle.length && matches.length < limit) {
    const index = source.indexOf(needle, from);
    if (index === -1) break;
    matches.push({ index, value: text.slice(index, index + literal.length) });
    from = index + Math.max(1, literal.length);
  }
  return matches;
}

/**
 * Finds wildcard matches without constructing a regular expression. Splitting
 * on `*` and searching the literal segments in order keeps work bounded by the
 * input and pattern sizes instead of exposing V8's backtracking engine to a
 * tenant-controlled expression.
 */
function globMatches(
  text: string,
  pattern: string,
  limit = MAX_MATCHES_PER_SECRET_RULE
): SecretMatch[] {
  const segments = pattern
    .split("*")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  if (segments.length === 0) return [];

  const source = text.toLowerCase();
  const matches: SecretMatch[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length && matches.length < limit) {
    const start = source.indexOf(segments[0]!, searchFrom);
    if (start === -1) break;
    let end = start + segments[0]!.length;
    let complete = true;
    for (const segment of segments.slice(1)) {
      const next = source.indexOf(segment, end);
      if (next === -1) {
        complete = false;
        break;
      }
      end = next + segment.length;
    }
    if (!complete) break;
    matches.push({ index: start, value: text.slice(start, end) });
    searchFrom = Math.max(end, start + 1);
  }
  return matches;
}

export function scanSecrets(
  text: string,
  mode: ProjectSecretMode,
  patterns: SecretPattern[] = []
): ScannedSecretFinding[] {
  if (mode === "off") {
    return [];
  }

  const findings: ScannedSecretFinding[] = [];
  for (const rule of BUILTIN_RULES) {
    const expression = new RegExp(rule.expression.source, rule.expression.flags);
    let matchCount = 0;
    for (const match of text.matchAll(expression)) {
      if (match.index === undefined || match[0].length === 0) {
        continue;
      }
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        action: actionFor(mode, rule.severity),
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        lineNumber: lineAt(text, match.index),
        fingerprint: fingerprint(rule.id, match[0]),
        redactedPreview: `${rule.label} detected on line ${lineAt(text, match.index)}`
      });
      matchCount += 1;
      if (matchCount >= MAX_MATCHES_PER_SECRET_RULE) break;
    }
  }

  for (const pattern of patterns.slice(0, MAX_CUSTOM_SECRET_PATTERNS)) {
    const ruleId = `project:${pattern.id}`;
    const matches = pattern.patternKind === "literal"
      ? literalMatches(text, pattern.pattern)
      : globMatches(text, pattern.pattern);
    for (const match of matches) {
      const lineNumber = lineAt(text, match.index);
      findings.push({
        ruleId,
        label: pattern.label,
        severity: pattern.severity,
        action: actionFor(mode, pattern.severity),
        startOffset: match.index,
        endOffset: match.index + match.value.length,
        lineNumber,
        fingerprint: fingerprint(ruleId, match.value),
        redactedPreview: `${pattern.label} detected on line ${lineNumber}`
      });
    }
  }

  return findings.sort(
    (left, right) => left.startOffset - right.startOffset || left.ruleId.localeCompare(right.ruleId)
  );
}

export const securityInternals = {
  BUILTIN_RULES,
  actionFor,
  globMatches,
  literalMatches,
  lineAt
};
