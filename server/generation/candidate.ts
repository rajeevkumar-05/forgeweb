import { digest } from "../lib.ts";
import type { BackendSlice } from "./backend.ts";
import { BackendSliceValidationError, prepareBackendSlice } from "./backend.ts";
import { baseReference, candidateManifestDigest, prepareCandidate, prepareGenerationRequest } from "./contract.ts";
import type { CandidateArtifact, CandidateArtifacts, EngineFailureCode, EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";
import type { FrontendSlice } from "./frontend.ts";
import { FrontendSliceValidationError, prepareFrontendSlice } from "./frontend.ts";

export const CANDIDATE_ASSEMBLY_CONTRACT_VERSION = "forgeweb-candidate-assembly-v1" as const;

const ASSEMBLER_ENGINE: EngineMetadata = {
  name: "forgeweb-candidate-assembler",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

export type CandidateAssemblyMetadata = {
  readonly contractVersion: typeof CANDIDATE_ASSEMBLY_CONTRACT_VERSION;
  readonly slices: { readonly backendDigest: string; readonly frontendDigest: string };
  readonly target: {
    readonly profile: string;
    readonly database: BackendSlice["database"];
    readonly frontendProfile: FrontendSlice["target"]["frontendProfile"];
  };
  readonly dependencies: {
    readonly backend: BackendSlice["dependencies"];
    readonly frontend: FrontendSlice["dependencies"];
  };
  readonly capabilities: {
    readonly backend: BackendSlice["capabilities"];
    readonly backendRoutes: BackendSlice["routes"];
    readonly frontendRoutes: FrontendSlice["routes"];
    readonly frontendApi: FrontendSlice["api"];
  };
  readonly evidence: {
    readonly backendModules: BackendSlice["modules"];
    readonly backendEntities: BackendSlice["entities"];
    readonly frontendPages: FrontendSlice["pages"];
    readonly frontendComponents: FrontendSlice["components"];
    readonly frontendStores: FrontendSlice["stores"];
  };
  readonly traceability: {
    readonly files: readonly { readonly path: string; readonly requirementIds: readonly string[] }[];
    readonly backendRoutes: BackendSlice["traceability"]["routes"];
    readonly frontendPages: FrontendSlice["traceability"]["pages"];
    readonly frontendComponents: FrontendSlice["traceability"]["components"];
    readonly untracedFiles: readonly { readonly path: string; readonly reason: "shared-infrastructure" }[];
  };
  readonly provenance: {
    readonly assembler: EngineMetadata;
    readonly backend: BackendSlice["provenance"];
    readonly frontend: FrontendSlice["provenance"];
  };
  readonly repair?: {
    readonly baseCandidateId: string;
    readonly findingId: string;
    readonly attempt: number;
    readonly modifiedFiles: readonly string[];
  };
  readonly determinism: { readonly inputDigest: string; readonly outputDigest: string; readonly normalized: true };
};

export type AssembledCandidateArtifacts = CandidateArtifacts & {
  readonly assembly: CandidateAssemblyMetadata;
};

export class CandidateAssemblyError extends TypeError {
  readonly diagnosticCode: string;
  readonly path?: string;

  constructor(diagnosticCode: string, message: string, path?: string) {
    super(message);
    this.name = "CandidateAssemblyError";
    this.diagnosticCode = diagnosticCode;
    this.path = path;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function stableDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function artifact(kind: CandidateArtifact["kind"], value: unknown): CandidateArtifact {
  const content = canonicalJson(value);
  return { kind, format: "json", content, digest: digest(content) };
}

function failed<Value>(code: EngineFailureCode, message: string, diagnosticCode: string, path?: string): EngineResult<Value> {
  return {
    ok: false,
    engine: ASSEMBLER_ENGINE,
    error: {
      code,
      stage: "candidate-assembly",
      message,
      retryable: false,
      diagnostics: [{ code: diagnosticCode, message, ...(path ? { path } : {}) }],
    },
  };
}

export function candidateAssemblyInputDigest(request: GenerationRequest, backendDigest: string, frontendDigest: string): string {
  return stableDigest({ request, backendDigest, frontendDigest });
}

export function candidateOutputDigest(candidate: AssembledCandidateArtifacts): string {
  const { id: _id, assembly, ...candidateWithoutIdentity } = candidate;
  const { outputDigest: _outputDigest, ...determinism } = assembly.determinism;
  return stableDigest({
    ...candidateWithoutIdentity,
    assembly: { ...assembly, determinism },
  });
}

function preflightCrossSliceCollisions(backend: BackendSlice, frontend: FrontendSlice): void {
  const backendPaths = new Set(backend.files.map((file) => file.path.toLowerCase()));
  const collision = frontend.files.find((file) => backendPaths.has(file.path.toLowerCase()));
  if (collision) throw new CandidateAssemblyError("CROSS_SLICE_COLLISION", "Backend and frontend slices contain a colliding path", collision.path);
}

function buildCandidate(request: GenerationRequest, backend: BackendSlice, frontend: FrontendSlice): AssembledCandidateArtifacts {
  const files = [...backend.files, ...frontend.files]
    .map((file) => ({ path: file.path, content: file.content, digest: file.digest, requirementIds: [...file.requirementIds] }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const artifacts = [
    artifact("requirements", request.approved.specification),
    artifact("architecture", request.design.architecture),
    artifact("database-design", request.design.database),
    artifact("backend", {
      routes: backend.routes,
      capabilities: backend.capabilities,
      dependencies: backend.dependencies,
      provenance: backend.provenance,
      determinism: backend.determinism,
    }),
    artifact("frontend", {
      pages: frontend.pages,
      routes: frontend.routes,
      api: frontend.api,
      dependencies: frontend.dependencies,
      provenance: frontend.provenance,
      determinism: frontend.determinism,
    }),
  ];
  const manifestDigest = candidateManifestDigest({ files, artifacts });
  const fileTraceability = files
    .map((entry) => ({ path: entry.path, requirementIds: [...entry.requirementIds] }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const untracedFiles = [...backend.traceability.untracedFiles, ...frontend.traceability.untracedFiles]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const inputDigest = candidateAssemblyInputDigest(request, backend.determinism.outputDigest, frontend.determinism.outputDigest);

  const candidateWithoutOutput = {
    state: "candidate" as const,
    id: "",
    projectId: request.scope.projectId,
    actor: structuredClone(request.scope.actor),
    approvedPlanId: request.approved.planId,
    bindingDigest: request.approved.bindingDigest,
    specificationId: request.approved.specification.id,
    specificationDigest: request.approved.digest,
    planDigest: request.approved.planDigest,
    base: baseReference(request),
    engine: ASSEMBLER_ENGINE,
    generatedAt: request.approved.specification.confirmedAt,
    validationState: "pending" as const,
    acceptanceState: "unaccepted" as const,
    files,
    artifacts,
    manifestDigest,
    assembly: {
      contractVersion: CANDIDATE_ASSEMBLY_CONTRACT_VERSION,
      slices: { backendDigest: backend.determinism.outputDigest, frontendDigest: frontend.determinism.outputDigest },
      target: { profile: request.options.targetProfile, database: structuredClone(backend.database), frontendProfile: frontend.target.frontendProfile },
      dependencies: { backend: structuredClone(backend.dependencies), frontend: structuredClone(frontend.dependencies) },
      capabilities: {
        backend: structuredClone(backend.capabilities),
        backendRoutes: structuredClone(backend.routes),
        frontendRoutes: structuredClone(frontend.routes),
        frontendApi: structuredClone(frontend.api),
      },
      evidence: {
        backendModules: structuredClone(backend.modules),
        backendEntities: structuredClone(backend.entities),
        frontendPages: structuredClone(frontend.pages),
        frontendComponents: structuredClone(frontend.components),
        frontendStores: structuredClone(frontend.stores),
      },
      traceability: {
        files: fileTraceability,
        backendRoutes: structuredClone(backend.traceability.routes),
        frontendPages: structuredClone(frontend.traceability.pages),
        frontendComponents: structuredClone(frontend.traceability.components),
        untracedFiles,
      },
      provenance: {
        assembler: ASSEMBLER_ENGINE,
        backend: structuredClone(backend.provenance),
        frontend: structuredClone(frontend.provenance),
      },
      determinism: { inputDigest, outputDigest: "", normalized: true as const },
    },
  } satisfies AssembledCandidateArtifacts;
  const outputDigest = candidateOutputDigest(candidateWithoutOutput);
  return {
    ...candidateWithoutOutput,
    id: `candidate_${outputDigest.slice(0, 24)}`,
    assembly: {
      ...candidateWithoutOutput.assembly,
      determinism: { ...candidateWithoutOutput.assembly.determinism, outputDigest },
    },
  };
}

export class CandidateAssembler {
  assemble(
    input: GenerationRequest,
    backendResult: EngineResult<BackendSlice>,
    frontendResult: EngineResult<FrontendSlice>,
  ): EngineResult<AssembledCandidateArtifacts> {
    if (!backendResult.ok) {
      return failed(backendResult.error.code, "Backend generation did not produce an assemblable slice", "BACKEND_GENERATION_FAILED");
    }
    if (!frontendResult.ok) {
      return failed(frontendResult.error.code, "Frontend generation did not produce an assemblable slice", "FRONTEND_GENERATION_FAILED");
    }

    try {
      const request = prepareGenerationRequest(input);
      preflightCrossSliceCollisions(backendResult.value, frontendResult.value);
      const backend = prepareBackendSlice(backendResult.value, request);
      const frontend = prepareFrontendSlice(frontendResult.value, request, backend);
      const candidate = buildCandidate(request, backend, frontend);
      return { ok: true, engine: ASSEMBLER_ENGINE, value: prepareCandidate(candidate, request) as AssembledCandidateArtifacts };
    } catch (error) {
      if (error instanceof CandidateAssemblyError || error instanceof BackendSliceValidationError || error instanceof FrontendSliceValidationError) {
        return failed(error.diagnosticCode === "CROSS_SLICE_COLLISION" || /PATH|COLLISION/.test(error.diagnosticCode) ? "security_failure" : "validation_failure", error.message, error.diagnosticCode, error.path);
      }
      const message = error instanceof Error ? error.message : "Candidate assembly failed";
      return failed("validation_failure", message, "INVALID_CANDIDATE_INPUT");
    }
  }
}
