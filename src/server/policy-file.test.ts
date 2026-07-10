import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ItemStore } from "./store.js";
import {
  applyWorkspacePolicy,
  discoverWorkspacePolicy,
  readWorkspacePolicy
} from "./policy-file.js";

const stores: ItemStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

describe("workspace policy files", () => {
  it("discovers a policy up to the repository boundary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cutline-policy-"));
    mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const file = path.join(root, ".cutline.yml");
    writeFileSync(file, "version: 1\nproject: Demo\npolicy: {}\n");
    expect(discoverWorkspacePolicy({ searchFrom: nested, env: {} })).toBe(file);
  });

  it("validates policy values without executing YAML as code", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cutline-policy-"));
    const file = path.join(root, ".cutline.yml");
    writeFileSync(
      file,
      [
        "version: 1",
        "project: Launch",
        "policy:",
        "  defaultDestination: slack",
        "  allowedDestinations: [slack, plain]",
        "  secretMode: block_all",
        "  requireReviewBeforeCopy: true",
        "  retentionDays: 30",
        ""
      ].join("\n")
    );
    expect(readWorkspacePolicy(file)).toMatchObject({
      project: "Launch",
      policy: {
        defaultDestination: "slack",
        allowedDestinations: ["slack", "plain"],
        secretMode: "block_all",
        requireReviewBeforeCopy: true,
        retentionDays: 30
      }
    });
  });

  it("applies only declared fields over safe defaults", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cutline-policy-"));
    const file = path.join(root, "cutline.yml");
    writeFileSync(
      file,
      "version: 1\nproject: Client A\npolicy:\n  requireReviewBeforeCopy: true\n  copyBehavior: mark_done\n"
    );
    const store = new ItemStore({ databasePath: ":memory:" });
    stores.push(store);
    const loaded = applyWorkspacePolicy(store, { explicitPath: file, env: {} });
    expect(loaded?.path).toBe(file);
    expect(store.getProjectPolicy("Client A")).toMatchObject({
      requireReviewBeforeCopy: true,
      copyBehavior: "mark_done",
      secretMode: "block_high"
    });
  });

  it("fails closed for unknown policy fields", () => {
    const root = mkdtempSync(path.join(tmpdir(), "cutline-policy-"));
    const file = path.join(root, ".cutline.yml");
    writeFileSync(file, "version: 1\nproject: Demo\npolicy:\n  executablePlugin: ./run.js\n");
    expect(() => readWorkspacePolicy(file)).toThrow(/Invalid DraftRelay policy/);
  });
});
