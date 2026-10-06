import { digest, safePath } from "../lib.ts";
import { APPLICATION_TARGET } from "./targets.ts";
import type { BaseReference, CandidateArtifacts, CandidateValidation, EngineFile, GenerationRequest } from "./engine.ts";

function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid generation contract: ${message}`);
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function seal<T>(value: T): T {
  return freezeTree(structuredClone(value));
}

function checkedPath(path: string): void {
  requireContract(typeof path === "string" && path.length > 0, "file path is required");
  requireContract(!/^[a-zA-Z]:/.test(path) && !path.includes(":"), "drive or device paths are forbidden");
  requireContract(path === safePath(path), "file path must be normalized and relative");
  requireContract(path.split("/").every((segment) => segment !== "" && segment !== "."), "file path contains an empty or dot segment");
}

function checkFiles(files: readonly EngineFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    checkedPath(file.path);
    requireContract(typeof file.content === "string", "file content must be text");
    requireContract(file.digest === digest(file.content), `file digest mismatch: ${file.path}`);
    const key = file.path.toLowerCase();
    requireContract(!paths.has(key), `duplicate file path: ${file.path}`);
    paths.add(key);
  }
}

export function fileManifestDigest(files: readonly EngineFile[]): string {
  return digest(JSON.stringify(files.map((file) => [file.path, file.digest, [...file.requirementIds].sort()]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

export function candidateManifestDigest(candidate: Pick<CandidateArtifacts, "files" | "artifacts">): string {
  return digest(JSON.stringify({
    files: candidate.files.map((file) => [file.path, file.digest, [...file.requirementIds].sort()]).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0),
    artifacts: candidate.artifacts.map((artifact) => [artifact.kind, artifact.format, artifact.digest]).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0),
  }));
}

export function baseReference(request: GenerationRequest): BaseReference {
  const { base } = request;
  return base.kind === "empty"
    ? { kind: "empty", manifestDigest: base.manifestDigest }
    : { kind: "version", versionId: base.versionId, manifestDigest: base.manifestDigest };
}

/** Copy and freeze a request before any engine receives it. No Store or ProjectVersion crosses this boundary. */
export function prepareGenerationRequest(request: GenerationRequest): GenerationRequest {
  const { scope, base, approved, options } = request;
  requireContract(Boolean(approved.planId && approved.bindingDigest), "durable approval identity is required");
  requireContract(scope.actor.kind === "authenticated", "generation requires verified owner authorization through ForgeWeb");
  requireContract(options.targetProfile === APPLICATION_TARGET.profile && request.design.database?.dialect === "PostgreSQL" && request.design.architecture.projection.data.database === "PostgreSQL", "generation requires the canonical PostgreSQL application target");
  requireContract(Boolean(scope.projectId && scope.buildId && scope.operationId), "ForgeWeb operation identity is required");
  requireContract(Boolean(scope.actor.subjectId), "server-derived actor is required");
  requireContract(Boolean(scope.actor.ownerId), "actor ownership context is invalid");
  requireContract(base.projectId === scope.projectId, "base version belongs to another project");
  requireContract(base.kind === "empty" || Boolean(base.versionId), "immutable base version ID is required");
  requireContract(base.kind !== "empty" || base.files.length === 0, "empty base cannot contain files");
  checkFiles(base.files);
  requireContract(base.manifestDigest === fileManifestDigest(base.files), "base manifest digest mismatch");
  requireContract(approved.specification.status === "approved" && Boolean(approved.specification.confirmedAt), "specification is not approved");
  requireContract(approved.specification.projectId === scope.projectId, "specification belongs to another project");
  requireContract(approved.digest === digest(JSON.stringify(approved.specification)), "approved specification digest mismatch");
  requireContract(approved.planDigest === digest(JSON.stringify(request.design)), "approved plan digest mismatch");
  requireContract(JSON.stringify(request.design.architecture.projection) === JSON.stringify(approved.specification.architecture), "plan projection differs from approved architecture");
  requireContract(Boolean(options.targetProfile) && Number.isSafeInteger(options.maxFiles) && options.maxFiles > 0 && Number.isSafeInteger(options.maxTotalBytes) && options.maxTotalBytes > 0, "generation options are invalid");
  return seal(request);
}

/** Candidate validation is structural; ForgeWeb still owns policy, independent checks, and acceptance. */
export function prepareCandidate(candidate: CandidateArtifacts, request: GenerationRequest): CandidateArtifacts {
  requireContract(candidate.state === "candidate" && Boolean(candidate.id), "candidate identity is required");
  requireContract(candidate.acceptanceState === "unaccepted" && candidate.validationState === "pending", "generation cannot accept or validate a candidate");
  requireContract(JSON.stringify(candidate.actor) === JSON.stringify(request.scope.actor), "candidate owner context mismatch");
  requireContract(candidate.approvedPlanId === request.approved.planId && candidate.bindingDigest === request.approved.bindingDigest, "candidate durable approval mismatch");
  requireContract(Boolean(candidate.engine?.name && candidate.engine.version) && candidate.engine.contractVersion === "forgeweb-generation-v1" && Number.isFinite(Date.parse(candidate.generatedAt)), "candidate provenance is required");
  requireContract(candidate.projectId === request.scope.projectId, "candidate belongs to another project");
  requireContract(candidate.specificationId === request.approved.specification.id, "candidate specification mismatch");
  requireContract(candidate.specificationDigest === request.approved.digest && candidate.planDigest === request.approved.planDigest, "candidate approval digest mismatch");
  const expectedBase = baseReference(request);
  requireContract(candidate.base.kind === expectedBase.kind && candidate.base.manifestDigest === expectedBase.manifestDigest, "candidate base version mismatch");
  if (candidate.base.kind === "version" && expectedBase.kind === "version") {
    requireContract(candidate.base.versionId === expectedBase.versionId, "candidate base version mismatch");
  }
  requireContract(candidate.files.length <= request.options.maxFiles, "candidate exceeds file budget");
  checkFiles(candidate.files);
  const requirementIds = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  const assembledTraceability = (candidate as CandidateArtifacts & {
    readonly assembly?: { readonly traceability?: { readonly untracedFiles?: readonly { readonly path: string; readonly reason: string }[] } };
  }).assembly?.traceability;
  const explicitlyUntraced = new Set((assembledTraceability?.untracedFiles ?? [])
    .filter((entry) => entry.reason === "shared-infrastructure")
    .map((entry) => entry.path.toLowerCase()));
  for (const file of candidate.files) {
    requireContract((file.requirementIds.length > 0 || explicitlyUntraced.has(file.path.toLowerCase()))
      && file.requirementIds.every((id) => requirementIds.has(id)), `file requirement mapping is invalid: ${file.path}`);
  }
  for (const artifact of candidate.artifacts) {
    requireContract(artifact.digest === digest(artifact.content), `artifact digest mismatch: ${artifact.kind}`);
  }
  const byteCount = candidate.files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
    + candidate.artifacts.reduce((total, artifact) => total + Buffer.byteLength(artifact.content), 0);
  requireContract(byteCount <= request.options.maxTotalBytes, "candidate exceeds byte budget");
  requireContract(candidate.manifestDigest === candidateManifestDigest(candidate), "candidate manifest digest mismatch");
  return seal(candidate);
}

export function prepareValidation(validation: CandidateValidation, candidate: CandidateArtifacts): CandidateValidation {
  requireContract(validation.candidateId === candidate.id, "validation targets another candidate");
  const ids = new Set<string>();
  for (const check of validation.checks) {
    requireContract(Boolean(check.id && check.evidence), "validation check needs identity and evidence");
    requireContract(["passed", "failed", "unavailable", "skipped", "blocked"].includes(check.status), "validation status is invalid");
    requireContract(!ids.has(check.id), "duplicate validation check");
    ids.add(check.id);
  }
  return seal(validation);
}
