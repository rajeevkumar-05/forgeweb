import type { ForgeDatabase, GenerationCandidateRecord, Project, ProjectVersion, ValidationCheck } from "../domain.ts";
import { digest, id, now } from "../lib.ts";
import { JsonStore } from "../store.ts";
import type { OwnerVerifier } from "./approval.ts";
import { planRecordDigest } from "./approval.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import { candidateOutputDigest } from "./candidate.ts";
import { candidateManifestDigest, fileManifestDigest, prepareCandidate, prepareGenerationRequest } from "./contract.ts";
import type { EngineActor, EngineFailureCode, EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";
import { ForgeWebEngineeringGraphBuilder, verifyEngineeringGraph } from "./engineering-graph.ts";
import type { IsolatedCandidateRunner } from "./validation.ts";
import { ForgeWebCandidateValidator, REQUIRED_CHECKS } from "./validation.ts";

const ACCEPTANCE_ENGINE: EngineMetadata = {
  name: "forgeweb-candidate-acceptance",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

const denyUnverifiedOwner: OwnerVerifier = () => false;

export type CandidateAcceptanceReceipt = {
  readonly candidateId: string;
  readonly projectId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly manifestDigest: string;
  readonly acceptedAt: string;
  readonly idempotent: boolean;
};

export type CandidateRecoveryIdentity = {
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly projectId: string;
  readonly buildId: string;
};

function failure<Value>(code: EngineFailureCode, message: string, diagnosticCode: string): EngineResult<Value> {
  return {
    ok: false,
    engine: ACCEPTANCE_ENGINE,
    error: { code, stage: "candidate-acceptance", message, retryable: false, diagnostics: [{ code: diagnosticCode, message }] },
  };
}

function currentBaseMatches(database: ForgeDatabase, project: Project, candidate: AssembledCandidateArtifacts): boolean {
  if (candidate.base.kind === "empty") {
    return !project.currentVersionId && candidate.base.manifestDigest === fileManifestDigest([]);
  }
  if (project.currentVersionId !== candidate.base.versionId) return false;
  const version = database.versions[candidate.base.versionId];
  const files = database.versionFiles[candidate.base.versionId];
  return version?.projectId === project.id && Boolean(files) && candidate.base.manifestDigest === fileManifestDigest(files);
}

function durableContextError(database: ForgeDatabase, request: GenerationRequest, candidate: AssembledCandidateArtifacts): { code: string; message: string } | undefined {
  const project = database.projects[candidate.projectId];
  if (!project || project.currentBuildId !== request.scope.buildId) return { code: "STALE_BUILD", message: "The candidate build is no longer current" };
  const plan = database.planningRecords?.[candidate.approvedPlanId];
  if (!plan || plan.digest !== candidate.bindingDigest || plan.digest !== planRecordDigest(plan)) return { code: "STALE_PLAN", message: "The approved plan is missing or changed" };
  if (JSON.stringify(plan.options) !== JSON.stringify(request.options)
    || JSON.stringify(plan.proposal.scope) !== JSON.stringify(request.scope)
    || JSON.stringify({ architecture: plan.proposal.architecture, database: plan.proposal.database }) !== JSON.stringify(request.design)) {
    return { code: "APPROVAL_BINDING_MISMATCH", message: "Generation context differs from the approved plan" };
  }
  if (plan.approval?.planDigest !== plan.digest || plan.approval.specificationDigest !== candidate.specificationDigest) return { code: "STALE_APPROVAL", message: "The exact approved plan is no longer authorized" };
  const specification = database.specifications[candidate.specificationId];
  if (!specification || digest(JSON.stringify(specification)) !== candidate.specificationDigest || specification.status !== "approved") return { code: "STALE_SPECIFICATION", message: "The approved specification changed" };
  const build = database.builds[request.scope.buildId];
  if (!build || build.projectId !== project.id || build.planningRecordId !== plan.id || build.specificationId !== specification.id) return { code: "SUPERSEDED_PLAN", message: "The plan or specification was superseded" };
  if (project.currentSpecificationId !== specification.id) return { code: "SUPERSEDED_SPECIFICATION", message: "The project specification was superseded" };
  if (!currentBaseMatches(database, project, candidate)) return { code: "CAS_BASE_CONFLICT", message: "The project current version no longer matches the candidate base" };
  return undefined;
}

function validationReady(record: GenerationCandidateRecord): boolean {
  const validation = record.validation;
  if (!validation || validation.status !== "passed" || validation.candidateId !== record.id || validation.manifestDigest !== record.manifestDigest) return false;
  if (validation.execution.kind !== "isolated" || validation.execution.snapshotDigest !== record.manifestDigest
    || !validation.execution.sessionId || !validation.execution.imageDigest || !validation.execution.policyDigest) return false;
  if (validation.postgres?.kind !== "disposable-postgresql" || validation.postgres.snapshotDigest !== record.manifestDigest
    || !validation.postgres.instanceDigest || !validation.postgres.policyVersion) return false;
  if (validation.findings.some((finding) => finding.severity === "error")) return false;
  if (!REQUIRED_CHECKS.every((id) => validation.checks.some((entry) => entry.id === id && entry.required && entry.status === "passed" && entry.evidence))) return false;
  if (!record.engineeringGraph || record.engineeringGraph.validationStatus !== validation.status) return false;
  return validation.checks.every((entry) => !entry.required || entry.status === "passed");
}

function versionChecks(record: GenerationCandidateRecord): ValidationCheck[] {
  return (record.validation?.checks ?? []).map((entry) => ({
    id: entry.id,
    name: entry.id,
    status: entry.status === "passed" ? "passed" : entry.status === "failed" ? "failed" : "skipped",
    evidence: entry.evidence,
    subjectPaths: [...entry.subjectPaths],
  }));
}

function rejectRecord(record: GenerationCandidateRecord, code: string, message: string, quarantined = false): void {
  record.status = quarantined ? "quarantined" : "rejected";
  record.failure = { code, message };
  record.updatedAt = now();
}

export class CandidateAcceptanceService {
  private readonly store: JsonStore;
  private readonly verifyOwner: OwnerVerifier;
  private readonly validator: ForgeWebCandidateValidator;
  private readonly graphBuilder: ForgeWebEngineeringGraphBuilder;
  private readonly runner?: IsolatedCandidateRunner;

  constructor(store: JsonStore, verifyOwner: OwnerVerifier = denyUnverifiedOwner, runner?: IsolatedCandidateRunner) {
    this.store = store;
    this.verifyOwner = verifyOwner;
    this.runner = runner;
    this.validator = new ForgeWebCandidateValidator();
    this.graphBuilder = new ForgeWebEngineeringGraphBuilder();
  }

  private async authorized(project: Project | undefined, actor: EngineActor): Promise<boolean> {
    return Boolean(project && actor.kind === "authenticated" && actor.subjectId && actor.ownerId
      && await this.verifyOwner(structuredClone(project), structuredClone(actor)));
  }

  /** Internal recovery of an unchanged saved candidate; never generates, repairs or previews. */
  async recoverCandidate(identityInput: CandidateRecoveryIdentity, requestInput: GenerationRequest, actorInput: EngineActor): Promise<EngineResult<CandidateAcceptanceReceipt>> {
    const identity = structuredClone(identityInput);
    const actor = structuredClone(actorInput);
    let request: GenerationRequest;
    try {
      request = prepareGenerationRequest(requestInput);
    } catch {
      return failure("validation_failure", "Recovery requires the exact approved generation request", "INVALID_RECOVERY_REQUEST");
    }

    const preflight = async (): Promise<{ code: string; message: string } | undefined> => {
      const database = this.store.read();
      const matches = Object.values(database.generationCandidates).filter((record) => record.candidateDigest === identity.candidateDigest);
      const record = matches[0];
      if (!/^sha256:[a-f0-9]{64}$/.test(identity.candidateDigest) || matches.length !== 1 || !record
        || record.id !== identity.candidateId || record.projectId !== identity.projectId || record.buildId !== identity.buildId
        || request.scope.projectId !== identity.projectId || request.scope.buildId !== identity.buildId) {
        return { code: "RECOVERY_IDENTITY_MISMATCH", message: "Recovery identity does not uniquely match the saved candidate" };
      }
      const project = database.projects[record.projectId];
      if (!await this.authorized(project, actor) || JSON.stringify(actor) !== JSON.stringify(request.scope.actor)
        || actor.ownerId !== record.ownerId || actor.subjectId !== record.subjectId) {
        return { code: "OWNER_AUTHORIZATION_FAILED", message: "Candidate recovery requires its verified ForgeWeb owner" };
      }
      try {
        prepareCandidate(record.candidate, request);
        if (record.candidate.id !== record.id || record.candidate.projectId !== record.projectId
          || record.approvedPlanId !== record.candidate.approvedPlanId || record.bindingDigest !== record.candidate.bindingDigest
          || record.specificationDigest !== record.candidate.specificationDigest || record.planDigest !== record.candidate.planDigest
          || record.candidateDigest !== candidateOutputDigest(record.candidate)
          || record.manifestDigest !== candidateManifestDigest(record.candidate)
          || record.candidate.assembly.determinism.outputDigest !== record.candidateDigest) throw new TypeError("Candidate changed");
      } catch {
        return { code: "CANDIDATE_INTEGRITY_FAILED", message: "Saved candidate integrity does not match the recovery identity" };
      }
      const contextError = durableContextError(database, request, record.candidate);
      if (record.status === "accepted") {
        // Acceptance legitimately advances the base. Only the already-linked version
        // can satisfy an idempotent recovery; no new CAS promotion is performed.
        if (contextError && contextError.code !== "CAS_BASE_CONFLICT") return contextError;
        const version = record.acceptedVersionId ? database.versions[record.acceptedVersionId] : undefined;
        const files = version ? database.versionFiles[version.id] : undefined;
        if (!version || !files || version.projectId !== record.projectId || version.buildId !== record.buildId
          || version.candidateId !== record.id || version.candidateDigest !== record.candidateDigest
          || version.candidateManifestDigest !== record.manifestDigest || project.currentVersionId !== version.id
          || JSON.stringify(files) !== JSON.stringify(record.candidate.files) || !validationReady(record)) {
          return { code: "ACCEPTED_VERSION_MISMATCH", message: "Existing accepted version does not match the saved candidate" };
        }
        return undefined;
      }
      if (contextError) return contextError;
      if (!["validation_failed", "validation_unavailable", "validated"].includes(record.status)) {
        return { code: "INVALID_RECOVERY_STATE", message: "Candidate is not eligible for validation recovery" };
      }
      if (Object.values(database.versions).some((version) => version.projectId === record.projectId && version.buildId === record.buildId)) {
        return { code: "RECOVERY_VERSION_EXISTS", message: "A ProjectVersion already exists for this build" };
      }
      return undefined;
    };

    const initialError = await preflight();
    if (initialError) return failure("validation_failure", initialError.message, initialError.code);
    if (this.get(identity.candidateId)?.status !== "accepted") {
      const validated = await this.validateCandidate(identity.candidateId, request);
      if (!validated.ok) return validated;
      if (validated.value.status !== "validated") {
        return failure("validation_failure", "Fresh required validation did not pass; recovery was not accepted", "RECOVERY_VALIDATION_NOT_PASSED");
      }
      const finalError = await preflight();
      if (finalError) return failure("validation_failure", finalError.message, finalError.code);
    }
    return this.accept(identity.candidateId, request, actor);
  }

  async saveCandidate(requestInput: GenerationRequest, candidateInput: AssembledCandidateArtifacts): Promise<EngineResult<GenerationCandidateRecord>> {
    let request: GenerationRequest;
    let candidate: AssembledCandidateArtifacts;
    try {
      request = prepareGenerationRequest(requestInput);
      candidate = prepareCandidate(candidateInput, request) as AssembledCandidateArtifacts;
      if (candidate.assembly.determinism.outputDigest !== candidateOutputDigest(candidate)
        || candidate.manifestDigest !== candidateManifestDigest(candidate)) throw new TypeError("Candidate deterministic identity is invalid");
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Candidate is invalid", "INVALID_CANDIDATE");
    }

    return this.store.mutate(async (database) => {
      const project = database.projects[candidate.projectId];
      if (!await this.authorized(project, request.scope.actor)) return failure("security_failure", "Verified ForgeWeb owner authorization is required", "OWNER_AUTHORIZATION_FAILED");
      const contextError = durableContextError(database, request, candidate);
      if (contextError) return failure("validation_failure", contextError.message, contextError.code);
      const existing = database.generationCandidates[candidate.id];
      if (existing) {
        if (existing.candidateDigest !== candidate.assembly.determinism.outputDigest || existing.manifestDigest !== candidate.manifestDigest) {
          rejectRecord(existing, "CANDIDATE_ID_COLLISION", "Candidate identity collides with different content", true);
          return failure("security_failure", "Candidate identity collides with different content", "CANDIDATE_ID_COLLISION");
        }
        return { ok: true, engine: ACCEPTANCE_ENGINE, value: structuredClone(existing) };
      }

      for (const prior of Object.values(database.generationCandidates)) {
        if (prior.projectId === candidate.projectId && prior.buildId === request.scope.buildId && prior.approvedPlanId === candidate.approvedPlanId
          && ["assembled", "validation_unavailable", "validation_failed", "validated"].includes(prior.status)) {
          prior.status = "superseded";
          prior.supersededByCandidateId = candidate.id;
          prior.updatedAt = now();
        }
      }
      const timestamp = now();
      const record: GenerationCandidateRecord = {
        id: candidate.id,
        projectId: candidate.projectId,
        buildId: request.scope.buildId,
        ownerId: request.scope.actor.ownerId!,
        subjectId: request.scope.actor.subjectId,
        status: "assembled",
        candidateDigest: candidate.assembly.determinism.outputDigest,
        manifestDigest: candidate.manifestDigest,
        approvedPlanId: candidate.approvedPlanId,
        bindingDigest: candidate.bindingDigest,
        specificationDigest: candidate.specificationDigest,
        planDigest: candidate.planDigest,
        ...(candidate.base.kind === "version" ? { baseVersionId: candidate.base.versionId } : {}),
        candidate,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      database.generationCandidates[record.id] = structuredClone(record);
      return { ok: true, engine: ACCEPTANCE_ENGINE, value: structuredClone(record) };
    });
  }

  async validateCandidate(candidateId: string, requestInput: GenerationRequest): Promise<EngineResult<GenerationCandidateRecord>> {
    let request: GenerationRequest;
    try {
      request = prepareGenerationRequest(requestInput);
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Validation request is invalid", "INVALID_VALIDATION_REQUEST");
    }
    const snapshot = this.store.read().generationCandidates[candidateId];
    if (!snapshot) return failure("validation_failure", "Candidate does not exist", "CANDIDATE_NOT_FOUND");
    if (!await this.authorized(this.store.read().projects[snapshot.projectId], request.scope.actor)) return failure("security_failure", "Verified ForgeWeb owner authorization is required", "OWNER_AUTHORIZATION_FAILED");
    const validation = await this.validator.validate(request, snapshot.candidate, this.runner);
    if (!validation.ok) return validation;
    let engineeringGraph;
    try {
      engineeringGraph = this.graphBuilder.build(request, snapshot.candidate, validation.value);
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Engineering graph generation failed", "ENGINEERING_GRAPH_FAILED");
    }

    return this.store.mutate(async (database) => {
      const record = database.generationCandidates[candidateId];
      if (!record || record.candidateDigest !== snapshot.candidateDigest || record.status === "superseded" || record.status === "accepted") {
        return failure("validation_failure", "Candidate changed or was superseded during validation", "STALE_CANDIDATE");
      }
      const contextError = durableContextError(database, request, record.candidate);
      if (contextError) {
        rejectRecord(record, contextError.code, contextError.message);
        return failure("validation_failure", contextError.message, contextError.code);
      }
      record.validation = validation.value;
      record.engineeringGraph = engineeringGraph;
      record.validatedAt = now();
      record.updatedAt = record.validatedAt;
      record.status = validation.value.status === "passed" ? "validated" : validation.value.status === "failed" ? "validation_failed" : "validation_unavailable";
      return { ok: true, engine: ACCEPTANCE_ENGINE, value: structuredClone(record) };
    });
  }

  async accept(candidateId: string, requestInput: GenerationRequest, actorInput: EngineActor): Promise<EngineResult<CandidateAcceptanceReceipt>> {
    let request: GenerationRequest;
    const actor = structuredClone(actorInput);
    try {
      request = prepareGenerationRequest(requestInput);
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Acceptance request is invalid", "INVALID_ACCEPTANCE_REQUEST");
    }
    return this.store.mutate(async (database) => {
      const record = database.generationCandidates[candidateId];
      if (!record) return failure("validation_failure", "Candidate does not exist", "CANDIDATE_NOT_FOUND");
      const project = database.projects[record.projectId];
      if (!await this.authorized(project, actor) || JSON.stringify(actor) !== JSON.stringify(request.scope.actor)
        || actor.kind !== "authenticated" || actor.ownerId !== record.ownerId || actor.subjectId !== record.subjectId) {
        return failure("security_failure", "Candidate acceptance requires its verified ForgeWeb owner", "OWNER_AUTHORIZATION_FAILED");
      }
      if (record.status === "accepted" && record.acceptedVersionId) {
        const accepted = database.versions[record.acceptedVersionId];
        if (!accepted || accepted.candidateId !== record.id) return failure("internal_engine_error", "Accepted candidate linkage is corrupt", "ACCEPTED_VERSION_MISSING");
        return { ok: true, engine: ACCEPTANCE_ENGINE, value: { candidateId: record.id, projectId: record.projectId, versionId: accepted.id, versionNumber: accepted.versionNumber, manifestDigest: record.manifestDigest, acceptedAt: record.acceptedAt!, idempotent: true } };
      }
      if (record.status === "superseded") return failure("validation_failure", "Candidate was superseded", "CANDIDATE_SUPERSEDED");
      if (record.status !== "validated" || !validationReady(record)) {
        rejectRecord(record, "VALIDATION_NOT_PASSED", "Required isolated validation evidence is failed or unavailable");
        return failure("validation_failure", "Required isolated validation evidence is failed or unavailable", "VALIDATION_NOT_PASSED");
      }
      try {
        prepareCandidate(record.candidate, request);
        if (record.candidateDigest !== candidateOutputDigest(record.candidate) || record.manifestDigest !== candidateManifestDigest(record.candidate)) throw new TypeError("Candidate digest mismatch");
        verifyEngineeringGraph(record.engineeringGraph!, record.candidate);
        const expectedGraph = this.graphBuilder.build(request, record.candidate, record.validation!);
        if (JSON.stringify(record.engineeringGraph) !== JSON.stringify(expectedGraph)) throw new TypeError("Engineering graph differs from candidate evidence");
      } catch (error) {
        rejectRecord(record, "CANDIDATE_INTEGRITY_FAILED", error instanceof Error ? error.message : "Candidate integrity failed", true);
        return failure("security_failure", "Candidate integrity verification failed", "CANDIDATE_INTEGRITY_FAILED");
      }
      const contextError = durableContextError(database, request, record.candidate);
      if (contextError) {
        rejectRecord(record, contextError.code, contextError.message);
        return failure("validation_failure", contextError.message, contextError.code);
      }

      const versionNumber = Math.max(0, ...Object.values(database.versions).filter((version) => version.projectId === project.id).map((version) => version.versionNumber)) + 1;
      const versionId = id("version");
      const acceptedAt = now();
      const version: ProjectVersion = {
        layout: { profile: "forgeweb-generated-v1", approvedPlanId: record.approvedPlanId },
        id: versionId,
        projectId: project.id,
        buildId: record.buildId,
        versionNumber,
        label: `Accepted generated candidate ${record.id.slice(-8)}`,
        editPrompt: request.approved.specification.prompt,
        modifiedFiles: record.candidate.files.map((file) => file.path),
        ...(record.baseVersionId ? { sourceVersionId: record.baseVersionId } : {}),
        validationStatus: "passed",
        validationChecks: versionChecks(record),
        candidateId: record.id,
        candidateDigest: record.candidateDigest,
        candidateManifestDigest: record.manifestDigest,
        createdAt: acceptedAt,
      };
      database.versions[versionId] = version;
      database.versionFiles[versionId] = record.candidate.files.map((file) => ({ path: file.path, content: file.content, digest: file.digest, requirementIds: [...file.requirementIds] }));
      project.currentVersionId = versionId;
      project.currentVersionNumber = versionNumber;
      project.status = "ready";
      project.updatedAt = acceptedAt;
      record.status = "accepted";
      record.acceptedVersionId = versionId;
      record.acceptedAt = acceptedAt;
      record.updatedAt = acceptedAt;
      return { ok: true, engine: ACCEPTANCE_ENGINE, value: { candidateId: record.id, projectId: record.projectId, versionId, versionNumber, manifestDigest: record.manifestDigest, acceptedAt, idempotent: false } };
    });
  }

  get(candidateId: string): GenerationCandidateRecord | undefined {
    return this.store.read().generationCandidates[candidateId];
  }
}
