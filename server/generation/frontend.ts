import { digest, safePath } from "../lib.ts";
import type { BackendSlice } from "./backend.ts";
import { prepareBackendSlice } from "./backend.ts";
import type { EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";
import { APPLICATION_TARGET } from "./targets.ts";

export const FRONTEND_SLICE_CONTRACT_VERSION = "forgeweb-frontend-slice-v1" as const;
export const FRONTEND_TARGET_PROFILE = "forgeweb-react-vite-v1" as const;

export type FrontendSliceFile = {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly digest: string;
  readonly language: string;
  readonly requirementIds: readonly string[];
};

export type FrontendSlice = {
  readonly contractVersion: typeof FRONTEND_SLICE_CONTRACT_VERSION;
  readonly projectId: string;
  readonly buildId: string;
  readonly approvedPlanId: string;
  readonly bindingDigest: string;
  readonly files: readonly FrontendSliceFile[];
  readonly pages: readonly {
    readonly name: string;
    readonly route: string;
    readonly kind: string;
    readonly entity: string | null;
    readonly status: "implemented" | "unavailable";
    readonly unavailableReason?: "backend-capability-unavailable";
    readonly files: readonly string[];
    readonly requirementIds: readonly string[];
  }[];
  readonly routes: readonly {
    readonly path: string;
    readonly page: string;
    readonly protected: boolean;
    readonly lazy: boolean;
    readonly requirementIds: readonly string[];
  }[];
  readonly components: readonly {
    readonly name: string;
    readonly kind: string;
    readonly file: string;
    readonly requirementIds: readonly string[];
  }[];
  readonly stores: readonly {
    readonly name: string;
    readonly file: string;
    readonly persisted: boolean;
    readonly sensitive: boolean;
    readonly requirementIds: readonly string[];
  }[];
  readonly api: {
    readonly backendSliceDigest: string;
    readonly availableRoutes: readonly { readonly method: string; readonly path: string; readonly feature: string; readonly requirementIds: readonly string[] }[];
    readonly unavailableRoutes: readonly { readonly method: string; readonly path: string; readonly feature: string; readonly requirementIds: readonly string[] }[];
    readonly generatedCalls: readonly { readonly method: string; readonly path: string; readonly feature: string; readonly requirementIds: readonly string[] }[];
  };
  readonly dependencies: {
    readonly runtime: Readonly<Record<string, string>>;
    readonly development: Readonly<Record<string, string>>;
  };
  readonly traceability: {
    readonly files: readonly { readonly path: string; readonly requirementIds: readonly string[] }[];
    readonly pages: readonly { readonly name: string; readonly route: string; readonly requirementIds: readonly string[] }[];
    readonly components: readonly { readonly name: string; readonly file: string; readonly requirementIds: readonly string[] }[];
    readonly untracedFiles: readonly { readonly path: string; readonly reason: "shared-infrastructure" }[];
  };
  readonly provenance: {
    readonly engine: EngineMetadata;
    readonly upstream: { readonly project: "NexArch"; readonly revision: string; readonly generator: string };
    readonly approvedSpecificationId: string;
    readonly approvedSpecificationDigest: string;
    readonly planDigest: string;
    readonly baseManifestDigest: string;
  };
  readonly target: {
    readonly frontendProfile: typeof FRONTEND_TARGET_PROFILE;
    readonly databaseDialect: "postgresql";
    readonly databaseProvider: "postgresql";
    readonly databaseProfile: string;
  };
  readonly determinism: { readonly inputDigest: string; readonly outputDigest: string; readonly normalized: true };
};

export interface FrontendGenerationService {
  generate(request: GenerationRequest, backend: BackendSlice): Promise<EngineResult<FrontendSlice>>;
}

export class FrontendSliceValidationError extends TypeError {
  readonly diagnosticCode: string;
  readonly path?: string;
  constructor(diagnosticCode: string, message: string, path?: string) {
    super(message);
    this.name = "FrontendSliceValidationError";
    this.diagnosticCode = diagnosticCode;
    this.path = path;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function stableDigest(value: unknown): string {
  return digest(JSON.stringify(canonical(value)));
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function requireSlice(condition: unknown, code: string, message: string, path?: string): asserts condition {
  if (!condition) throw new FrontendSliceValidationError(code, message, path);
}

function checkOutputPath(path: string): void {
  requireSlice(typeof path === "string" && path.startsWith("frontend/") && path.length > "frontend/".length, "INVALID_PATH", "Frontend files must stay under frontend/", path);
  requireSlice(!path.includes("\\") && !path.includes(":") && !/^[a-zA-Z]:/.test(path) && !/^[/\\]/.test(path), "INVALID_PATH", "Absolute, drive, device, and UNC paths are forbidden", path);
  requireSlice(path === safePath(path), "INVALID_PATH", "Frontend path must be normalized and traversal-free", path);
  requireSlice(path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), "INVALID_PATH", "Frontend path contains an invalid segment", path);
}

export function frontendInputDigest(request: GenerationRequest, backend: BackendSlice): string {
  return stableDigest({ request, backendSliceDigest: backend.determinism.outputDigest });
}

export function frontendOutputDigest(slice: Omit<FrontendSlice, "determinism"> & { readonly determinism: Omit<FrontendSlice["determinism"], "outputDigest"> | FrontendSlice["determinism"] }): string {
  const { outputDigest: _outputDigest, ...determinism } = slice.determinism as FrontendSlice["determinism"];
  return stableDigest({ ...slice, determinism });
}

/** Validates and seals an in-memory frontend slice. It never persists or executes files. */
export function prepareFrontendSlice(slice: FrontendSlice, request: GenerationRequest, backendInput: BackendSlice): FrontendSlice {
  const backend = prepareBackendSlice(backendInput, request);
  requireSlice(slice.contractVersion === FRONTEND_SLICE_CONTRACT_VERSION, "INVALID_SLICE", "Unsupported frontend slice contract");
  requireSlice(slice.projectId === request.scope.projectId && slice.buildId === request.scope.buildId, "CONTEXT_MISMATCH", "Frontend slice belongs to another ForgeWeb operation");
  requireSlice(slice.approvedPlanId === request.approved.planId && slice.bindingDigest === request.approved.bindingDigest, "APPROVAL_MISMATCH", "Frontend slice approval binding mismatch");
  const forbiddenKeys = ["state", "acceptanceState", "validationState", "manifestDigest", "artifacts"];
  requireSlice(forbiddenKeys.every((key) => !(key in (slice as unknown as Record<string, unknown>))), "CANDIDATE_STATE_FORBIDDEN", "Frontend generation cannot create or accept a candidate");
  requireSlice(slice.target.frontendProfile === FRONTEND_TARGET_PROFILE && slice.target.databaseDialect === "postgresql"
    && slice.target.databaseProvider === "postgresql" && slice.target.databaseProfile === APPLICATION_TARGET.profile, "TARGET_MISMATCH", "Frontend slice target metadata is invalid");

  requireSlice(slice.files.length <= request.options.maxFiles, "FILE_BUDGET_EXCEEDED", "Frontend slice exceeds the file-count budget");
  const paths = new Set<string>();
  const requirementIds = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  let totalBytes = 0;
  for (const file of slice.files) {
    checkOutputPath(file.path);
    const key = file.path.toLowerCase();
    requireSlice(!paths.has(key), "DUPLICATE_PATH", "Duplicate or case-colliding frontend path", file.path);
    paths.add(key);
    requireSlice(typeof file.content === "string" && file.digest === digest(file.content), "INVALID_FILE_DIGEST", "Frontend file digest mismatch", file.path);
    const bytes = Buffer.byteLength(file.content);
    requireSlice(file.bytes === bytes, "INVALID_FILE_SIZE", "Frontend file byte count mismatch", file.path);
    totalBytes += bytes;
    requireSlice(file.requirementIds.every((id) => requirementIds.has(id)), "INVALID_TRACEABILITY", "Frontend file references an unknown requirement", file.path);
  }
  requireSlice(totalBytes <= request.options.maxTotalBytes, "BYTE_BUDGET_EXCEEDED", "Frontend slice exceeds the byte budget");

  for (const page of slice.pages) requireSlice(page.files.every((path) => paths.has(path.toLowerCase())), "INVALID_PAGE", "Frontend page references an unknown file", page.name);
  for (const component of slice.components) requireSlice(paths.has(component.file.toLowerCase()), "INVALID_COMPONENT", "Frontend component references an unknown file", component.file);
  for (const store of slice.stores) {
    requireSlice(paths.has(store.file.toLowerCase()), "INVALID_STORE", "Frontend store references an unknown file", store.file);
    requireSlice(!(store.sensitive && store.persisted), "INSECURE_STATE", "Sensitive frontend state cannot be persisted", store.file);
  }

  const implemented = new Set(backend.routes.filter((route) => route.status === "implemented").map((route) => `${route.method.toUpperCase()} ${route.path}`));
  const stubbed = new Set(backend.routes.filter((route) => route.status === "stub").map((route) => `${route.method.toUpperCase()} ${route.path}`));
  requireSlice(slice.api.backendSliceDigest === backend.determinism.outputDigest, "BACKEND_MISMATCH", "Frontend capability manifest targets another backend slice");
  for (const call of slice.api.generatedCalls) {
    const key = `${call.method.toUpperCase()} ${call.path}`;
    requireSlice(implemented.has(key) && !stubbed.has(key), "UNAVAILABLE_BACKEND_CALL", "Frontend calls an unavailable backend route", call.path);
  }

  requireSlice(slice.determinism.normalized === true && slice.determinism.inputDigest === frontendInputDigest(request, backend), "DETERMINISM_MISMATCH", "Frontend input digest mismatch");
  requireSlice(slice.determinism.outputDigest === frontendOutputDigest(slice), "DETERMINISM_MISMATCH", "Frontend output digest mismatch");
  return freezeTree(structuredClone(slice));
}
