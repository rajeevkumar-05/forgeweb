import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CandidateAcceptanceService } from "../generation/acceptance.ts";
import { PlanningApprovalService } from "../generation/approval.ts";
import { CandidateAssembler } from "../generation/candidate.ts";
import type { AssembledCandidateArtifacts } from "../generation/candidate.ts";
import { fileManifestDigest } from "../generation/contract.ts";
import type { EngineActor, EngineMetadata, GenerationRequest } from "../generation/engine.ts";
import { NexArchBackendAdapter } from "../generation/nexarch/backend-adapter.ts";
import { generateBackend } from "../generation/nexarch/upstream/modules/backend-generator/backend-generator.service.ts";
import { NexArchFrontendAdapter } from "../generation/nexarch/frontend-adapter.ts";
import type { PlanningSpecification } from "../generation/planning.ts";
import { CombinedValidationRunner, ForgeWebPostgresValidator } from "../generation/postgres-validation.ts";
import type { DisposablePostgresProvider } from "../generation/postgres-validation.ts";
import { ForgeWebIsolatedRunner } from "../generation/runner.ts";
import type { SandboxExecutor } from "../generation/runner.ts";
import { APPLICATION_TARGET, databaseTargetContract } from "../generation/targets.ts";
import { JsonStore } from "../store.ts";

const actor: EngineActor = { kind: "authenticated", subjectId: "user-accept", ownerId: "owner-accept" };
const engine: EngineMetadata = { name: "acceptance-fixture", version: "1", contractVersion: "forgeweb-generation-v1" };
const prompt = "Build a task management application where members create, edit, assign, delete, and track tasks.";

function proposal(): PlanningSpecification {
  return {
    state: "proposed",
    scope: { projectId: "project-accept", buildId: "build-accept", operationId: "operation-accept", actor },
    prompt,
    databaseDialect: "postgresql",
    files: [],
    analysis: { questions: [], proposedRequirements: [{ title: "Manage tasks", description: "Create and track tasks", priority: "P0", acceptanceCriteria: ["Members can manage tasks"] }] },
    architecture: {
      endpoints: [],
      projection: {
        systemShape: "single service",
        frontend: { framework: "React", pages: ["Tasks"], components: [], motion: [] },
        backend: { runtime: "Node", modules: ["Tasks"], apiStyle: "REST", jobs: [] },
        data: { database: "PostgreSQL", entities: ["Task"], rules: [] },
        security: ["Authenticated access"], delivery: [], diagram: "", markdown: "Task plan", capabilities: [],
      },
    },
    database: {
      dialect: "PostgreSQL",
      target: databaseTargetContract(APPLICATION_TARGET),
      entities: [{ name: "Task", fields: [{ name: "id", type: "UUID", prismaType: "String", prismaNativeType: "@db.Uuid", nullable: false, primaryKey: true, defaultExpression: "gen_random_uuid()" }] }],
      relationships: [],
    },
  };
}

function ownerVerifier(project: { id: string }, principal: EngineActor): boolean {
  return project.id === "project-accept" && principal.kind === "authenticated" && principal.subjectId === actor.subjectId && principal.ownerId === actor.ownerId;
}

function successfulRunner(): CombinedValidationRunner {
  const executor: SandboxExecutor = {
    async execute(request) {
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        policyDigest: request.policyDigest,
        sessionId: "isolated-acceptance-session",
        imageDigest: "sha256:immutable-validation-image",
        checks: ["typecheck", "build", "tests", "startup-health"].map((id) => ({ id, status: "passed" as const, required: true, evidence: `${id} passed in isolated fixture`, subjectPaths: [] })),
        findings: [],
      };
    },
  };
  const postgres: DisposablePostgresProvider = {
    async validate(request) {
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        instanceDigest: "sha256:disposable-postgres",
        schema: { status: "passed", evidence: "schema validated on disposable PostgreSQL" },
        migrations: { status: "passed", evidence: "migration dry run passed on disposable PostgreSQL" },
      };
    },
  };
  return new CombinedValidationRunner(new ForgeWebIsolatedRunner(executor), new ForgeWebPostgresValidator(postgres));
}

function failingRunner(): CombinedValidationRunner {
  const executor: SandboxExecutor = {
    async execute(request) {
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        policyDigest: request.policyDigest,
        sessionId: "isolated-failing-session",
        imageDigest: "sha256:immutable-validation-image",
        checks: [
          { id: "typecheck", status: "failed", required: true, evidence: "generated typecheck failed", subjectPaths: [] },
          ...["build", "tests", "startup-health"].map((id) => ({ id, status: "passed" as const, required: true, evidence: `${id} passed`, subjectPaths: [] })),
        ],
        findings: [{ code: "TYPECHECK_FAILED", severity: "error" as const, message: "generated typecheck failed", paths: [], requirementIds: [] }],
      };
    },
  };
  const postgres: DisposablePostgresProvider = {
    async validate(request) {
      return { candidateId: request.candidateId, snapshotDigest: request.snapshotDigest, instanceDigest: "sha256:disposable-postgres", schema: { status: "passed", evidence: "schema passed" }, migrations: { status: "passed", evidence: "migrations passed" } };
    },
  };
  return new CombinedValidationRunner(new ForgeWebIsolatedRunner(executor), new ForgeWebPostgresValidator(postgres));
}

