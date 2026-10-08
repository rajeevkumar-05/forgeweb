export type BuildStatus = "queued" | "specifying" | "planning" | "awaiting_confirmation" | "generating" | "reviewing" | "validating" | "completed" | "failed" | "needs_context";

export type BuildCapability = {
  id: string;
  name: string;
  kind: string;
  sourceUrl: string;
  usage: string;
  boundary: string;
};

export type ArchitecturePlan = {
  systemShape: string;
  frontend: { framework: string; pages: string[]; components: string[]; motion: string[] };
  backend: { runtime: string; modules: string[]; apiStyle: string; jobs: string[] };
  data: { database: string; entities: string[]; rules: string[] };
  security: string[];
  delivery: string[];
  diagram: string;
  markdown: string;
  capabilities: BuildCapability[];
};

export type ProjectSummary = {
  id: string;
  ownerId?: string;
  slug: string;
  name: string;
  status: "planning" | "awaiting_confirmation" | "building" | "editing" | "ready" | "validation_failed" | "ready_to_export" | "failed";
  originalPrompt?: string;
  currentBuildId?: string;
  currentVersionId?: string;
  currentVersionNumber?: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredFile = { path: string; content: string; requirementIds: string[]; digest: string };

export type ProjectVersion = {
  id: string;
  projectId: string;
  buildId: string;
  versionNumber: number;
  label: string;
  editPrompt: string;
  modifiedFiles: string[];
  sourceVersionId?: string;
  candidateId?: string;
  validationStatus: "pending" | "passed" | "failed";
  validationChecks: Array<{ id: string; name: string; status: "passed" | "failed" | "skipped"; evidence: string }>;
  createdAt: string;
};

export type ProjectWorkspace = {
  project: ProjectSummary;
  currentVersion?: ProjectVersion;
  versions: ProjectVersion[];
  files: StoredFile[];
  database: {
    engine: string;
    schemaSource: string;
    tables: Array<{ name: string; purpose: string }>;
    separationNote: string;
  };
};

export type ExportSummary = {
  projectId: string;
  projectName: string;
  versionId: string;
  versionNumber: number;
  frontend: "generated" | "missing";
  backend: "generated" | "missing";
  database: "configured" | "not-required";
  validation: "passed" | "failed";
  fileCount: number;
  checks: Array<{ id: string; name: string; status: "passed" | "failed" | "skipped"; evidence: string }>;
};

export type LlmStatus = {
  enabled: boolean;
  available: boolean;
  provider: string;
  model: string;
  mode: "ai-powered" | "template-fallback";
  baseUrl: string;
};

export type BuildResponse = {
  generationMode?: "legacy" | "safe";
  id: string;
  projectId: string;
  status: BuildStatus;
  currentStageIndex: number;
  stageDetail: string;
  error?: { code: string; message: string };
  llmMetadata?: { provider: string; model: string; fallbackUsed: boolean; durationMs: number };
  specification?: {
    id: string;
    status: "proposed" | "approved";
    productName: string;
    summary: string;
    roles: string[];
    entities: string[];
    assumptions: string[];
    requirements: Array<{ id: string; title: string; description: string; acceptanceCriteria: string[]; priority: string }>;
    architecture: ArchitecturePlan;
  };
  filePaths: string[];
  validationChecks: Array<{ id: string; name: string; status: "passed" | "failed" | "skipped"; evidence: string }>;
  project: ProjectSummary;
};

type ApiEnvelope = { build: BuildResponse };

export type ForgeUser = { id: string; username: string; canClaimLocalProjects: boolean };
export type OwnerSession = { user: ForgeUser | null; migration: { standard: number; verified: number } };

export function getOwnerSession(): Promise<OwnerSession> { return request("/api/auth/session"); }
export async function signIn(username: string, password: string, register = false): Promise<ForgeUser> {
  const result = await request<{ user: ForgeUser }>(register ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  return result.user;
}
export async function signOut(): Promise<void> { await request("/api/auth/logout", { method: "POST" }); }
export function claimExistingProjects(includeVerified = false): Promise<{ claimed: number }> {
  return request("/api/projects/claim", { method: "POST", body: JSON.stringify({ confirmed: true, includeVerified }) });
}
export async function deleteProject(projectId: string): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE", body: JSON.stringify({ confirmed: true }) });
}

export type SafeGenerationStatus = {
  enabled: boolean;
  authenticated: boolean;
  target: "forgeweb-postgresql-v1";
  isolatedValidation: "configured" | "unavailable";
  disposablePostgresql: "configured" | "unavailable";
  trustedRuntime: "configured" | "unavailable";
};

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

import type { SafePreviewResponse } from "../../server/generation/preview-contract";
export type { SafePreviewResponse } from "../../server/generation/preview-contract";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new ApiRequestError(response.status, payload.error?.message ?? `Request failed with status ${response.status}.`);
  return payload;
}

export async function createBuild(prompt: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope>("/api/builds", { method: "POST", body: JSON.stringify({ prompt }) });
  return payload.build;
}

export async function getSafeGenerationStatus(): Promise<SafeGenerationStatus> {
  return request<SafeGenerationStatus>("/api/safe/status");
}

export async function authenticateSafeGeneration(token: string): Promise<void> {
  await request<{ authenticated: true }>("/api/safe/session", { method: "POST", body: JSON.stringify({ token }) });
}

