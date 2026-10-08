import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Build, BuildView, Project, ValidationCheck } from "../domain.ts";
import { ApiError, assertPrompt, id, now, slugify } from "../lib.ts";
import { JsonStore } from "../store.ts";
import { setBuildStatus } from "../build-state.ts";
import { PlanningApprovalService, type OwnerVerifier } from "./approval.ts";
import { fileManifestDigest } from "./contract.ts";
import type { EngineActor } from "./engine.ts";
import { NexArchPlanningAdapter } from "./nexarch/adapter.ts";
import { ForgeWebSafeGenerationWorkflow, type SafeGenerationWorkflowOptions, type SafeGenerationWorkflowResult } from "./pipeline.ts";
import { planPrompt } from "./planning.ts";
import { APPLICATION_TARGET } from "./targets.ts";
import type { SafePreviewResponse } from "./preview-contract.ts";
import { safeExecutionDiagnostics } from "./runner.ts";

const SESSION_COOKIE = "forgeweb_safe_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type SafeGenerationActivationConfig = {
  readonly enabled: boolean;
  readonly token: string;
  readonly ownerId: string;
  readonly subjectId: string;
  readonly secureCookies?: boolean;
};

export type SafeGenerationStatus = {
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly target: typeof APPLICATION_TARGET.profile;
  readonly isolatedValidation: "configured" | "unavailable";
  readonly disposablePostgresql: "configured" | "unavailable";
  readonly trustedRuntime: "configured" | "unavailable";
};

export type SafeGenerationConfirmation = {
  readonly build: BuildView;
  readonly generation: {
    readonly status: SafeGenerationWorkflowResult["status"];
    readonly stage: SafeGenerationWorkflowResult["stage"];
    readonly candidateId?: string;
    readonly validation: "passed" | "failed" | "unavailable" | "not-run";
    readonly runtime: "ready" | "unavailable" | "not-run";
  };
};

type Session = { actor: EngineActor & { kind: "authenticated" }; expiresAt: number };

function configured(config: SafeGenerationActivationConfig): boolean {
  return config.enabled && config.token.length >= 32 && Boolean(config.ownerId.trim()) && Boolean(config.subjectId.trim());
}

function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(secretDigest(left), secretDigest(right));
}

function cookieValue(request: IncomingMessage): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === SESSION_COOKIE) {
      try { return decodeURIComponent(value.join("=")); }
      catch { return undefined; }
    }
  }
  return undefined;
}

function publicChecks(result: SafeGenerationWorkflowResult): ValidationCheck[] {
  return (result.record?.validation?.checks ?? []).map((check) => ({
    id: check.id,
    name: check.id,
    status: check.status === "passed" ? "passed" : check.status === "failed" ? "failed" : "skipped",
    evidence: check.evidence,
    subjectPaths: [...check.subjectPaths],
  }));
}

function validationStatus(result: SafeGenerationWorkflowResult): SafeGenerationConfirmation["generation"]["validation"] {
  if (result.status === "accepted") return "passed";
  if (result.status === "validation_failed") return "failed";
  if (result.status === "validation_unavailable") return "unavailable";
  return "not-run";
}

function failureMessage(result: SafeGenerationWorkflowResult): string {
  if (result.status === "validation_failed") {
    const checks = result.record?.validation?.checks.filter(check => check.required && check.status === "failed")
      .map(check => check.id).filter(id => /^[a-z][a-z0-9-]{0,63}$/.test(id)) ?? [];
    return `Candidate validation failed${checks.length ? `: ${checks.join(", ")}` : ""}. No ProjectVersion was created.`;
  }
  if (result.status === "validation_unavailable") {
    const operations = safeExecutionDiagnostics(result.record?.validation?.executionDiagnostics);
    const timeout = operations.findLast(operation => operation.timedOut);
    if (timeout) return `Isolated validation timed out during ${timeout.operation}. No ProjectVersion was created.`;
    if (operations.some(operation => operation.classification === "engine_unavailable")) {
      return "The local Docker engine is unavailable. Required validation could not run; no ProjectVersion was created.";
    }
    return "Candidate assembled, but required isolated execution and disposable PostgreSQL evidence are unavailable. No ProjectVersion was created.";
  }
  return result.error?.message ?? `The verified generation workflow stopped during ${result.stage}.`;
}