async function generateCandidate(request: GenerationRequest, variant = false): Promise<AssembledCandidateArtifacts> {
  const backendAdapter = variant
    ? new NexArchBackendAdapter((...args) => {
        const project = generateBackend(...args);
        return { ...project, files: project.files.map((file) => file.path === "README.md" ? { ...file, content: `${file.content}\nVariant generator evidence.\n` } : file) };
      })
    : new NexArchBackendAdapter();
  const backend = await backendAdapter.generate(request);
  if (!backend.ok) throw new Error(backend.error.message);
  assert.equal(backend.ok, true);
  const frontend = await new NexArchFrontendAdapter().generate(request, backend.value);
  if (!frontend.ok) throw new Error(frontend.error.message);
  assert.equal(frontend.ok, true);
  const assembled = new CandidateAssembler().assemble(request, backend, frontend);
  if (!assembled.ok) throw new Error(assembled.error.message);
  assert.equal(assembled.ok, true);
  return assembled.value;
}

async function fixture(runner = successfulRunner()) {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-acceptance-"));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.mutate((database) => {
    database.projects["project-accept"] = { id: "project-accept", slug: "accept", name: "Acceptance", status: "awaiting_confirmation", createdAt: "now", updatedAt: "now", currentBuildId: "build-accept" };
    database.builds["build-accept"] = { id: "build-accept", projectId: "project-accept", status: "awaiting_confirmation", currentStageIndex: 1, stageDetail: "Planning", stages: [], taskIds: [], filePaths: [], reviewFindings: [], validationChecks: [], createdAt: "now", updatedAt: "now" };
  });
  const options = { targetProfile: APPLICATION_TARGET.profile, maxFiles: 300, maxTotalBytes: 3_000_000 };
  const approvals = new PlanningApprovalService(store, ownerVerifier);
  const record = await approvals.save(proposal(), { kind: "empty", manifestDigest: fileManifestDigest([]) }, engine, options);
  await approvals.approve(record.id, record.digest, "project-accept", actor);
  const request = await approvals.generationRequest(record.id, record.digest, "project-accept", actor);
  const candidate = await generateCandidate(request);
  const acceptance = new CandidateAcceptanceService(store, ownerVerifier, runner);
  const saved = await acceptance.saveCandidate(request, candidate);
  assert.equal(saved.ok, true);
  return { directory, store, request, candidate, acceptance, record, approvals };
}

async function validate(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const result = await f.acceptance.validateCandidate(f.candidate.id, f.request);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "validated");
}