export async function activateSafeGeneration(token: string): Promise<SafeGenerationStatus> {
  try {
    await authenticateSafeGeneration(token);
    const status = await getSafeGenerationStatus();
    if (!status.enabled || !status.authenticated) throw new Error("Safe session was not established.");
    return status;
  } catch {
    throw new Error("Verified activation failed. Check your activation token and server connection, then try again.");
  }
}

export async function createSafeBuild(prompt: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope>("/api/safe/builds", { method: "POST", body: JSON.stringify({ prompt }) });
  return payload.build;
}

export async function confirmSafeBuild(buildId: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope & { generation: { status: string; validation: string; runtime: string } }>(
    `/api/safe/builds/${encodeURIComponent(buildId)}/confirm`,
    { method: "POST" },
  );
  return payload.build;
}

export async function requestSafePreview(projectId: string, versionId: string): Promise<SafePreviewResponse> {
  const { preview } = await request<{ preview: SafePreviewResponse }>(
    `/api/safe/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/preview`,
    { method: "POST" },
  );
  if (!preview || preview.versionId !== versionId || (preview.status !== "ready" && preview.status !== "unavailable")) {
    throw new Error("The preview response does not match the requested version.");
  }
  if (preview.status === "ready") {
    let url: URL;
    try { url = new URL(preview.previewUrl); } catch { throw new Error("The preview URL is invalid."); }
    if (url.protocol !== "https:" || url.hostname !== "localhost" || !url.port || url.username || url.password
      || url.search || url.hash || !/^\/session\/[a-f0-9]{64}$/.test(url.pathname)) throw new Error("A trusted localhost HTTPS preview URL is required.");
    if (!Number.isSafeInteger(preview.expiresAt) || preview.expiresAt <= Date.now()) throw new Error("The preview session has expired. Try again.");
  }
  return preview;
}

export async function openSafePreview(projectId: string, versionId: string): Promise<
  | { status: "ready"; opened: true }
  | { status: "ready"; opened: false; expiresAt: number; open: () => void }
  | { status: "unavailable"; message: string }
> {
  const preview = await requestSafePreview(projectId, versionId);
  if (preview.status === "unavailable") return { status: "unavailable", message: preview.message };
  let opened = false;
  const launch = () => {
    if (opened || preview.expiresAt <= Date.now()) throw new Error("Request a fresh preview session and try again.");
    // The initial navigation carries the real URL, including in external-browser bridges.
    const tab = window.open(preview.previewUrl, "_blank");
    if (!tab) return false;
    try { tab.opener = null; }
    catch { tab.close(); throw new Error("The preview tab could not be detached safely. Try again."); }
    opened = true;
    return true;
  };
  if (launch()) return { status: "ready", opened: true };
  // Only an ephemeral callable retains the URL for a second, popup-safe user gesture.
  return { status: "ready", opened: false, expiresAt: preview.expiresAt, open() {
    if (!launch()) throw new Error("Allow a new preview tab and try again.");
  } };
}

export async function confirmBuild(buildId: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope>(`/api/builds/${encodeURIComponent(buildId)}/confirm`, { method: "POST" });
  return payload.build;
}

export async function reviseBuild(buildId: string, prompt: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope>(`/api/builds/${encodeURIComponent(buildId)}/revise`, { method: "POST", body: JSON.stringify({ prompt }) });
  return payload.build;
}

export async function getBuild(buildId: string): Promise<BuildResponse> {
  const payload = await request<ApiEnvelope>(`/api/builds/${encodeURIComponent(buildId)}`);
  return payload.build;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const payload = await request<{ projects: ProjectSummary[] }>("/api/projects");
  return payload.projects;
}

export async function getLlmStatus(): Promise<LlmStatus> {
  const payload = await request<{ llm: LlmStatus }>("/api/llm/status");
  return payload.llm;
}

export async function getProjectWorkspace(projectId: string): Promise<ProjectWorkspace> {
  const payload = await request<{ workspace: ProjectWorkspace }>(`/api/projects/${encodeURIComponent(projectId)}/workspace`);
  return payload.workspace;
}

export async function applyProjectEdit(projectId: string, prompt: string): Promise<{ workspace: ProjectWorkspace; modifiedFiles: string[]; phases: string[] }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/edits`, { method: "POST", body: JSON.stringify({ prompt }) });
}

export async function restoreProjectVersion(projectId: string, versionId: string): Promise<ProjectWorkspace> {
  const payload = await request<{ workspace: ProjectWorkspace }>(`/api/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
  return payload.workspace;
}

export async function validateProjectExport(projectId: string): Promise<ExportSummary> {
  const payload = await request<{ summary: ExportSummary }>(`/api/projects/${encodeURIComponent(projectId)}/export/validate`, { method: "POST" });
  return payload.summary;
}

export async function downloadProjectZip(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/export`, { method: "POST" });
  if (!response.ok) {
    const payload = await response.json() as { error?: { message?: string } };
    throw new Error(payload.error?.message ?? "Project export failed.");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] ?? "forgeweb-project.zip";
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function waitForBuild(
  buildId: string,
  onProgress: (build: BuildResponse) => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<BuildResponse> {
  const intervalMs = options.intervalMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const build = await getBuild(buildId);
    onProgress(build);
    if (["awaiting_confirmation", "completed", "failed", "needs_context"].includes(build.status)) return build;
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
  }
  throw new Error("The build is still running. Check the project activity and try again.");
}
