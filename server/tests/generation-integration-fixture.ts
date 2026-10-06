import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { OwnerVerifier } from "../generation/approval.ts";
import { PlanningApprovalService } from "../generation/approval.ts";
import { fileManifestDigest } from "../generation/contract.ts";
import type { EngineActor, GenerationRequest, PlanningRequest } from "../generation/engine.ts";
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from "../generation/nexarch/adapter.ts";
import { planPrompt } from "../generation/planning.ts";
import type { DisposablePostgresProvider } from "../generation/postgres-validation.ts";
import { CombinedValidationRunner, ForgeWebPostgresValidator } from "../generation/postgres-validation.ts";
import type { SandboxExecutor } from "../generation/runner.ts";
import { ForgeWebIsolatedRunner } from "../generation/runner.ts";
import { JsonStore } from "../store.ts";

export const integrationActor: EngineActor = { kind: "authenticated", subjectId: "integration-owner", ownerId: "integration-owner" };

export const integrationOwnerVerifier: OwnerVerifier = (project, actor) => project.id === "project-integration"
  && actor.kind === "authenticated"
  && actor.subjectId === integrationActor.subjectId
  && actor.ownerId === integrationActor.ownerId;

export function codeExecutor(failurePath?: string): SandboxExecutor {
  return {
    async execute(request) {
      const failed = Boolean(failurePath);
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        policyDigest: request.policyDigest,
        sessionId: failed ? "contract-failed-session" : "contract-passed-session",
        imageDigest: "sha256:contract-test-image",
        checks: [
          { id: "typecheck", status: failed ? "failed" as const : "passed" as const, required: true, evidence: failed ? "contract test typecheck failure" : "contract test typecheck pass", subjectPaths: failurePath ? [failurePath] : [] },
          ...["build", "tests", "startup-health"].map((id) => ({ id, status: "passed" as const, required: true, evidence: `contract test ${id} pass`, subjectPaths: [] })),
        ],
        findings: failed ? [{ code: "TYPECHECK_FAILED", severity: "error" as const, message: "contract test typecheck failure", paths: [failurePath!], requirementIds: [] }] : [],
      };
    },
  };
}

export function disposablePostgresProvider(): DisposablePostgresProvider {
  return {
    async validate(request) {
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        instanceDigest: "sha256:contract-test-postgres",
        schema: { status: "passed", evidence: "contract adapter validated schema" },
        migrations: { status: "passed", evidence: "contract adapter validated migrations" },
      };
    },
  };
}

export function validationRunner(failurePath?: string, postgres = disposablePostgresProvider()): CombinedValidationRunner {
  return new CombinedValidationRunner(new ForgeWebIsolatedRunner(codeExecutor(failurePath)), new ForgeWebPostgresValidator(postgres));
}

export function validationRunnerWithoutPostgres(): CombinedValidationRunner {
  return new CombinedValidationRunner(new ForgeWebIsolatedRunner(codeExecutor()), new ForgeWebPostgresValidator());
}

export async function integrationFixture(): Promise<{ directory: string; store: JsonStore; request: GenerationRequest }> {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-final-integration-"));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.mutate((database) => {
    database.projects["project-integration"] = {
      id: "project-integration",
      slug: "integration",
      name: "Integration",
      status: "awaiting_confirmation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      currentBuildId: "build-integration",
    };
    database.builds["build-integration"] = {
      id: "build-integration",
      projectId: "project-integration",
      status: "awaiting_confirmation",
      currentStageIndex: 1,
      stageDetail: "Planning",
      stages: [],
      taskIds: [],
      filePaths: [],
      reviewFindings: [],
      validationChecks: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  });
  const planningRequest: PlanningRequest = {
    scope: { projectId: "project-integration", buildId: "build-integration", operationId: "operation-integration", actor: integrationActor },
    base: { kind: "empty", projectId: "project-integration", manifestDigest: fileManifestDigest([]), files: [] },
    prompt: "Build a task management application where users create, edit, assign, delete, and track tasks with authentication.",
    databaseDialect: "postgresql",
    options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 300, maxTotalBytes: 3_000_000 },
  };
  const planned = await planPrompt(new NexArchPlanningAdapter(), planningRequest);
  assert.equal(planned.ok, true);
  if (!planned.ok || planned.value.state !== "proposed" || !planned.value.architecture) throw new Error("Integration planning fixture failed");
  const proposal = {
    ...planned.value,
    architecture: {
      ...planned.value.architecture,
      endpoints: planned.value.architecture.endpoints.map((endpoint) => endpoint.path.startsWith("/auth") ? endpoint : { ...endpoint, auth: false, roles: [] }),
    },
  };
  const approvals = new PlanningApprovalService(store, integrationOwnerVerifier);
  const record = await approvals.save(proposal, { kind: "empty", manifestDigest: fileManifestDigest([]) }, planned.engine, planningRequest.options);
  await approvals.approve(record.id, record.digest, "project-integration", integrationActor);
  const request = await approvals.generationRequest(record.id, record.digest, "project-integration", integrationActor);
  return { directory, store, request };
}
