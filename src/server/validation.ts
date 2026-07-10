import { z } from "zod";

import {
  DESTINATIONS,
  ITEM_KINDS,
  ITEM_STATUSES,
  RECIPE_IDS,
  type CreateItemInput,
  type CreateRevisionInput,
  type Destination,
  type ItemQuery,
  type ItemStatus,
  type ProjectPolicy,
  type RecipeId,
  type SecretSeverity,
  type UpdateItemInput
} from "../shared/items.js";
import {
  kindForRecipe,
  recipeForLegacyKind,
  renderRecipePayload
} from "./recipes.js";
import { decodeItemCursor } from "./pagination.js";

export const MAX_TITLE_LENGTH = 120;
export const MAX_CONTENT_LENGTH = 12_000;
export const MAX_TAGS = 8;

const titleSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH));

const contentMarkdownSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1, "Markdown content is required")
      .max(MAX_CONTENT_LENGTH, `Markdown content cannot exceed ${MAX_CONTENT_LENGTH} characters`)
  );

const projectSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Project cannot be empty").max(80));

const sourceClientSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Source client cannot be empty").max(64));

const rawTagSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Tags cannot be empty").max(32));

export const kindSchema = z.enum(ITEM_KINDS);
export const statusSchema = z.enum(ITEM_STATUSES);
export const destinationSchema = z.enum(DESTINATIONS);
export const recipeIdSchema = z.enum(RECIPE_IDS);

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTagSchema.parse(rawTag);
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(tag);
    }
  }
  return normalized;
}

const tagsSchema = z.array(z.string()).max(MAX_TAGS).transform(normalizeTags);
const compactOptional = (maximum: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1).max(maximum))
    .optional();

const referencedFileSchema = z
  .object({
    path: z.string().trim().min(1).max(2_000),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional()
  })
  .strict()
  .refine(
    (value) =>
      value.lineStart === undefined ||
      value.lineEnd === undefined ||
      value.lineEnd >= value.lineStart,
    "lineEnd must be greater than or equal to lineStart"
  );

const provenanceSchema = z
  .object({
    sourceClient: sourceClientSchema.optional(),
    sourceClientVersion: compactOptional(64),
    agentName: compactOptional(100),
    model: compactOptional(100),
    sessionId: compactOptional(240),
    cwd: compactOptional(2_000),
    repoRoot: compactOptional(2_000),
    repoRemote: compactOptional(2_000),
    branch: compactOptional(500),
    commitSha: compactOptional(100),
    repoDirty: z.boolean().optional(),
    verificationStatus: z.enum(["unverified", "passed", "partial", "failed"]).optional(),
    verificationSummary: compactOptional(2_000),
    referencedFiles: z.array(referencedFileSchema).max(50).optional()
  })
  .strict();

const payloadSchema = z.record(z.string(), z.unknown());
const idempotencyKeySchema = z.string().trim().min(1).max(240);

const createRequestSchema = z
  .object({
    title: titleSchema,
    contentMarkdown: contentMarkdownSchema.optional(),
    kind: kindSchema.optional().default("note"),
    project: projectSchema.optional().default("General"),
    tags: tagsSchema.optional().default([]),
    sourceClient: sourceClientSchema.optional().default("manual"),
    recipeId: recipeIdSchema.optional(),
    payload: payloadSchema.optional(),
    recipePayload: payloadSchema.nullable().optional(),
    provenance: provenanceSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const payload = value.payload ?? value.recipePayload ?? undefined;
    if (value.contentMarkdown === undefined && payload === undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide either contentMarkdown or a typed recipe payload"
      });
    }
    if (value.contentMarkdown !== undefined && payload !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Provide contentMarkdown or a typed recipe payload, not both"
      });
    }
    if (payload !== undefined && value.recipeId === undefined) {
      context.addIssue({ code: "custom", message: "recipeId is required with a recipe payload" });
    }
  });

export function parseCreateItem(value: unknown): CreateItemInput {
  const parsed = createRequestSchema.parse(value);
  const payload = parsed.payload ?? parsed.recipePayload ?? undefined;
  if (payload !== undefined && parsed.recipeId !== undefined) {
    const rendered = renderRecipePayload(parsed.recipeId, payload);
    return {
      title: parsed.title,
      contentMarkdown: contentMarkdownSchema.parse(rendered.contentMarkdown),
      kind: rendered.kind,
      project: parsed.project,
      tags: parsed.tags,
      sourceClient: parsed.sourceClient,
      recipeId: parsed.recipeId,
      recipePayload: rendered.payload,
      provenance: parsed.provenance,
      idempotencyKey: parsed.idempotencyKey
    };
  }
  const recipeId = parsed.recipeId ?? recipeForLegacyKind(parsed.kind);
  if (!recipeId.startsWith("generic_") && parsed.contentMarkdown !== undefined) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["recipeId"],
        message: "Typed recipes require a recipe payload"
      }
    ]);
  }
  return {
    title: parsed.title,
    contentMarkdown: parsed.contentMarkdown ?? "",
    kind: parsed.recipeId === undefined ? parsed.kind : kindForRecipe(recipeId),
    project: parsed.project,
    tags: parsed.tags,
    sourceClient: parsed.sourceClient,
    recipeId,
    recipePayload: { contentMarkdown: parsed.contentMarkdown ?? "" },
    provenance: parsed.provenance,
    idempotencyKey: parsed.idempotencyKey
  };
}