export function safeGenerationConfigFromEnvironment(): SafeGenerationActivationConfig {
  return {
    enabled: process.env.FORGEWEB_SAFE_GENERATION_ENABLED === "true",
    token: process.env.FORGEWEB_SAFE_GENERATION_TOKEN?.trim() ?? "",
    ownerId: process.env.FORGEWEB_SAFE_GENERATION_OWNER_ID?.trim() ?? "",
    subjectId: process.env.FORGEWEB_SAFE_GENERATION_SUBJECT_ID?.trim() ?? "",
    secureCookies: process.env.NODE_ENV === "production",
  };
}

export class SafeGenerationActivationService {
  private readonly sessions = new Map<string, Session>();
  private readonly store: JsonStore;
  private readonly config: SafeGenerationActivationConfig;
  private readonly workflowOptions: SafeGenerationWorkflowOptions;
  private readonly approval: PlanningApprovalService;
  private readonly pipeline: ForgeWebSafeGenerationWorkflow;
  private readonly planner = new NexArchPlanningAdapter();
  private readonly active: boolean;

  constructor(
    store: JsonStore,
    config: SafeGenerationActivationConfig,
    workflowOptions: SafeGenerationWorkflowOptions = {},
  ) {
    this.store = store;
    this.config = config;
    this.workflowOptions = workflowOptions;
    this.active = configured(config);
    const verifyOwner: OwnerVerifier = (project, actor) => {
      const build = project.currentBuildId ? this.store.read().builds[project.currentBuildId] : undefined;
      if (!this.active || build?.generationMode !== "safe" || actor.kind !== "authenticated") return false;
      if (project.ownerId && actor.ownerId === project.ownerId && actor.subjectId === project.ownerId) return true;
      return (!project.ownerId || project.ownershipClaim?.source === "local-migration")
        && actor.ownerId === this.config.ownerId && actor.subjectId === this.config.subjectId;
    };
    this.approval = new PlanningApprovalService(store, verifyOwner);
    this.pipeline = new ForgeWebSafeGenerationWorkflow(store, verifyOwner, workflowOptions);
  }

  status(request: IncomingMessage, userId?: string): SafeGenerationStatus {
    return {
      enabled: this.active,
      authenticated: Boolean(userId && this.optionalActor(request)?.ownerId === userId),
      target: APPLICATION_TARGET.profile,
      isolatedValidation: this.workflowOptions.validationRunner ? "configured" : "unavailable",
      disposablePostgresql: this.workflowOptions.validationRunner ? "configured" : "unavailable",
      trustedRuntime: this.workflowOptions.runtimeExecutor ? "configured" : "unavailable",
    };
  }

