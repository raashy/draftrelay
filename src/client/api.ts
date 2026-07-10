import type {
  ArtifactRevision,
  Destination,
  DumpItem,
  ItemsResponse,
  LifecycleStatus,
  ProjectPolicy,
  ProjectSecretPattern,
  ProjectSummary,
  RecipeSummary,
  Representation,
  SecretFinding
} from "./types";

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())
        ? { "X-App-Request": "1" }
        : {}),
      ...init?.headers
    }
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: string | { code?: string; message?: string };
        message?: string;
      };
      if (typeof body.error === "string") message = body.error;
      else {
        message = body.error?.message ?? body.message ?? message;
        code = body.error?.code;
      }
    } catch {
      // The status remains useful for non-JSON errors.
    }
    const error = new Error(message) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = code;
    throw error;
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function listItems(params: URLSearchParams, signal?: AbortSignal): Promise<ItemsResponse> {
  return requestJson<ItemsResponse>(`/api/items?${params}`, { signal });
}

export function getItem(id: string, signal?: AbortSignal): Promise<DumpItem> {
  return requestJson<DumpItem>(`/api/items/${encodeURIComponent(id)}`, { signal });
}

export function getRecipes(): Promise<RecipeSummary[]> {
  return requestJson<RecipeSummary[] | { recipes: RecipeSummary[] }>("/api/recipes")
    .then((value) => Array.isArray(value) ? value : value.recipes);
}

export function getRepresentation(id: string, destination: Destination): Promise<Representation> {
  return requestJson<Representation>(
    `/api/items/${encodeURIComponent(id)}/representations/${encodeURIComponent(destination)}`
  );
}

export function recordCopy(
  id: string,
  representation: Representation,
  format: "rich" | "text" | "markdown"
): Promise<DumpItem> {
  return requestJson<DumpItem>(`/api/items/${encodeURIComponent(id)}/copy-receipts`, {
    method: "POST",
    body: JSON.stringify({
      representationId: representation.id,
      destination: representation.destination,
      format,
      clientEventId: crypto.randomUUID()
    })
  });
}

export function transitionItem(id: string, status: LifecycleStatus): Promise<DumpItem> {
  return requestJson<DumpItem>(`/api/items/${encodeURIComponent(id)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ status })
  });
}

export function getRevisions(id: string): Promise<ArtifactRevision[]> {
  return requestJson<ArtifactRevision[] | { revisions: ArtifactRevision[] }>(
    `/api/items/${encodeURIComponent(id)}/revisions`
  ).then((value) => Array.isArray(value) ? value : value.revisions);
}

export function createRevision(
  id: string,
  input: { title: string; contentMarkdown: string; changeNote?: string; baseRevision: number }
): Promise<DumpItem> {
  return requestJson<DumpItem>(`/api/items/${encodeURIComponent(id)}/revisions`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getFindings(id: string): Promise<SecretFinding[]> {
  return requestJson<SecretFinding[] | { findings: SecretFinding[] }>(
    `/api/items/${encodeURIComponent(id)}/findings`
  ).then((value) => Array.isArray(value) ? value : value.findings);
}

export function acknowledgeFinding(id: string, findingId: string): Promise<DumpItem> {
  return requestJson<DumpItem>(
    `/api/items/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}/acknowledge`,
    { method: "POST", body: "{}" }
  );
}

export function getProjects(): Promise<ProjectSummary[]> {
  return requestJson<
    ProjectSummary[] | { projects: Array<ProjectSummary | { project: string; count: number; policy?: ProjectPolicy }> }
  >("/api/projects").then((value) => {
    const projects = Array.isArray(value) ? value : value.projects;
    return projects.map((project) => "project" in project
      ? { name: project.project, itemCount: project.count, policy: project.policy }
      : project);
  });
}

export function getProjectPolicy(project: string): Promise<ProjectPolicy> {
  return requestJson<ProjectPolicy>(`/api/projects/${encodeURIComponent(project)}/policy`);
}

export function updateProjectPolicy(
  project: string,
  policy: Partial<ProjectPolicy>
): Promise<ProjectPolicy> {
  return requestJson<ProjectPolicy>(`/api/projects/${encodeURIComponent(project)}/policy`, {
    method: "PATCH",
    body: JSON.stringify(policy)
  });
}

export function getProjectSecretPatterns(project: string): Promise<ProjectSecretPattern[]> {
  return requestJson<ProjectSecretPattern[] | { patterns: ProjectSecretPattern[] }>(
    `/api/projects/${encodeURIComponent(project)}/secret-patterns`
  ).then((value) => Array.isArray(value) ? value : value.patterns);
}

export function createProjectSecretPattern(
  project: string,
  pattern: Omit<ProjectSecretPattern, "id">
): Promise<ProjectSecretPattern> {
  return requestJson<ProjectSecretPattern>(
    `/api/projects/${encodeURIComponent(project)}/secret-patterns`,
    { method: "POST", body: JSON.stringify(pattern) }
  );
}

export function deleteProjectSecretPattern(project: string, patternId: string): Promise<void> {
  return requestJson<void>(
    `/api/projects/${encodeURIComponent(project)}/secret-patterns/${encodeURIComponent(patternId)}`,
    { method: "DELETE" }
  );
}

export function deleteItem(id: string): Promise<void> {
  return requestJson<void>(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}