const updateRequestSchema = z
  .object({
    title: titleSchema.optional(),
    contentMarkdown: contentMarkdownSchema.optional(),
    kind: kindSchema.optional(),
    project: projectSchema.optional(),
    tags: tagsSchema.optional(),
    sourceClient: sourceClientSchema.optional(),
    recipeId: recipeIdSchema.optional(),
    payload: payloadSchema.optional(),
    recipePayload: payloadSchema.nullable().optional(),
    provenance: provenanceSchema.optional(),
    changeNote: compactOptional(500),
    baseRevision: z.number().int().positive().optional(),
    status: statusSchema.optional(),
    archived: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required")
  .superRefine((value, context) => {
    const payload = value.payload ?? value.recipePayload ?? undefined;
    if (payload !== undefined && value.recipeId === undefined) {
      context.addIssue({ code: "custom", message: "recipeId is required with a recipe payload" });
    }
    if (payload !== undefined && value.contentMarkdown !== undefined) {
      context.addIssue({ code: "custom", message: "Do not provide payload and contentMarkdown together" });
    }
  });

export function parseUpdateItem(value: unknown): UpdateItemInput {
  const parsed = updateRequestSchema.parse(value);
  const payload = parsed.payload ?? parsed.recipePayload ?? undefined;
  if (payload !== undefined && parsed.recipeId !== undefined) {
    const rendered = renderRecipePayload(parsed.recipeId, payload);
    return {
      ...parsed,
      contentMarkdown: contentMarkdownSchema.parse(rendered.contentMarkdown),
      kind: rendered.kind,
      recipePayload: rendered.payload,
      payload: undefined
    } as UpdateItemInput;
  }
  const { payload: _payload, ...input } = parsed;
  return input as UpdateItemInput;
}

const createRevisionSchema = z
  .object({
    title: titleSchema.optional(),
    contentMarkdown: contentMarkdownSchema,
    changeNote: compactOptional(500),
    baseRevision: z.number().int().positive(),
    sourceClient: sourceClientSchema.optional(),
    provenance: provenanceSchema.optional(),
    recipeId: recipeIdSchema.optional(),
    recipePayload: payloadSchema.nullable().optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    authorKind: z.enum(["agent", "human"]).optional()
  })
  .strict();

export function parseCreateRevision(value: unknown): CreateRevisionInput {
  return createRevisionSchema.parse(value) as CreateRevisionInput;
}

const optionalQueryText = (maximum: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(maximum))
    .optional()
    .transform((value) => (value === "" ? undefined : value));

export const itemQuerySchema = z
  .object({
    archived: z.enum(["false", "true", "all"]).optional().default("false"),
    q: optionalQueryText(200),
    project: optionalQueryText(80),
    kind: kindSchema.optional(),
    tag: optionalQueryText(32),
    status: statusSchema.optional(),
    recipe: recipeIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    cursor: z.string().min(8).max(500).refine(
      (value) => decodeItemCursor(value) !== undefined,
      "Invalid pagination cursor"
    ).optional()
  })
  .strict();

export function parseItemQuery(value: unknown): ItemQuery {
  return itemQuerySchema.parse(value);
}

export function parseTransition(value: unknown): ItemStatus {
  return z.object({ status: statusSchema }).strict().parse(value).status;
}

export interface CopyReceiptInput {
  representationId: string;
  destination?: Destination;
  format?: string;
  clientEventId?: string;
  actorLabel?: string;
}

export function parseCopyReceipt(value: unknown): CopyReceiptInput {
  return z
    .object({
      representationId: z.string().trim().min(1).max(100),
      destination: destinationSchema.optional(),
      format: compactOptional(30),
      clientEventId: compactOptional(240),
      actorLabel: compactOptional(100)
    })
    .strict()
    .parse(value);
}

const projectPolicyPatchSchema = z
  .object({
    defaultRecipeId: recipeIdSchema.optional(),
    defaultDestination: destinationSchema.optional(),
    allowedDestinations: z
      .array(destinationSchema)
      .min(1)
      .transform((values) => [...new Set(values)])
      .optional(),
    secretMode: z.enum(["off", "warn", "block_high", "block_all"]).optional(),
    requireSecretAck: z.boolean().optional(),
    requireReviewBeforeCopy: z.boolean().optional(),
    copyBehavior: z.enum(["no_change", "mark_copied", "mark_done"]).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one policy field is required")
  .superRefine((value, context) => {
    if (
      value.defaultDestination !== undefined &&
      value.allowedDestinations !== undefined &&
      !value.allowedDestinations.includes(value.defaultDestination)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultDestination"],
        message: "defaultDestination must be allowed"
      });
    }
  });

export function parseProjectPolicyPatch(
  value: unknown
): Partial<Omit<ProjectPolicy, "project" | "updatedAt">> {
  return projectPolicyPatchSchema.parse(value);
}

export function parseSecretPattern(value: unknown): {
  label: string;
  patternKind: "literal" | "glob";
  pattern: string;
  severity: SecretSeverity;
} {
  return z
    .object({
      label: z.string().trim().min(1).max(100),
      patternKind: z.enum(["literal", "glob"]),
      pattern: z.string().min(3).max(240),
      severity: z.enum(["low", "medium", "high", "critical"])
    })
    .strict()
    .parse(value);
}

export const validationInternals = {
  normalizeTags,
  provenanceSchema,
  projectPolicyPatchSchema
};
