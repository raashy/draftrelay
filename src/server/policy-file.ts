import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import {
  DESTINATIONS,
  RECIPE_IDS,
  type ProjectPolicy
} from "../shared/items.js";
import type { ItemStore } from "./store.js";

const MAX_POLICY_BYTES = 64 * 1024;
const policyPatchSchema = z
  .object({
    defaultRecipeId: z.enum(RECIPE_IDS).optional(),
    defaultDestination: z.enum(DESTINATIONS).optional(),
    allowedDestinations: z.array(z.enum(DESTINATIONS)).min(1).max(DESTINATIONS.length).optional(),
    secretMode: z.enum(["off", "warn", "block_high", "block_all"]).optional(),
    requireSecretAck: z.boolean().optional(),
    requireReviewBeforeCopy: z.boolean().optional(),
    copyBehavior: z.enum(["no_change", "mark_copied", "mark_done"]).optional(),
    retentionDays: z.number().int().min(1).max(3650).nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.defaultDestination !== undefined &&
      value.allowedDestinations !== undefined &&
      !value.allowedDestinations.includes(value.defaultDestination)
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultDestination"],
        message: "defaultDestination must be included in allowedDestinations"
      });
    }
  });

const workspacePolicySchema = z
  .object({
    version: z.literal(1),
    project: z.string().trim().min(1).max(80),
    policy: policyPatchSchema
  })
  .strict();

export interface WorkspacePolicyFile {
  path: string;
  project: string;
  policy: Partial<Omit<ProjectPolicy, "project" | "updatedAt">>;
}

export interface WorkspacePolicyOptions {
  searchFrom?: string | false;
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
}

function resolveExplicitPath(value: string, searchFrom: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(searchFrom, value);
}

export function discoverWorkspacePolicy(options: WorkspacePolicyOptions = {}): string | null {
  const env = options.env ?? process.env;
  const searchFrom = path.resolve(options.searchFrom === false ? process.cwd() : options.searchFrom ?? process.cwd());
  const explicit = options.explicitPath ?? env.CUTLINE_POLICY_FILE?.trim();
  if (explicit !== undefined && explicit !== "") {
    const resolved = resolveExplicitPath(explicit, searchFrom);
    if (!existsSync(resolved)) {
      throw new Error(`CUTLINE_POLICY_FILE does not exist: ${resolved}`);
    }
    return resolved;
  }
  if (options.searchFrom === false) {
    return null;
  }

  let directory = searchFrom;
  while (true) {
    for (const name of [".cutline.yml", ".cutline.yaml", "cutline.yml", "cutline.yaml"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    const reachedRepositoryRoot = existsSync(path.join(directory, ".git"));
    const parent = path.dirname(directory);
    if (reachedRepositoryRoot || parent === directory) return null;
    directory = parent;
  }
}

export function readWorkspacePolicy(filePath: string): WorkspacePolicyFile {
  const resolved = path.resolve(filePath);
  const stats = statSync(resolved);
  if (!stats.isFile()) throw new Error(`DraftRelay policy is not a regular file: ${resolved}`);
  if (stats.size > MAX_POLICY_BYTES) {
    throw new Error(`DraftRelay policy exceeds ${MAX_POLICY_BYTES} bytes: ${resolved}`);
  }

  try {
    const document = parse(readFileSync(resolved, "utf8"), {
      maxAliasCount: 20,
      schema: "core"
    }) as unknown;
    const parsed = workspacePolicySchema.parse(document);
    return { path: resolved, project: parsed.project, policy: parsed.policy };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid DraftRelay policy at ${resolved}: ${message}`, { cause: error });
  }
}

export function loadWorkspacePolicy(
  options: WorkspacePolicyOptions = {}
): WorkspacePolicyFile | null {
  const filePath = discoverWorkspacePolicy(options);
  return filePath === null ? null : readWorkspacePolicy(filePath);
}

export function applyWorkspacePolicy(
  store: ItemStore,
  options: WorkspacePolicyOptions = {}
): WorkspacePolicyFile | null {
  const loaded = loadWorkspacePolicy(options);
  if (loaded !== null) store.updateProjectPolicy(loaded.project, loaded.policy);
  return loaded;
}

export const policyFileInternals = {
  MAX_POLICY_BYTES,
  policyPatchSchema,
  resolveExplicitPath,
  workspacePolicySchema
};
