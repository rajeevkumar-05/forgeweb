import type { GenerationCandidateRecord } from "../domain.ts";
import { digest } from "../lib.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import { candidateOutputDigest } from "./candidate.ts";
import { candidateManifestDigest, prepareCandidate, prepareGenerationRequest } from "./contract.ts";
import type { EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";

export const REPAIR_POLICY_VERSION = "forgeweb-bounded-repair-v1" as const;
export const MAX_REPAIR_ATTEMPTS = 3;
export const MAX_REPAIR_FILES = 3;
export const MAX_REPAIR_BYTES = 128 * 1024;

const REPAIR_ENGINE: EngineMetadata = {
  name: "forgeweb-bounded-repair",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

export type RepairFileChange = {
  readonly path: string;
  readonly expectedDigest: string;
  readonly content: string;
};

export type BoundedRepairPatch = {
  readonly findingId: string;
  readonly attempt: number;
  readonly changes: readonly RepairFileChange[];
};

function failure(message: string, diagnosticCode: string, path?: string): EngineResult<AssembledCandidateArtifacts> {
  return {
    ok: false,
    engine: REPAIR_ENGINE,
    error: {
      code: diagnosticCode.includes("OWNER") || diagnosticCode.includes("PATH") ? "security_failure" : "validation_failure",
      stage: "bounded-repair",
      message,
      retryable: false,
      diagnostics: [{ code: diagnosticCode, message, ...(path ? { path } : {}) }],
    },
  };
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Applies explicit text patches to an unaccepted, failed candidate. It never writes a workspace or ProjectVersion. */
export class ForgeWebBoundedRepair {
  repair(requestInput: GenerationRequest, recordInput: GenerationCandidateRecord, patchInput: BoundedRepairPatch): EngineResult<AssembledCandidateArtifacts> {
    let request: GenerationRequest;
    let candidate: AssembledCandidateArtifacts;
    const record = structuredClone(recordInput);
    const patch = structuredClone(patchInput);
    try {
      request = prepareGenerationRequest(requestInput);
      candidate = prepareCandidate(record.candidate, request) as AssembledCandidateArtifacts;
      if (record.candidateDigest !== candidateOutputDigest(candidate)
        || record.manifestDigest !== candidate.manifestDigest
        || candidate.manifestDigest !== candidateManifestDigest(candidate)) throw new TypeError("Repair candidate integrity is invalid");
      if (!record.validation || record.validation.candidateId !== candidate.id || record.validation.manifestDigest !== candidate.manifestDigest) {
        throw new TypeError("Repair validation evidence is stale");
      }
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Repair input is invalid", "INVALID_REPAIR_CONTEXT");
    }

    if (record.status !== "validation_failed" || record.acceptedVersionId || candidate.acceptanceState !== "unaccepted") {
      return failure("Only an unaccepted candidate with failed validation can be repaired", "REPAIR_STATE_FORBIDDEN");
    }
    if (record.ownerId !== request.scope.actor.ownerId || record.subjectId !== request.scope.actor.subjectId) {
      return failure("Repair requires the candidate owner context", "REPAIR_OWNER_MISMATCH");
    }
    if (!Number.isSafeInteger(patch.attempt) || patch.attempt < 1 || patch.attempt > MAX_REPAIR_ATTEMPTS) {
      return failure(`Repair attempt must be between 1 and ${MAX_REPAIR_ATTEMPTS}`, "REPAIR_ATTEMPT_LIMIT");
    }
    const expectedAttempt = (candidate.assembly.repair?.attempt ?? 0) + 1;
    if (patch.attempt !== expectedAttempt) return failure(`Repair attempt must be ${expectedAttempt}`, "REPAIR_ATTEMPT_SEQUENCE");
    if (!patch.findingId || patch.changes.length < 1 || patch.changes.length > MAX_REPAIR_FILES) {
      return failure(`Repair must target between 1 and ${MAX_REPAIR_FILES} files for one finding`, "REPAIR_SCOPE_LIMIT");
    }

    const matchingFindings = record.validation?.findings.filter((finding) => finding.code === patch.findingId) ?? [];
    if (matchingFindings.length !== 1) return failure("Repair finding is missing or ambiguous", "REPAIR_FINDING_INVALID");
    const finding = matchingFindings[0];
    if (finding.paths.length === 0) return failure("Validation finding has no safely targetable files", "REPAIR_FINDING_UNBOUNDED");
    const allowed = new Set(finding.paths);
    const files = new Map(candidate.files.map((file) => [file.path, { ...file, requirementIds: [...file.requirementIds] }]));
    const seen = new Set<string>();
    let changedBytes = 0;
    for (const change of patch.changes) {
      if (!allowed.has(change.path)) return failure("Repair path is not explicitly named by the validation finding", "REPAIR_PATH_NOT_TARGETED", change.path);
      const key = change.path.toLowerCase();
      if (seen.has(key)) return failure("Repair contains a duplicate or case-colliding path", "REPAIR_PATH_COLLISION", change.path);
      seen.add(key);
      const original = files.get(change.path);
      if (!original) return failure("Repair cannot add or rename files", "REPAIR_PATH_MISSING", change.path);
      if (original.digest !== change.expectedDigest) return failure("Repair target changed after the finding was recorded", "REPAIR_TARGET_STALE", change.path);
      if (typeof change.content !== "string" || change.content === original.content) return failure("Repair content must explicitly change the target file", "REPAIR_CONTENT_INVALID", change.path);
      changedBytes += Buffer.byteLength(change.content);
      files.set(change.path, { ...original, content: change.content, digest: digest(change.content) });
    }
    if (changedBytes > MAX_REPAIR_BYTES) return failure(`Repair exceeds the ${MAX_REPAIR_BYTES}-byte change budget`, "REPAIR_BYTE_LIMIT");

    const repairedFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
    const candidateWithoutIdentity: AssembledCandidateArtifacts = {
      ...candidate,
      id: "",
      files: repairedFiles,
      manifestDigest: candidateManifestDigest({ files: repairedFiles, artifacts: candidate.artifacts }),
      assembly: {
        ...candidate.assembly,
        repair: {
          baseCandidateId: candidate.id,
          findingId: patch.findingId,
          attempt: patch.attempt,
          modifiedFiles: patch.changes.map((change) => change.path).sort(),
        },
        determinism: { ...candidate.assembly.determinism, outputDigest: "" },
      },
    };
    const outputDigest = candidateOutputDigest(candidateWithoutIdentity);
    const repaired: AssembledCandidateArtifacts = {
      ...candidateWithoutIdentity,
      id: `candidate_${outputDigest.slice(0, 24)}`,
      assembly: {
        ...candidateWithoutIdentity.assembly,
        determinism: { ...candidateWithoutIdentity.assembly.determinism, outputDigest },
      },
    };
    try {
      return { ok: true, engine: REPAIR_ENGINE, value: freezeTree(prepareCandidate(repaired, request) as AssembledCandidateArtifacts) };
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Repaired candidate failed normal candidate gates", "REPAIRED_CANDIDATE_INVALID");
    }
  }
}
