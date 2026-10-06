import type { CandidateArtifacts, CandidateValidation, EngineResult } from "./engine.ts";
import { candidateManifestDigest } from "./contract.ts";

export const REQUIRED_CHECKS = ["typecheck", "build", "tests", "dependencies", "security", "startup-health"] as const;
export type IsolatedValidationResult = CandidateValidation & {
  readonly manifestDigest: string;
  readonly execution: { readonly kind: "isolated"; readonly sessionId: string; readonly imageDigest: string };
};
export interface IsolatedValidator {
  validate(candidate: CandidateArtifacts): Promise<EngineResult<IsolatedValidationResult>>;
}

export class UnavailableValidator implements IsolatedValidator {
  async validate(_candidate: CandidateArtifacts): Promise<EngineResult<IsolatedValidationResult>> {
    return { ok: false, engine: { name: "forgeweb-validation", version: "1", contractVersion: "forgeweb-generation-v1" }, error: { code: "unsupported_capability", stage: "validation", message: "Isolated generated-code execution is unavailable", retryable: false } };
  }
}

/** Evidence supplied by ForgeWeb's trusted validator/reviewer, never by generation success. No acceptance writes. */
export function candidateReadyForAcceptance(candidate: CandidateArtifacts, validation: IsolatedValidationResult, review: { candidateId: string; manifestDigest: string; passed: boolean }): boolean {
  return candidate.state === "candidate" && candidate.acceptanceState === "unaccepted"
    && candidate.manifestDigest === candidateManifestDigest(candidate)
    && validation.candidateId === candidate.id && validation.manifestDigest === candidate.manifestDigest
    && validation.execution?.kind === "isolated" && Boolean(validation.execution.sessionId && validation.execution.imageDigest)
    && new Set(validation.checks.map((check) => check.id)).size === validation.checks.length
    && REQUIRED_CHECKS.every((id) => validation.checks.some((check) => check.id === id && check.required && check.status === "passed" && Boolean(check.evidence)))
    && validation.checks.every((check) => !check.required || check.status === "passed")
    && !validation.findings.some((finding) => finding.severity === "error")
    && review.candidateId === candidate.id && review.manifestDigest === candidate.manifestDigest && review.passed;
}
