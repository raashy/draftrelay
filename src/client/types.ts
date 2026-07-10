export type LifecycleStatus = "new" | "reviewed" | "copied" | "done";
export type Destination = "slack" | "email" | "github" | "plain" | "markdown";
export type SecretSeverity = "low" | "medium" | "high" | "critical";

export interface ProvenanceFile {
  path: string;
  lineStart?: number;
  lineEnd?: number;
}

export interface Provenance {
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
  captureMethod?: "client_supplied" | "server_detected" | "legacy" | "manual";
  verificationStatus?:
    | "unverified"
    | "partially_verified"
    | "verified"
    | "passed"
    | "partial"
    | "failed";
  verificationSummary?: string;
  files?: ProvenanceFile[];
  referencedFiles?: ProvenanceFile[];
  capturedAt?: string;
}

export interface SecretFinding {
  id: string;
  ruleId: string;
  label?: string;
  severity: SecretSeverity;
  action: "warn" | "block";
  lineNumber: number;
  redactedPreview: string;
  status: "open" | "acknowledged" | "false_positive";
  acknowledgedAt?: string | null;
}

export interface DumpItem {
  id: string;
  title: string;
  contentMarkdown: string;
  kind: string;
  project: string;
  tags: string[];
  sourceClient?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  recipeId?: string;
  recipePayload?: Record<string, unknown>;
  status?: LifecycleStatus;
  currentRevision?: number;
  currentRevisionId?: string;
  revisionCount?: number;
  reviewedAt?: string | null;
  copiedAt?: string | null;
  doneAt?: string | null;
  expiresAt?: string | null;
  provenance?: Provenance | null;
  secretFindings?: SecretFinding[];
  availableDestinations?: Destination[];
  defaultDestination?: Destination;
  humanEdited?: boolean;
}

export type FacetEntry =
  | string
  | {
      value?: string;
      name?: string;
      label?: string;
      count?: number;
    };

export interface ApiFacets {
  projects?: FacetEntry[] | Record<string, number>;
  project?: FacetEntry[] | Record<string, number>;
  kinds?: FacetEntry[] | Record<string, number>;
  kind?: FacetEntry[] | Record<string, number>;
  recipes?: FacetEntry[] | Record<string, number>;
  recipe?: FacetEntry[] | Record<string, number>;
  statuses?: FacetEntry[] | Record<string, number>;
  status?: FacetEntry[] | Record<string, number>;
  tags?: FacetEntry[] | Record<string, number>;
  tag?: FacetEntry[] | Record<string, number>;
}

export interface ItemsResponse {
  items: DumpItem[];
  facets?: ApiFacets;
  nextCursor?: string;
}

export interface FacetOption {
  value: string;
  count?: number;
}

export interface RecipeField {
  name: string;
  label: string;
  type:
    | "text"
    | "markdown"
    | "string_list"
    | "command_list"
    | "string"
    | "string[]"
    | "commands";
  required?: boolean;
  description?: string;
}

export interface RecipeSummary {
  id: string;
  version?: number;
  name: string;
  description: string;
  defaultDestination: Destination;
  destinations: Destination[];
  fields?: RecipeField[];
  builtin?: boolean;
}

export interface Representation {
  id: string;
  itemId: string;
  revision: number;
  destination: Destination;
  plainText: string;
  markdownText?: string | null;
  htmlText?: string | null;
  metadata?: Record<string, unknown>;
  warnings: string[];
  createdAt: string;
  copyAllowed: boolean;
  blockReasons: string[];
}

export interface ArtifactRevision {
  id: string;
  itemId?: string;
  revision: number;
  title: string;
  contentMarkdown: string;
  recipeId: string;
  changeNote?: string | null;
  authorKind?: "agent" | "human" | "migration";
  authorLabel?: string;
  provenance?: Provenance | null;
  secretFindings?: SecretFinding[];
  createdAt: string;
}

export interface ProjectPolicy {
  project: string;
  defaultRecipeId?: string | null;
  defaultDestination: Destination;
  allowedDestinations: Destination[];
  secretMode: "off" | "warn" | "block_high" | "block_all";
  requireSecretAck: boolean;
  requireReviewBeforeCopy: boolean;
  copyBehavior: "no_change" | "mark_copied" | "mark_done";
  retentionDays?: number | null;
  requiredProvenance?: string[];
}

export interface ProjectSummary {
  name: string;
  slug?: string;
  itemCount?: number;
  policy?: ProjectPolicy;
}

export interface ProjectSecretPattern {
  id: string;
  label: string;
  patternKind: "literal" | "glob";
  pattern: string;
  severity: SecretSeverity;
}