  authenticate(token: unknown, userId?: string): { cookie: string } {
    if (!this.active) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
    if (typeof token !== "string" || !equalSecret(token, this.config.token)) {
      throw new ApiError(401, "SAFE_AUTHENTICATION_FAILED", "The verified generation activation token is invalid.");
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      actor: { kind: "authenticated", subjectId: userId ?? this.config.subjectId, ownerId: userId ?? this.config.ownerId },
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    const secure = this.config.secureCookies ? "; Secure" : "";
    return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${SESSION_TTL_MS / 1000}${secure}` };
  }

  optionalActor(request: IncomingMessage): Session["actor"] | undefined {
    const sessionId = cookieValue(request);
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return structuredClone(session.actor);
  }

  requireActor(request: IncomingMessage, userId?: string): Session["actor"] {
    if (!this.active) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
    const actor = this.optionalActor(request);
    if (!actor) throw new ApiError(401, "SAFE_AUTHENTICATION_REQUIRED", "Authenticate before using the verified generation workflow.");
    if (userId && (actor.ownerId !== userId || actor.subjectId !== userId)) throw new ApiError(403, "SAFE_SESSION_OWNER_MISMATCH", "Verified authorization belongs to another ForgeWeb session.");
    return actor;
  }

  logout(request: IncomingMessage): void {
    const sessionId = cookieValue(request);
    if (sessionId) this.sessions.delete(sessionId);
  }

  canClaimLegacy(project: Project): boolean {
    const database = this.store.read();
    const builds = Object.values(database.builds).filter(build => build.projectId === project.id && build.generationMode === "safe");
    return Boolean(this.config.ownerId && this.config.subjectId) && builds.length > 0 && builds.every(build => {
      const actor = build.planningRecordId ? database.planningRecords?.[build.planningRecordId]?.proposal.scope.actor : undefined;
      return actor?.kind === "authenticated" && actor.ownerId === this.config.ownerId && actor.subjectId === this.config.subjectId;
    });
  }

  async stopProjectPreview(projectId: string): Promise<void> {
    const executor = this.workflowOptions.runtimeExecutor;
    if (executor && !executor.stopProject) throw new ApiError(503, "RUNTIME_CLEANUP_UNAVAILABLE", "Project runtime cleanup is unavailable; the project was not deleted.");
    try { await executor?.stopProject?.(projectId); }
    catch { throw new ApiError(503, "RUNTIME_CLEANUP_FAILED", "The preview could not be fully stopped; project records were preserved. Try again."); }
  }

  actorForBuild(buildId: string, authorizedActor: EngineActor): EngineActor {
    const build = this.view(buildId);
    if (build.project.ownerId !== authorizedActor.ownerId) throw new ApiError(403, "OWNER_AUTHORIZATION_FAILED", "This build belongs to another project owner.");
    const actor = build.planningRecordId ? this.store.read().planningRecords?.[build.planningRecordId]?.proposal.scope.actor : undefined;
    if (actor && build.project.ownershipClaim?.source === "local-migration" && this.canClaimLegacy(build.project)) return structuredClone(actor);
    return authorizedActor;
  }

  previewForOwner(projectId: string, versionId: string, userId: string): Promise<SafePreviewResponse> {
    const database = this.store.read();
    const project = database.projects[projectId];
    if (!project || project.ownerId !== userId) throw new ApiError(403, "OWNER_AUTHORIZATION_FAILED", "This preview belongs to another project owner.");
    let actor: EngineActor = { kind: "authenticated", ownerId: userId, subjectId: userId };
    if (project.ownershipClaim?.source === "local-migration" && this.canClaimLegacy(project)) {
      const version = database.versions[versionId];
      const record = version?.projectId === projectId && version.candidateId ? database.generationCandidates[version.candidateId] : undefined;
      if (record) actor = { kind: "authenticated", ownerId: record.ownerId, subjectId: record.subjectId };
    }
    return this.previewAccepted(projectId, versionId, actor);
  }

  async previewAccepted(projectId: string, versionId: string, actor: EngineActor): Promise<SafePreviewResponse> {
    if (!this.active) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
    const result = await this.pipeline.previewAccepted(projectId, versionId, actor);
    if (!result.ok) {
      const code = result.error.diagnostics?.[0]?.code ?? "RUNTIME_PREVIEW_FAILED";
      const status = code === "OWNER_AUTHORIZATION_FAILED" ? 403 : code.startsWith("RUNTIME_") ? 503 : 409;
      throw new ApiError(status, code, result.error.message);
    }
    const preview = result.value;
    if (preview.status === "ready" && (!Number.isSafeInteger(preview.execution.expiresAt) || preview.execution.expiresAt! <= Date.now())) {
      throw new ApiError(503, "RUNTIME_SESSION_EXPIRED", "The preview session has expired or its expiry could not be verified. Try again.");
    }
    // Capabilities are returned only to this authenticated request, never stored in builds.
    return preview.status === "ready"
      ? { status: "ready", versionId: preview.versionId, previewUrl: preview.execution.previewUrl, expiresAt: preview.execution.expiresAt! }
      : { status: "unavailable" as const, versionId: preview.versionId, message: preview.reason };
  }

  isSafeBuild(build: Pick<Build, "generationMode">): boolean {
    return build.generationMode === "safe";
  }

  requireBuildAccess(request: IncomingMessage, build: BuildView): void {
    if (!this.isSafeBuild(build)) return;
    const actor = this.requireActor(request);
    const record = build.planningRecordId ? this.store.read().planningRecords?.[build.planningRecordId] : undefined;
    if (!record || JSON.stringify(record.proposal.scope.actor) !== JSON.stringify(actor)) {
      throw new ApiError(403, "OWNER_AUTHORIZATION_FAILED", "This verified build belongs to another owner context.");
    }
  }

  requireProjectAccess(request: IncomingMessage, project: Project): void {
    if (!project.currentBuildId) return;
    const build = this.store.read().builds[project.currentBuildId];
    if (!build || build.generationMode !== "safe") return;
    this.requireBuildAccess(request, this.view(build.id));
  }

  visibleProjects(request: IncomingMessage, projects: Project[]): Project[] {
    const actor = this.optionalActor(request);
    const database = this.store.read();
    return projects.filter((project) => {
      const build = project.currentBuildId ? database.builds[project.currentBuildId] : undefined;
      if (build?.generationMode !== "safe") return true;
      const record = build.planningRecordId ? database.planningRecords?.[build.planningRecordId] : undefined;
      return Boolean(actor && record && JSON.stringify(record.proposal.scope.actor) === JSON.stringify(actor));
    });
  }

  async create(promptValue: unknown, actorInput: EngineActor): Promise<BuildView> {
    if (!this.active) throw new ApiError(404, "SAFE_GENERATION_DISABLED", "The verified generation workflow is not enabled.");
    const prompt = assertPrompt(promptValue);
    const actor = structuredClone(actorInput);
    const user = actor.ownerId ? this.store.read().users?.[actor.ownerId] : undefined;
    if (actor.kind !== "authenticated" || !(user && actor.ownerId === user.id && actor.subjectId === user.id)
      && !(actor.ownerId === this.config.ownerId && actor.subjectId === this.config.subjectId)) {
      throw new ApiError(403, "OWNER_AUTHORIZATION_FAILED", "Verified ForgeWeb owner authorization is required.");
    }

    const projectId = id("project");
    const buildId = id("build");
    const request = {
      scope: { projectId, buildId, operationId: id("operation"), actor },
      base: { kind: "empty" as const, projectId, manifestDigest: fileManifestDigest([]), files: [] as const },
      prompt,
      databaseDialect: "postgresql" as const,
      options: { targetProfile: APPLICATION_TARGET.profile, maxFiles: 300, maxTotalBytes: 3_000_000 },
    };
    const planned = await planPrompt(this.planner, request);
    if (!planned.ok) throw new ApiError(422, "SAFE_PLANNING_FAILED", planned.error.message);
    if (planned.value.state !== "proposed") {
      throw new ApiError(422, "SAFE_PLANNING_NEEDS_CONTEXT", planned.value.analysis.questions.join(" ") || "The planning engine needs more context.");
    }

    const timestamp = now();
    const productName = planned.value.analysis.facets?.productName ?? "ForgeWeb Application";
    const project: Project = {
      id: projectId,
      ...(user ? { ownerId: user.id } : {}),
      slug: `${slugify(productName)}-${projectId.slice(-5)}`,
      name: productName,
      status: "awaiting_confirmation",
      originalPrompt: prompt,
      createdAt: timestamp,
      updatedAt: timestamp,
      currentBuildId: buildId,
    };
    const build: Build = {
      generationMode: "safe",
      id: buildId,
      projectId,
      status: "awaiting_confirmation",
      currentStageIndex: 1,
      stageDetail: "PostgreSQL architecture and requirements are ready for confirmation. No source has been generated.",
      stages: [],
      taskIds: [],
      filePaths: [],
      reviewFindings: [],
      validationChecks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.projects[projectId] = project;
      database.builds[buildId] = build;
      database.events[buildId] = [
        { id: id("event"), buildId, type: "build.created", message: "Verified build accepted for planning.", timestamp },
        { id: id("event"), buildId, type: "build.awaiting_confirmation", message: build.stageDetail, timestamp },
      ];
    });
    try {
      await this.approval.save(planned.value, { kind: "empty", manifestDigest: fileManifestDigest([]) }, planned.engine, request.options);
    } catch (error) {
      await this.store.mutate((database) => {
        delete database.projects[projectId];
        delete database.builds[buildId];
        delete database.events[buildId];
      });
      throw error;
    }
    return this.view(buildId);
  }

  async confirm(buildId: string, actorInput: EngineActor): Promise<SafeGenerationConfirmation> {
    const actor = structuredClone(actorInput);
    const current = this.view(buildId);
    if (current.generationMode !== "safe" || current.status !== "awaiting_confirmation" || !current.planningRecordId) {
      throw new ApiError(409, "INVALID_BUILD_STATE", "The verified build is not awaiting approval.");
    }
    const record = this.store.read().planningRecords?.[current.planningRecordId];
    if (!record || JSON.stringify(record.proposal.scope.actor) !== JSON.stringify(actor)) {
      throw new ApiError(403, "OWNER_AUTHORIZATION_FAILED", "This verified build belongs to another owner context.");
    }
    await this.approval.approve(record.id, record.digest, current.projectId, actor);
    const generationRequest = await this.approval.generationRequest(record.id, record.digest, current.projectId, actor);
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      setBuildStatus(build, "generating");
      build.stageDetail = "Exact plan approved. Generating isolated backend and frontend candidate slices.";
      build.updatedAt = now();
      database.projects[build.projectId].status = "building";
      database.projects[build.projectId].updatedAt = build.updatedAt;
      database.events[buildId].push({ id: id("event"), buildId, type: "build.confirmed", message: build.stageDetail, timestamp: build.updatedAt });
    });

    const result = await this.pipeline.runApproved(generationRequest, actor);
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      build.validationChecks = publicChecks(result);
      build.updatedAt = now();
      if (result.status === "accepted" && result.acceptance) {
        setBuildStatus(build, "reviewing");
        setBuildStatus(build, "validating");
        setBuildStatus(build, "completed");
        build.completedAt = build.updatedAt;
        build.filePaths = (database.versionFiles[result.acceptance.versionId] ?? []).map((file) => file.path);
        build.stageDetail = result.preview?.status === "ready"
          ? "Candidate accepted and trusted runtime preview is ready."
          : "Candidate accepted after successful validation. Runtime preview is unavailable; use Open Preview to try again.";
        database.events[buildId].push({ id: id("event"), buildId, type: "build.completed", message: build.stageDetail, timestamp: build.updatedAt });
      } else {
        setBuildStatus(build, "failed");
        const unavailable = result.status === "validation_unavailable";
        build.error = {
          code: unavailable ? "VALIDATION_UNAVAILABLE" : result.status === "validation_failed" ? "VALIDATION_FAILED" : "SAFE_GENERATION_FAILED",
          message: failureMessage(result),
        };
        build.stageDetail = build.error.message;
        const project = database.projects[build.projectId];
        project.status = result.status.startsWith("validation_") ? "validation_failed" : "failed";
        project.updatedAt = build.updatedAt;
        database.events[buildId].push({ id: id("event"), buildId, type: "build.failed", message: build.stageDetail, timestamp: build.updatedAt });
      }
    });
    return {
      build: this.view(buildId),
      generation: {
        status: result.status,
        stage: result.stage,
        ...(result.candidateId ? { candidateId: result.candidateId } : {}),
        validation: validationStatus(result),
        runtime: result.preview?.status ?? "not-run",
      },
    };
  }

  view(buildId: string): BuildView {
    const database = this.store.read();
    const build = database.builds[buildId];
    if (!build) throw new ApiError(404, "BUILD_NOT_FOUND", "Build was not found.");
    return {
      ...build,
      project: database.projects[build.projectId],
      specification: build.specificationId ? database.specifications[build.specificationId] : undefined,
      events: database.events[buildId] ?? [],
    };
  }
}