test("validated candidate is atomically promoted to a linked ProjectVersion", async () => {
  const f = await fixture();
  try {
    await validate(f);
    const result = await f.acceptance.accept(f.candidate.id, f.request, actor);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const database = f.store.read();
    assert.equal(database.projects["project-accept"].currentVersionId, result.value.versionId);
    assert.equal(database.versions[result.value.versionId].candidateId, f.candidate.id);
    assert.equal(database.versions[result.value.versionId].candidateDigest, f.candidate.assembly.determinism.outputDigest);
    assert.deepEqual(database.versionFiles[result.value.versionId], f.candidate.files);
    assert.equal(database.generationCandidates[f.candidate.id].status, "accepted");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("wrong owner cannot accept or mutate a validated candidate", async () => {
  const f = await fixture();
  try {
    await validate(f);
    const before = f.store.read();
    const result = await f.acceptance.accept(f.candidate.id, f.request, { kind: "authenticated", subjectId: "attacker", ownerId: "attacker" });
    assert.equal(result.ok, false);
    assert.deepEqual(f.store.read(), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("stale plan and changed specification are rejected without replacing the accepted version", async (t) => {
  for (const change of ["plan", "specification"] as const) {
    await t.test(change, async () => {
      const f = await fixture();
      try {
        await validate(f);
        await f.store.mutate((database) => {
          if (change === "plan") Reflect.set(database.planningRecords![f.record.id].proposal, "prompt", "changed after validation");
          else database.specifications[f.request.approved.specification.id].summary = "changed after validation";
        });
        const result = await f.acceptance.accept(f.candidate.id, f.request, actor);
        assert.equal(result.ok, false);
        assert.equal(f.store.read().projects["project-accept"].currentVersionId, undefined);
      } finally { await rm(f.directory, { recursive: true, force: true }); }
    });
  }
});

test("a newer candidate supersedes an older candidate", async () => {
  const f = await fixture();
  try {
    await validate(f);
    const newer = await generateCandidate(f.request, true);
    assert.notEqual(newer.id, f.candidate.id);
    const saved = await f.acceptance.saveCandidate(f.request, newer);
    assert.equal(saved.ok, true);
    assert.equal(f.store.read().generationCandidates[f.candidate.id].status, "superseded");
    const result = await f.acceptance.accept(f.candidate.id, f.request, actor);
    assert.equal(result.ok, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("CAS rejects a stale base and preserves the competing current version", async () => {
  const f = await fixture();
  try {
    await validate(f);
    await f.store.mutate((database) => {
      database.versions.competing = { id: "competing", projectId: "project-accept", buildId: "build-accept", versionNumber: 1, label: "Competing", editPrompt: "", modifiedFiles: [], validationStatus: "passed", validationChecks: [], createdAt: "now" };
      database.versionFiles.competing = [];
      database.projects["project-accept"].currentVersionId = "competing";
      database.projects["project-accept"].currentVersionNumber = 1;
    });
    const result = await f.acceptance.accept(f.candidate.id, f.request, actor);
    assert.equal(result.ok, false);
    assert.equal(f.store.read().projects["project-accept"].currentVersionId, "competing");
    assert.equal(Object.keys(f.store.read().versions).length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("failed and unavailable validation cannot satisfy acceptance", async (t) => {
  await t.test("failed", async () => {
    const f = await fixture(failingRunner());
    try {
      const validation = await f.acceptance.validateCandidate(f.candidate.id, f.request);
      assert.equal(validation.ok, true);
      if (validation.ok) assert.equal(validation.value.status, "validation_failed");
      const accepted = await f.acceptance.accept(f.candidate.id, f.request, actor);
      assert.equal(accepted.ok, false);
      assert.equal(f.store.read().projects["project-accept"].currentVersionId, undefined);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  await t.test("unavailable", async () => {
    const f = await fixture(undefined);
    try {
      const acceptance = new CandidateAcceptanceService(f.store, ownerVerifier);
      const validation = await acceptance.validateCandidate(f.candidate.id, f.request);
      assert.equal(validation.ok, true);
      if (validation.ok) assert.equal(validation.value.status, "validation_unavailable");
      const accepted = await acceptance.accept(f.candidate.id, f.request, actor);
      assert.equal(accepted.ok, false);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});

test("duplicate and competing acceptance are idempotent under the store CAS", async () => {
  const f = await fixture();
  try {
    await validate(f);
    const [first, second] = await Promise.all([
      f.acceptance.accept(f.candidate.id, f.request, actor),
      f.acceptance.accept(f.candidate.id, f.request, actor),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(first.value.versionId, second.value.versionId);
    assert.equal([first.value.idempotent, second.value.idempotent].filter(Boolean).length, 1);
    assert.equal(Object.keys(f.store.read().versions).length, 1);
    const duplicate = await f.acceptance.accept(f.candidate.id, f.request, actor);
    assert.equal(duplicate.ok, true);
    if (duplicate.ok) assert.equal(duplicate.value.idempotent, true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("fabricated or stale validation evidence is rejected", async () => {
  const f = await fixture();
  try {
    await validate(f);
    await f.store.mutate((database) => {
      const validation = database.generationCandidates[f.candidate.id].validation!;
      if (validation.execution.kind === "isolated") Reflect.set(validation.execution, "snapshotDigest", "fabricated");
    });
    const result = await f.acceptance.accept(f.candidate.id, f.request, actor);
    assert.equal(result.ok, false);
    assert.equal(f.store.read().projects["project-accept"].currentVersionId, undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("persisted validated candidate survives restart and can be recovered for acceptance", async () => {
  const f = await fixture();
  try {
    await validate(f);
    const reopened = new JsonStore(f.directory);
    await reopened.initialize();
    const service = new CandidateAcceptanceService(reopened, ownerVerifier, successfulRunner());
    assert.equal(service.get(f.candidate.id)?.status, "validated");
    const result = await service.accept(f.candidate.id, f.request, actor);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(reopened.read().projects["project-accept"].currentVersionId, result.value.versionId);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("malformed candidate path is quarantined before persistence and workspace state is unchanged", async () => {
  const f = await fixture();
  try {
    const malformed = structuredClone(f.candidate);
    Reflect.set(malformed.files[0], "path", "../control-plane.json");
    const before = f.store.read();
    const result = await f.acceptance.saveCandidate(f.request, malformed);
    assert.equal(result.ok, false);
    assert.deepEqual(f.store.read(), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
