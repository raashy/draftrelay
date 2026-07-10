export const ITEM_KINDS = [
  "summary",
  "reply",
  "action",
  "snippet",
  "note"
] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ["new", "reviewed", "copied", "done"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const DESTINATIONS = ["plain", "markdown", "slack", "email", "github"] as const;
export type Destination = (typeof DESTINATIONS)[number];

export const RECIPE_IDS = [
  "slack_update",
  "client_email",
  "github_pr",
  "incident_summary",
  "decision",
  "command_set",
  "generic_reply",
  "generic_summary",
  "generic_action",
  "generic_snippet",
  "generic_note"
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

export interface ReferencedFile {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export type VerificationStatus = "unverified" | "passed" | "partial" | "failed";

export interface ItemProvenance {
  sourceClient: string;
  sourceClientVersion?: string;
  agentName?: string;
  model?: string;
  sessionId?: string;
  cwd?: string;
  repoRoot?: string;
  repoRemote?: string;
  branch?: string;
  commitSha?: string;
  repoDirty?: boolean;
  captureMethod: "client_supplied" | "server_detected" | "legacy" | "manual";
  verificationStatus: VerificationStatus;
  verificationSummary?: string;
  referencedFiles: ReferencedFile[];
  capturedAt: string;
}

export type SecretSeverity = "low" | "medium" | "high" | "critical";
export type SecretFindingStatus = "open" | "acknowledged" | "false_positive";

export interface SecretFinding {
  id: string;
  ruleId: string;
  label: string;
  severity: SecretSeverity;
  action: "warn" | "block";
  lineNumber: number;
  redactedPreview: string;
  status: SecretFindingStatus;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface OutputItem {
  id: string;
  title: string;
  contentMarkdown: string;
  kind: ItemKind;
  project: string;
  tags: string[];
  sourceClient: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  recipeId: RecipeId;
  recipePayload: Record<string, unknown> | null;
  status: ItemStatus;
  currentRevision: number;
  revisionCount: number;
  reviewedAt: string | null;
  copiedAt: string | null;
  doneAt: string | null;
  expiresAt: string | null;
  provenance: ItemProvenance | null;
  secretFindings: SecretFinding[];
  availableDestinations: Destination[];
  defaultDestination: Destination;
  humanEdited: boolean;
}

export interface ItemRevision {
  id: string;
  itemId: string;
  revision: number;
  title: string;
  contentMarkdown: string;
  recipeId: RecipeId;
  recipePayload: Record<string, unknown> | null;
  changeNote: string | null;
  authorKind: "agent" | "human" | "migration";
  authorLabel: string;
  provenance: ItemProvenance | null;
  createdAt: string;
}

export interface ItemEvent {
  id: string;
  itemId: string;
  revision: number | null;
  eventType: string;
  destination: Destination | null;
  actorKind: "agent" | "human" | "system" | "migration";
  actorLabel: string;
  createdAt: string;
}

export interface DestinationRepresentation {
  id: string;
  itemId: string;
  revision: number;
  destination: Destination;
  plainText: string;
  markdownText: string | null;
  htmlText: string | null;
  metadata: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
  copyAllowed: boolean;
  blockReasons: string[];
}

export interface RecipeField {
  name: string;
  type: "text" | "markdown" | "string_list" | "command_list";
  required: boolean;
  description: string;
}

export interface RecipeSummary {
  id: RecipeId;
  name: string;
  description: string;
  kind: ItemKind;
  defaultDestination: Destination;
  destinations: Destination[];
  fields: RecipeField[];
}

export type ProjectSecretMode = "off" | "warn" | "block_high" | "block_all";
export type CopyBehavior = "no_change" | "mark_copied" | "mark_done";

export interface ProjectPolicy {
  project: string;
  defaultRecipeId: RecipeId;
  defaultDestination: Destination;
  allowedDestinations: Destination[];
  secretMode: ProjectSecretMode;
  requireSecretAck: boolean;
  requireReviewBeforeCopy: boolean;
  copyBehavior: CopyBehavior;
  retentionDays: number | null;
  updatedAt: string;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface ItemFacets {
  projects: FacetValue[];
  kinds: FacetValue[];
  tags: FacetValue[];
  statuses: FacetValue[];
  recipes: FacetValue[];
}

export interface ItemsResponse {
  items: OutputItem[];
  facets: ItemFacets;
  nextCursor?: string;
}

export interface ProvenanceInput {
  sourceClient?: string;
  sourceClientVersion?: string;
  agentName?: string;
  model?: string;
  sessionId?: string;
  cwd?: string;
  repoRoot?: string;
  repoRemote?: string;
  branch?: string;
  commitSha?: string;
  repoDirty?: boolean;
  verificationStatus?: VerificationStatus;
  verificationSummary?: string;
  referencedFiles?: ReferencedFile[];
}

export interface CreateItemInput {
  title: string;
  contentMarkdown: string;
  kind?: ItemKind;
  project?: string;
  tags?: string[];
  sourceClient?: string;
  recipeId?: RecipeId;
  recipePayload?: Record<string, unknown> | null;
  provenance?: ProvenanceInput;
  idempotencyKey?: string;
}

export interface UpdateItemInput {
  title?: string;
  contentMarkdown?: string;
  kind?: ItemKind;
  project?: string;
  tags?: string[];
  sourceClient?: string;
  recipeId?: RecipeId;
  recipePayload?: Record<string, unknown> | null;
  provenance?: ProvenanceInput;
  changeNote?: string;
  baseRevision?: number;
  status?: ItemStatus;
  archived?: boolean;
}

export interface CreateRevisionInput {
  title?: string;
  contentMarkdown: string;
  changeNote?: string;
  baseRevision: number;
  sourceClient?: string;
  provenance?: ProvenanceInput;
  recipeId?: RecipeId;
  recipePayload?: Record<string, unknown> | null;
  idempotencyKey?: string;
  authorKind?: "agent" | "human";
}

export type ArchivedFilter = "false" | "true" | "all";

export interface ItemQuery {
  archived: ArchivedFilter;
  q?: string;
  project?: string;
  kind?: ItemKind;
  tag?: string;
  status?: ItemStatus;
  recipe?: RecipeId;
  limit?: number;
  cursor?: string;
}
