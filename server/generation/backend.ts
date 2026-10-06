import { digest, safePath } from "../lib.ts";
import type { DatabaseTargetContract, EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";
import { APPLICATION_TARGET, databaseTargetContract } from "./targets.ts";

export const BACKEND_SLICE_CONTRACT_VERSION = "forgeweb-backend-slice-v1" as const;

export type BackendSliceFile = {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly digest: string;
  readonly language: string;
  readonly requirementIds: readonly string[];
};

export type BackendRouteManifestEntry = {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly status: "implemented" | "stub";
  readonly auth: boolean;
  readonly roles: readonly string[];
  readonly feature: string;
  readonly entity: string | null;
  readonly requirementIds: readonly string[];
};

export type BackendSlice = {
  readonly contractVersion: typeof BACKEND_SLICE_CONTRACT_VERSION;
  readonly projectId: string;
  readonly buildId: string;
  readonly approvedPlanId: string;
  readonly bindingDigest: string;
  readonly files: readonly BackendSliceFile[];
  readonly modules: readonly {
    readonly name: string;
    readonly entity: string | null;
    readonly crud: boolean;
    readonly endpoints: number;
    readonly controller: string;
    readonly service: string;
    readonly repository: string | null;
    readonly files: readonly string[];
  }[];
  readonly routes: readonly BackendRouteManifestEntry[];
  readonly entities: readonly {
    readonly name: string;
    readonly tableName: string;
    readonly fields: readonly string[];
    readonly softDelete: boolean;
  }[];
  readonly capabilities: {
    readonly api: "rest";
    readonly totalRoutes: number;
    readonly implementedRoutes: number;
    readonly stubRoutes: number;
    readonly authenticatedRoutes: number;
  };
  readonly dependencies: {
    readonly runtime: Readonly<Record<string, string>>;
    readonly development: Readonly<Record<string, string>>;
  };
  readonly traceability: {
    readonly files: readonly { readonly path: string; readonly requirementIds: readonly string[] }[];
    readonly routes: readonly { readonly method: string; readonly path: string; readonly requirementIds: readonly string[]; readonly status: "implemented" | "stub" }[];
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
  readonly database: { readonly dialect: "postgresql"; readonly provider: "postgresql"; readonly profile: string; readonly target: DatabaseTargetContract };
  readonly determinism: { readonly inputDigest: string; readonly outputDigest: string; readonly normalized: true };
};

export interface BackendGenerationService {
  generate(request: GenerationRequest): Promise<EngineResult<BackendSlice>>;
}

export class BackendSliceValidationError extends TypeError {
  readonly diagnosticCode: string;
  readonly path?: string;
  constructor(diagnosticCode: string, message: string, path?: string) {
    super(message);
    this.name = "BackendSliceValidationError";
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
  if (!condition) throw new BackendSliceValidationError(code, message, path);
}

function checkOutputPath(path: string): void {
  requireSlice(typeof path === "string" && path.startsWith("backend/") && path.length > "backend/".length, "INVALID_PATH", "Backend files must stay under backend/", path);
  requireSlice(!path.includes("\\") && !path.includes(":") && !/^[a-zA-Z]:/.test(path) && !/^[/\\]/.test(path), "INVALID_PATH", "Absolute, drive, device, and UNC paths are forbidden", path);
  requireSlice(path === safePath(path), "INVALID_PATH", "Backend path must be normalized and traversal-free", path);
  requireSlice(path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), "INVALID_PATH", "Backend path contains an invalid segment", path);
}

export function backendInputDigest(request: GenerationRequest): string {
  return stableDigest(request);
}

export function backendOutputDigest(slice: Omit<BackendSlice, "determinism"> & { readonly determinism: Omit<BackendSlice["determinism"], "outputDigest"> | BackendSlice["determinism"] }): string {
  const { outputDigest: _outputDigest, ...determinism } = slice.determinism as BackendSlice["determinism"];
  return stableDigest({ ...slice, determinism });
}

/** Validates and seals an in-memory backend slice. It never persists or executes files. */
export function prepareBackendSlice(slice: BackendSlice, request: GenerationRequest): BackendSlice {
  requireSlice(slice.contractVersion === BACKEND_SLICE_CONTRACT_VERSION, "INVALID_SLICE", "Unsupported backend slice contract");
  requireSlice(slice.projectId === request.scope.projectId && slice.buildId === request.scope.buildId, "CONTEXT_MISMATCH", "Backend slice belongs to another ForgeWeb operation");
  requireSlice(slice.approvedPlanId === request.approved.planId && slice.bindingDigest === request.approved.bindingDigest, "APPROVAL_MISMATCH", "Backend slice approval binding mismatch");
  const forbiddenKeys = ["state", "acceptanceState", "validationState", "manifestDigest", "artifacts"];
  requireSlice(forbiddenKeys.every((key) => !(key in (slice as unknown as Record<string, unknown>))), "CANDIDATE_STATE_FORBIDDEN", "Backend generation cannot create or accept a candidate");

  const expectedTarget = databaseTargetContract(APPLICATION_TARGET);
  requireSlice(slice.database.dialect === "postgresql" && slice.database.provider === "postgresql" && slice.database.profile === APPLICATION_TARGET.profile
    && JSON.stringify(slice.database.target) === JSON.stringify(expectedTarget), "TARGET_MISMATCH", "Backend slice requires the verified PostgreSQL application target");

  requireSlice(slice.files.length <= request.options.maxFiles, "FILE_BUDGET_EXCEEDED", "Backend slice exceeds the file-count budget");
  const paths = new Set<string>();
  const requirementIds = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  let totalBytes = 0;
  for (const file of slice.files) {
    checkOutputPath(file.path);
    const key = file.path.toLowerCase();
    requireSlice(!paths.has(key), "DUPLICATE_PATH", "Duplicate or case-colliding backend path", file.path);
    paths.add(key);
    requireSlice(typeof file.content === "string" && file.digest === digest(file.content), "INVALID_FILE_DIGEST", "Backend file digest mismatch", file.path);
    const bytes = Buffer.byteLength(file.content);
    requireSlice(file.bytes === bytes, "INVALID_FILE_SIZE", "Backend file byte count mismatch", file.path);
    totalBytes += bytes;
    requireSlice(file.requirementIds.every((id) => requirementIds.has(id)), "INVALID_TRACEABILITY", "Backend file references an unknown requirement", file.path);
  }
  requireSlice(totalBytes <= request.options.maxTotalBytes, "BYTE_BUDGET_EXCEEDED", "Backend slice exceeds the byte budget");

  for (const route of slice.routes) {
    requireSlice(["implemented", "stub"].includes(route.status) && route.path.startsWith("/api/v1/"), "INVALID_ROUTE", "Backend route manifest is invalid", route.path);
    requireSlice(route.requirementIds.every((id) => requirementIds.has(id)), "INVALID_TRACEABILITY", "Backend route references an unknown requirement", route.path);
  }
  for (const module of slice.modules) {
    requireSlice(module.files.every((path) => paths.has(path.toLowerCase())), "INVALID_MODULE", "Backend module references an unknown file", module.name);
    requireSlice(module.endpoints === slice.routes.filter((route) => route.feature === module.name).length, "INVALID_MODULE", "Backend module endpoint count does not match its routes", module.name);
  }
  requireSlice(slice.capabilities.totalRoutes === slice.routes.length
    && slice.capabilities.implementedRoutes === slice.routes.filter((route) => route.status === "implemented").length
    && slice.capabilities.stubRoutes === slice.routes.filter((route) => route.status === "stub").length
    && slice.capabilities.authenticatedRoutes === slice.routes.filter((route) => route.auth).length, "INVALID_CAPABILITIES", "Backend capability counts do not match the route manifest");

  requireSlice(slice.determinism.normalized === true && slice.determinism.inputDigest === backendInputDigest(request), "DETERMINISM_MISMATCH", "Backend input digest mismatch");
  requireSlice(slice.determinism.outputDigest === backendOutputDigest(slice), "DETERMINISM_MISMATCH", "Backend output digest mismatch");
  return freezeTree(structuredClone(slice));
}
