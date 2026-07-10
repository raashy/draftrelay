import { describe, expect, it } from "vitest";

import { getRecipe, listRecipes, renderRecipePayload } from "./recipes.js";

describe("typed output recipes", () => {
  it("publishes discoverable field and destination contracts", () => {
    const recipes = listRecipes();
    expect(recipes).toHaveLength(11);
    expect(getRecipe("client_email")).toMatchObject({
      defaultDestination: "email",
      destinations: ["email", "plain", "markdown"]
    });
    expect(getRecipe("github_pr").fields.map((field) => field.name)).toEqual([
      "summaryMarkdown",
      "changes",
      "testPlan",
      "risks"
    ]);
  });

  it("renders stable canonical Markdown from typed payloads", () => {
    expect(
      renderRecipePayload("github_pr", {
        summaryMarkdown: "Ships the outbox.",
        changes: ["Adds revisions", "Adds Slack copy"],
        testPlan: ["Run unit tests"],
        risks: "Migration is additive."
      })
    ).toEqual({
      kind: "summary",
      payload: {
        summaryMarkdown: "Ships the outbox.",
        changes: ["Adds revisions", "Adds Slack copy"],
        testPlan: ["Run unit tests"],
        risks: "Migration is additive."
      },
      contentMarkdown:
        "## Summary\n\nShips the outbox.\n\n## Changes\n\n- Adds revisions\n- Adds Slack copy\n\n## Test plan\n\n- [ ] Run unit tests\n\n## Risks\n\nMigration is additive."
    });
  });

  it("rejects missing and unknown recipe fields", () => {
    expect(() =>
      renderRecipePayload("client_email", { bodyMarkdown: "Missing subject" })
    ).toThrow();
    expect(() =>
      renderRecipePayload("decision", {
        decision: "Ship",
        rationale: "Ready",
        unexpected: true
      })
    ).toThrow();
  });
});
