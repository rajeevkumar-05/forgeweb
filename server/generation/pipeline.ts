import type { GenerationCandidateRecord } from "../domain.ts";
import { JsonStore } from "../store.ts";
import type { OwnerVerifier } from "./approval.ts";
import type { CandidateAcceptanceReceipt } from "./acceptance.ts";
import { CandidateAcceptanceService } from "./acceptance.ts";
import type { BackendGenerationService, BackendSlice } from "./backend.ts";
import { CandidateAssembler } from "./candidate.ts";
import { prepareGenerationRequest } from "./contract.ts";
import type { EngineActor, EngineFailure, GenerationRequest } from "./engine.ts";
import type { EngineeringEvidenceGraph } from "./engineering-graph.ts";
import type { FrontendGenerationService, FrontendSlice } from "./frontend.ts";
import { NexArchBackendAdapter } from "./nexarch/backend-adapter.ts";
import { NexArchFrontendAdapter } from "./nexarch/frontend-adapter.ts";
import type { BoundedRepairPatch } from "./repair.ts";
import { ForgeWebBoundedRepair } from "./repair.ts";
import type { RuntimePreviewExecutor, RuntimePreviewResult } from "./runtime-preview.ts";
import { AcceptedRuntimePreviewService } from "./runtime-preview.ts";
import type { IsolatedCandidateRunner } from "./validation.ts";

export type SafeGenerationWorkflowStage = "request" | "backend" | "frontend" | "candidate" | "validation" | "acceptance" | "preview";

export type SafeGenerationWorkflowResult = {
  readonly status: "accepted" | "validation_failed" | "validation_unavailable" | "failed";
  readonly stage: SafeGenerationWorkflowStage;
  readonly candidateId?: string;
  readonly record?: GenerationCandidateRecord;
  readonly graph?: EngineeringEvidenceGraph;
  readonly acceptance?: CandidateAcceptanceReceipt;
  readonly preview?: RuntimePreviewResult;
  readonly error?: EngineFailure | { readonly code: "INVALID_WORKFLOW_REQUEST" | "PREVIEW_FAILED"; readonly stage: string; readonly message: string; readonly retryable: false };
};

export type SafeGenerationWorkflowOptions = {
  readonly backend?: BackendGenerationService;
  readonly frontend?: FrontendGenerationService;
  readonly validationRunner?: IsolatedCandidateRunner;
  readonly runtimeExecutor?: RuntimePreviewExecutor;
};

function failed(stage: SafeGenerationWorkflowStage, error: SafeGenerationWorkflowResult["error"], candidateId?: string): SafeGenerationWorkflowResult {
  return { status: "failed", stage, ...(candidateId ? { candidateId } : {}), error };
}

/**
 * Internal orchestration for an already-approved generation request. It is not
 * wired to public routes; approval creation remains a separate user action.
 */
export class ForgeWebSafeGenerationWorkflow {
  private readonly backend: BackendGenerationService;
  private readonly frontend: FrontendGenerationService;
  private readonly acceptance: CandidateAcceptanceService;
  private readonly preview: AcceptedRuntimePreviewService;
  private readonly repairer = new ForgeWebBoundedRepair();
  private readonly assembler = new CandidateAssembler();

  constructor(store: JsonStore, verifyOwner: OwnerVerifier, options: SafeGenerationWorkflowOptions = {}) {
    this.backend = options.backend ?? new NexArchBackendAdapter();
    this.frontend = options.frontend ?? new NexArchFrontendAdapter();
    this.acceptance = new CandidateAcceptanceService(store, verifyOwner, options.validationRunner);
    this.preview = new AcceptedRuntimePreviewService(store, verifyOwner, options.runtimeExecutor);
  }

  previewAccepted(projectId: string, versionId: string, actor: EngineActor) {
    return this.preview.preview(projectId, versionId, actor);
  }

