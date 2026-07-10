import { z } from "zod";

import {
  RECIPE_IDS,
  type Destination,
  type ItemKind,
  type RecipeId,
  type RecipeSummary
} from "../shared/items.js";

const shortText = z.string().trim().min(1).max(240);
const markdown = z.string().trim().min(1).max(12_000);
const stringList = z.array(z.string().trim().min(1).max(500)).max(20);

function cleanInline(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function section(title: string, body: string | string[] | undefined): string | null {
  if (body === undefined || (Array.isArray(body) && body.length === 0)) {
    return null;
  }
  const content = Array.isArray(body) ? body.map((value) => `- ${value}`).join("\n") : body;
  return `## ${title}\n\n${content}`;
}

function joinSections(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

interface RuntimeRecipe<T extends Record<string, unknown> = Record<string, unknown>>
  extends RecipeSummary {
  schema: z.ZodType<T>;
  render: (payload: T) => string;
}

const slackUpdateSchema = z
  .object({
    headline: shortText,
    updateMarkdown: markdown,
    bullets: stringList.optional(),
    blockers: stringList.optional(),
    ask: z.string().trim().min(1).max(2_000).optional()
  })
  .strict();

const clientEmailSchema = z
  .object({
    subject: shortText,
    greeting: z.string().trim().min(1).max(300).optional(),
    bodyMarkdown: markdown,
    callToAction: z.string().trim().min(1).max(2_000).optional(),
    signoff: z.string().trim().min(1).max(500).optional()
  })
  .strict();

const githubPrSchema = z
  .object({
    summaryMarkdown: markdown,
    changes: stringList,
    testPlan: stringList,
    risks: z.string().trim().min(1).max(3_000).optional()
  })
  .strict();

const incidentSummarySchema = z
  .object({
    status: shortText,
    impact: markdown,
    timelineMarkdown: z.string().trim().min(1).max(5_000).optional(),
    rootCause: z.string().trim().min(1).max(5_000).optional(),
    nextActions: stringList
  })
  .strict();

const decisionSchema = z
  .object({
    decision: markdown,
    rationale: markdown,
    consequences: stringList.optional()
  })
  .strict();

const commandSchema = z
  .object({
    command: z.string().trim().min(1).max(2_000),
    description: z.string().trim().min(1).max(500).optional(),
    cwd: z.string().trim().min(1).max(1_000).optional()
  })
  .strict();

const commandSetSchema = z
  .object({
    intro: z.string().trim().min(1).max(2_000).optional(),
    commands: z.array(commandSchema).min(1).max(20),
    warning: z.string().trim().min(1).max(2_000).optional()
  })
  .strict();

const genericSchema = z.object({ contentMarkdown: markdown }).strict();

const typedRecipes: RuntimeRecipe[] = [
  {
    id: "slack_update",
    name: "Slack update",
    description: "A concise team or client update ready to paste into Slack.",
    kind: "reply",
    defaultDestination: "slack",
    destinations: ["slack", "plain", "markdown"],
    fields: [
      { name: "headline", type: "text", required: true, description: "Short update headline" },
      { name: "updateMarkdown", type: "markdown", required: true, description: "Main update" },
      { name: "bullets", type: "string_list", required: false, description: "Key points" },
      { name: "blockers", type: "string_list", required: false, description: "Current blockers" },
      { name: "ask", type: "text", required: false, description: "Request or next step" }
    ],
    schema: slackUpdateSchema,
    render: (raw) => {
      const payload = slackUpdateSchema.parse(raw);
      return joinSections([
        `# ${cleanInline(payload.headline)}`,
        payload.updateMarkdown,
        section("Key points", payload.bullets),
        section("Blockers", payload.blockers),
        section("Ask", payload.ask)
      ]);
    }
  },
  {
    id: "client_email",
    name: "Client email",
    description: "A polished email with a subject and copy-ready body.",
    kind: "reply",
    defaultDestination: "email",
    destinations: ["email", "plain", "markdown"],
    fields: [
      { name: "subject", type: "text", required: true, description: "Email subject" },
      { name: "greeting", type: "text", required: false, description: "Opening greeting" },
      { name: "bodyMarkdown", type: "markdown", required: true, description: "Email body" },
      { name: "callToAction", type: "text", required: false, description: "Requested next step" },
      { name: "signoff", type: "text", required: false, description: "Closing signoff" }
    ],
    schema: clientEmailSchema,
    render: (raw) => {
      const payload = clientEmailSchema.parse(raw);
      return joinSections([
        payload.greeting,
        payload.bodyMarkdown,
        payload.callToAction,
        payload.signoff
      ]);
    }
  },
  {
    id: "github_pr",
    name: "GitHub pull request",
    description: "A GitHub-flavored pull request description with tests and risks.",
    kind: "summary",
    defaultDestination: "github",
    destinations: ["github", "markdown", "plain"],
    fields: [
      { name: "summaryMarkdown", type: "markdown", required: true, description: "PR summary" },
      { name: "changes", type: "string_list", required: true, description: "Changes made" },
      { name: "testPlan", type: "string_list", required: true, description: "Verification performed" },
      { name: "risks", type: "markdown", required: false, description: "Risks or caveats" }
    ],
    schema: githubPrSchema,
    render: (raw) => {
      const payload = githubPrSchema.parse(raw);
      return joinSections([
        section("Summary", payload.summaryMarkdown),
        section("Changes", payload.changes),
        section("Test plan", payload.testPlan.map((step) => `- [ ] ${step}`).join("\n")),
        section("Risks", payload.risks)
      ]);
    }
  },
  {
    id: "incident_summary",
    name: "Incident summary",
    description: "An operational incident report with impact, cause, and actions.",
    kind: "summary",
    defaultDestination: "markdown",
    destinations: ["markdown", "slack", "email", "plain"],
    fields: [
      { name: "status", type: "text", required: true, description: "Current incident status" },
      { name: "impact", type: "markdown", required: true, description: "User or business impact" },
      { name: "timelineMarkdown", type: "markdown", required: false, description: "Incident timeline" },
      { name: "rootCause", type: "markdown", required: false, description: "Known root cause" },
      { name: "nextActions", type: "string_list", required: true, description: "Follow-up actions" }
    ],
    schema: incidentSummarySchema,
    render: (raw) => {
      const payload = incidentSummarySchema.parse(raw);
      return joinSections([
        section("Status", payload.status),
        section("Impact", payload.impact),
        section("Timeline", payload.timelineMarkdown),
        section("Root cause", payload.rootCause),
        section("Next actions", payload.nextActions)
      ]);
    }
  },
  {
    id: "decision",
    name: "Decision record",
    description: "A compact decision, rationale, and consequences record.",
    kind: "note",
    defaultDestination: "markdown",
    destinations: ["markdown", "slack", "email", "plain"],
    fields: [
      { name: "decision", type: "markdown", required: true, description: "The decision" },
      { name: "rationale", type: "markdown", required: true, description: "Why it was made" },
      { name: "consequences", type: "string_list", required: false, description: "Expected effects" }
    ],
    schema: decisionSchema,
    render: (raw) => {
      const payload = decisionSchema.parse(raw);
      return joinSections([
        section("Decision", payload.decision),
        section("Rationale", payload.rationale),
        section("Consequences", payload.consequences)
      ]);
    }
  },
  {
    id: "command_set",
    name: "Command set",
    description: "A checked set of terminal commands with context and warnings.",
    kind: "snippet",
    defaultDestination: "markdown",
    destinations: ["markdown", "plain", "slack"],
    fields: [
      { name: "intro", type: "text", required: false, description: "What the commands do" },
      { name: "commands", type: "command_list", required: true, description: "Commands and descriptions" },
      { name: "warning", type: "text", required: false, description: "Safety warning" }
    ],
    schema: commandSetSchema,
    render: (raw) => {
      const payload = commandSetSchema.parse(raw);
      const commands = payload.commands
        .map((entry) =>
          joinSections([
            entry.description ? `**${cleanInline(entry.description)}**` : null,
            entry.cwd ? `Directory: \`${entry.cwd}\`` : null,
            `\`\`\`sh\n${entry.command}\n\`\`\``
          ])
        )
        .join("\n\n");
      return joinSections([payload.intro, commands, section("Warning", payload.warning)]);
    }
  }
];

const legacyKinds: ItemKind[] = ["reply", "summary", "action", "snippet", "note"];
const legacyRecipes: RuntimeRecipe[] = legacyKinds.map((kind) => ({
  id: `generic_${kind}` as RecipeId,
  name: `Generic ${kind}`,
  description: `Free-form Markdown ${kind} retained for compatibility.`,
  kind,
  defaultDestination: "markdown" as Destination,
  destinations: ["markdown", "plain", "slack", "email", "github"] as Destination[],
  fields: [
    {
      name: "contentMarkdown",
      type: "markdown" as const,
      required: true,
      description: "Copy-ready Markdown content"
    }
  ],
  schema: genericSchema,
  render: (raw) => genericSchema.parse(raw).contentMarkdown
}));

const recipeMap = new Map<RecipeId, RuntimeRecipe>(
  [...typedRecipes, ...legacyRecipes].map((recipe) => [recipe.id, recipe])
);

export function listRecipes(): RecipeSummary[] {
  return RECIPE_IDS.map((id) => {
    const recipe = recipeMap.get(id);
    if (recipe === undefined) {
      throw new Error(`Recipe ${id} is not registered`);
    }
    const { schema: _schema, render: _render, ...summary } = recipe;
    return summary;
  });
}

export function getRecipe(id: RecipeId): RecipeSummary {
  const recipe = recipeMap.get(id);
  if (recipe === undefined) {
    throw new Error(`Unknown recipe: ${id}`);
  }
  const { schema: _schema, render: _render, ...summary } = recipe;
  return summary;
}

export function recipeForLegacyKind(kind: ItemKind): RecipeId {
  return `generic_${kind}` as RecipeId;
}

export function kindForRecipe(id: RecipeId): ItemKind {
  return getRecipe(id).kind;
}

export function renderRecipePayload(
  id: RecipeId,
  payload: Record<string, unknown>
): { contentMarkdown: string; payload: Record<string, unknown>; kind: ItemKind } {
  const recipe = recipeMap.get(id);
  if (recipe === undefined) {
    throw new Error(`Unknown recipe: ${id}`);
  }
  const parsed = recipe.schema.parse(payload);
  const contentMarkdown = recipe.render(parsed);
  if (contentMarkdown.length > 12_000) {
    throw new Error("Rendered recipe content exceeds 12000 characters");
  }
  return { contentMarkdown, payload: parsed, kind: recipe.kind };
}

export const recipeInternals = {
  clientEmailSchema,
  commandSetSchema,
  decisionSchema,
  githubPrSchema,
  incidentSummarySchema,
  slackUpdateSchema
};