  private async promote(request: GenerationRequest, actor: EngineActor, candidateId: string): Promise<SafeGenerationWorkflowResult> {
    const validated = await this.acceptance.validateCandidate(candidateId, request);
    if (!validated.ok) return failed("validation", validated.error, candidateId);
    const graph = validated.value.engineeringGraph;
    if (validated.value.status !== "validated") {
      return {
        status: validated.value.status === "validation_failed" ? "validation_failed" : "validation_unavailable",
        stage: "validation",
        candidateId,
        record: validated.value,
        ...(graph ? { graph } : {}),
      };
    }

    const accepted = await this.acceptance.accept(candidateId, request, actor);
    if (!accepted.ok) return failed("acceptance", accepted.error, candidateId);
    const preview = await this.preview.preview(accepted.value.projectId, accepted.value.versionId, actor);
    if (!preview.ok) {
      return {
        status: "accepted",
        stage: "preview",
        candidateId,
        record: this.acceptance.get(candidateId),
        ...(graph ? { graph } : {}),
        acceptance: accepted.value,
        error: { code: "PREVIEW_FAILED", stage: "runtime-preview", message: preview.error.message, retryable: false },
      };
    }
    return {
      status: "accepted",
      stage: "preview",
      candidateId,
      record: this.acceptance.get(candidateId),
      ...(graph ? { graph } : {}),
      acceptance: accepted.value,
      preview: preview.value,
    };
  }

  async runApproved(requestInput: GenerationRequest, actorInput: EngineActor): Promise<SafeGenerationWorkflowResult> {
    let request: GenerationRequest;
    const actor = structuredClone(actorInput);
    try {
      request = prepareGenerationRequest(requestInput);
      if (JSON.stringify(actor) !== JSON.stringify(request.scope.actor)) throw new TypeError("Workflow actor differs from the approved owner context");
    } catch (error) {
      return failed("request", { code: "INVALID_WORKFLOW_REQUEST", stage: "generation-workflow", message: error instanceof Error ? error.message : "Workflow request is invalid", retryable: false });
    }

    const backend = await this.backend.generate(request);
    if (!backend.ok) return failed("backend", backend.error);
    const frontend = await this.frontend.generate(request, backend.value);
    if (!frontend.ok) return failed("frontend", frontend.error);
    const candidate = this.assembler.assemble(request, backend, frontend);
    if (!candidate.ok) return failed("candidate", candidate.error);
    const saved = await this.acceptance.saveCandidate(request, candidate.value);
    if (!saved.ok) return failed("candidate", saved.error, candidate.value.id);
    return this.promote(request, actor, saved.value.id);
  }

  async repairAndRetry(requestInput: GenerationRequest, actorInput: EngineActor, candidateId: string, patch: BoundedRepairPatch): Promise<SafeGenerationWorkflowResult> {
    let request: GenerationRequest;
    const actor = structuredClone(actorInput);
    try {
      request = prepareGenerationRequest(requestInput);
      if (JSON.stringify(actor) !== JSON.stringify(request.scope.actor)) throw new TypeError("Workflow actor differs from the approved owner context");
    } catch (error) {
      return failed("request", { code: "INVALID_WORKFLOW_REQUEST", stage: "repair-workflow", message: error instanceof Error ? error.message : "Repair request is invalid", retryable: false }, candidateId);
    }
    const original = this.acceptance.get(candidateId);
    if (!original) return failed("candidate", { code: "INVALID_WORKFLOW_REQUEST", stage: "repair-workflow", message: "Repair candidate does not exist", retryable: false }, candidateId);
    const repaired = this.repairer.repair(request, original, patch);
    if (!repaired.ok) return failed("candidate", repaired.error, candidateId);
    const saved = await this.acceptance.saveCandidate(request, repaired.value);
    if (!saved.ok) return failed("candidate", saved.error, repaired.value.id);
    return this.promote(request, actor, saved.value.id);
  }
}

export type { BackendSlice, FrontendSlice };
