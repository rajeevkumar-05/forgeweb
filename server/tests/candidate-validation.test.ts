import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BackendSlice } from "../generation/backend.ts";
import { CandidateAssembler, candidateOutputDigest } from "../generation/candidate.ts";
import type { AssembledCandidateArtifacts } from "../generation/candidate.ts";
import { fileManifestDigest } from "../generation/contract.ts";
import type { EngineResult, GenerationRequest, PlanningRequest } from "../generation/engine.ts";
import type { FrontendSlice } from "../generation/frontend.ts";
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from "../generation/nexarch/adapter.ts";
import { NexArchBackendAdapter } from "../generation/nexarch/backend-adapter.ts";
import { NexArchFrontendAdapter } from "../generation/nexarch/frontend-adapter.ts";
import { planPrompt } from "../generation/planning.ts";
import { ForgeWebCandidateValidator, ISOLATED_CHECKS } from "../generation/validation.ts";
import type { IsolatedCandidateRunner } from "../generation/validation.ts";
import { digest } from "../lib.ts";
import { JsonStore } from "../store.ts";

const PROMPT = "Build a task management application where users create, edit, assign, delete, and track tasks with authentication.";
const ENGINE = { name: "fixture", version: "1", contractVersion: "forgeweb-generation-v1" as const };
type SuccessfulResult<Value> = Extract<EngineResult<Value>, { readonly ok: true }>;

async function requestFixture(): Promise<GenerationRequest> {
  const planning: PlanningRequest = {
    scope: { projectId: "project-candidate", buildId: "build-candidate", operationId: "operation-candidate", actor: { kind: "authenticated", subjectId: "owner-1", ownerId: "owner-1" } },
    base: { kind: "empty", projectId: "project-candidate", manifestDigest: fileManifestDigest([]), files: [] },
    prompt: PROMPT,
    databaseDialect: "postgresql",
    options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 300, maxTotalBytes: 3_000_000 },
  };
  const planned = await planPrompt(new NexArchPlanningAdapter(), planning);
  assert.equal(planned.ok, true);
  if (!planned.ok || !planned.value.architecture || !planned.value.database) throw new Error("Planning fixture failed");
  const architecture = {
    ...planned.value.architecture,
    endpoints: planned.value.architecture.endpoints.map((endpoint) => endpoint.path.startsWith("/auth") ? endpoint : { ...endpoint, auth: false, roles: [] }),
  };
  const specification: GenerationRequest["approved"]["specification"] = {
    id: "spec-candidate",
    projectId: planning.scope.projectId,
    version: 1,
    status: "approved",
    prompt: PROMPT,
    productName: planned.value.analysis.facets?.productName ?? "Task Manager",
    summary: PROMPT,
    roles: [...(planned.value.analysis.facets?.roles ?? [])],
    entities: planned.value.database.entities.map((entity) => entity.name),
    requirements: planned.value.analysis.proposedRequirements.map((requirement, index) => ({ ...requirement, acceptanceCriteria: [...requirement.acceptanceCriteria], id: `REQ-${String(index + 1).padStart(3, "0")}` })),
    assumptions: [...(planned.value.analysis.facets?.missingRequirements ?? [])],
    architecture: architecture.projection,
    createdAt: "2026-01-01T00:00:00.000Z",
    confirmedAt: "2026-01-02T03:04:05.000Z",
  };
  const design = { architecture, database: planned.value.database };
  return {
    scope: planning.scope,
    base: planning.base,
    options: planning.options,
    design,
    approved: {
      planId: "plan-candidate",
      bindingDigest: "binding-candidate",
      specification,
      digest: digest(JSON.stringify(specification)),
      planDigest: digest(JSON.stringify(design)),
    },
  };
}

async function slices(request: GenerationRequest): Promise<{ backend: SuccessfulResult<BackendSlice>; frontend: SuccessfulResult<FrontendSlice> }> {
  const backend = await new NexArchBackendAdapter().generate(request);
  if (!backend.ok) throw new Error(backend.error.message);
  assert.equal(backend.ok, true);
  const frontend = await new NexArchFrontendAdapter().generate(request, backend.value);
  if (!frontend.ok) throw new Error(frontend.error.message);
  assert.equal(frontend.ok, true);
  return { backend, frontend };
}

async function candidateFixture(requestInput?: GenerationRequest): Promise<{ request: GenerationRequest; backend: SuccessfulResult<BackendSlice>; frontend: SuccessfulResult<FrontendSlice>; candidate: AssembledCandidateArtifacts }> {
  const request = requestInput ?? await requestFixture();
  const generated = await slices(request);
  const assembled = new CandidateAssembler().assemble(request, generated.backend, generated.frontend);
  if (!assembled.ok) throw new Error(assembled.error.message);
  assert.equal(assembled.ok, true);
  return { request, ...generated, candidate: assembled.value };
}

test("Phase 4D assembles immutable candidate artifacts with preserved manifests and PostgreSQL metadata", async () => {
  const { request, backend, frontend, candidate } = await candidateFixture();
  assert.equal(backend.ok, true);
  assert.equal(frontend.ok, true);
  if (!backend.ok || !frontend.ok) return;
  assert.ok(candidate.files.some((file) => file.path.startsWith("backend/")));
  assert.ok(candidate.files.some((file) => file.path.startsWith("frontend/")));
  assert.equal(candidate.assembly.target.database.provider, "postgresql");
  assert.equal(candidate.assembly.target.database.target.prisma.provider, "postgresql");
  assert.deepEqual(candidate.assembly.dependencies.backend, backend.value.dependencies);
  assert.deepEqual(candidate.assembly.dependencies.frontend, frontend.value.dependencies);
  assert.deepEqual(candidate.assembly.capabilities.backendRoutes, backend.value.routes);
  assert.deepEqual(candidate.assembly.capabilities.frontendApi, frontend.value.api);
  assert.equal(candidate.acceptanceState, "unaccepted");
  assert.equal(candidate.validationState, "pending");
  assert.equal("acceptedVersionId" in candidate, false);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(candidate.projectId, request.scope.projectId);
});

test("candidate identity and output are deterministic", async () => {
  const request = await requestFixture();
  const generated = await slices(request);
  const assembler = new CandidateAssembler();
  const first = assembler.assemble(request, generated.backend, generated.frontend);
  const second = assembler.assemble(structuredClone(request), structuredClone(generated.backend), structuredClone(generated.frontend));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
  assert.equal(first.value.assembly.determinism.outputDigest, candidateOutputDigest(first.value));
  assert.equal(first.value.id, `candidate_${first.value.assembly.determinism.outputDigest.slice(0, 24)}`);
});

test("candidate assembly rejects cross-slice collisions and unsafe paths", async (t) => {
  const request = await requestFixture();
  const generated = await slices(request);
  assert.equal(generated.backend.ok, true);
  assert.equal(generated.frontend.ok, true);
  if (!generated.backend.ok || !generated.frontend.ok) return;

  await t.test("cross-slice collision", () => {
    const frontend = structuredClone(generated.frontend);
    if (!frontend.ok) return;
    Reflect.set(frontend.value.files[0], "path", generated.backend.value.files[0].path.toUpperCase());
    const result = new CandidateAssembler().assemble(request, generated.backend, frontend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "CROSS_SLICE_COLLISION");
  });

  await t.test("unsafe path", () => {
    const backend = structuredClone(generated.backend);
    if (!backend.ok) return;
    Reflect.set(backend.value.files[0], "path", "C:/outside.ts");
    const result = new CandidateAssembler().assemble(request, backend, generated.frontend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.diagnostics?.[0]?.code ?? "", /PATH/);
  });
});

test("combined candidate file and byte budgets are enforced after individually valid slices", async (t) => {
  const initial = await candidateFixture();
  assert.equal(initial.backend.ok, true);
  assert.equal(initial.frontend.ok, true);
  if (!initial.backend.ok || !initial.frontend.ok) return;

  await t.test("file budget", async () => {
    const request = { ...initial.request, options: { ...initial.request.options, maxFiles: Math.max(initial.backend.value.files.length, initial.frontend.value.files.length) } };
    const generated = await slices(request);
    const result = new CandidateAssembler().assemble(request, generated.backend, generated.frontend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /file budget/);
  });

  await t.test("byte budget", async () => {
    const backendBytes = initial.backend.value.files.reduce((total, file) => total + file.bytes, 0);
    const frontendBytes = initial.frontend.value.files.reduce((total, file) => total + file.bytes, 0);
    const request = { ...initial.request, options: { ...initial.request.options, maxTotalBytes: Math.max(backendBytes, frontendBytes) } };
    const generated = await slices(request);
    const result = new CandidateAssembler().assemble(request, generated.backend, generated.frontend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /byte budget/);
  });
});

test("failed backend or frontend results never produce a candidate", async () => {
  const request = await requestFixture();
  const generated = await slices(request);
  const failedBackend: EngineResult<BackendSlice> = { ok: false, engine: ENGINE, error: { code: "generation_failure", stage: "backend", message: "backend failed", retryable: false } };
  const failedFrontend: EngineResult<FrontendSlice> = { ok: false, engine: ENGINE, error: { code: "generation_failure", stage: "frontend", message: "frontend failed", retryable: false } };
  const assembler = new CandidateAssembler();
  assert.equal(assembler.assemble(request, failedBackend, generated.frontend).ok, false);
  assert.equal(assembler.assemble(request, generated.backend, failedFrontend).ok, false);
});

test("candidate traceability preserves approved mappings and explicit shared infrastructure", async () => {
  const { request, candidate } = await candidateFixture();
  const approved = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  const untraced = new Set(candidate.assembly.traceability.untracedFiles.map((entry) => entry.path));
  assert.equal(candidate.assembly.traceability.files.length, candidate.files.length);
  assert.ok(candidate.files.every((file) => file.requirementIds.every((id) => approved.has(id))));
  assert.ok(candidate.files.filter((file) => file.requirementIds.length === 0).every((file) => untraced.has(file.path)));
});

test("Phase 4E static validation records unavailable execution without treating it as success", async () => {
  const { request, candidate } = await candidateFixture();
  const result = await new ForgeWebCandidateValidator().validate(request, candidate);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "unavailable", JSON.stringify(result.value.checks.filter((entry) => entry.status === "failed")));
  assert.equal(result.value.execution.kind, "not-run");
  assert.ok(result.value.checks.filter((entry) => ISOLATED_CHECKS.includes(entry.id as typeof ISOLATED_CHECKS[number])).every((entry) => entry.status === "unavailable"));
  assert.ok(result.value.checks.filter((entry) => !ISOLATED_CHECKS.includes(entry.id as typeof ISOLATED_CHECKS[number]) && entry.required).every((entry) => entry.status === "passed"));
});

test("an isolated runner seam can supply explicit passing evidence", async () => {
  const { request, candidate } = await candidateFixture();
  const runner: IsolatedCandidateRunner = {
    async validate(value) {
      return {
        ok: true,
        engine: ENGINE,
        value: {
          candidateId: value.id,
          manifestDigest: value.manifestDigest,
          execution: { kind: "isolated", sessionId: "disposable-session", imageDigest: "sha256:isolated-image", snapshotDigest: value.manifestDigest, policyDigest: "sha256:test-policy" },
          postgres: { kind: "disposable-postgresql", policyVersion: "test-policy", snapshotDigest: value.manifestDigest, instanceDigest: "sha256:test-postgres" },
          checks: ISOLATED_CHECKS.map((id) => ({ id, status: "passed", required: true, evidence: `isolated ${id} evidence`, subjectPaths: [] })),
          findings: [],
        },
      };
    },
  };
  const result = await new ForgeWebCandidateValidator().validate(request, candidate, runner);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "passed", JSON.stringify(result.value.checks.filter((entry) => entry.status === "failed")));
  assert.equal(result.value.execution.kind, "isolated");
});

test("a generic runner cannot self-assert disposable PostgreSQL success", async () => {
  const { request, candidate } = await candidateFixture();
  const runner: IsolatedCandidateRunner = {
    async validate(value) {
      return {
        ok: true,
        engine: ENGINE,
        value: {
          candidateId: value.id,
          manifestDigest: value.manifestDigest,
          execution: { kind: "isolated", sessionId: "generic-session", imageDigest: "sha256:isolated-image", snapshotDigest: value.manifestDigest, policyDigest: "sha256:test-policy" },
          checks: ISOLATED_CHECKS.map((id) => ({ id, status: "passed", required: true, evidence: `generic runner claimed ${id}`, subjectPaths: [] })),
          findings: [],
        },
      };
    },
  };
  const result = await new ForgeWebCandidateValidator().validate(request, candidate, runner);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "unavailable");
  assert.equal(result.value.checks.find((entry) => entry.id === "postgresql-runtime")?.status, "unavailable");
  assert.ok(result.value.findings.some((finding) => finding.code === "POSTGRESQL_ATTESTATION_UNAVAILABLE"));
});

test("stale candidates and malformed artifacts fail static validation before execution", async (t) => {
  const { request, candidate } = await candidateFixture();
  await t.test("stale candidate", async () => {
    const stale = structuredClone(candidate);
    Reflect.set(stale, "approvedPlanId", "superseded-plan");
    const result = await new ForgeWebCandidateValidator().validate(request, stale);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.status, "failed");
      assert.equal(result.value.checks.find((entry) => entry.id === "approved-context")?.status, "failed");
    }
  });
  await t.test("malformed artifact", async () => {
    const malformed = structuredClone(candidate);
    Reflect.set(malformed.artifacts[0], "content", "tampered");
    const result = await new ForgeWebCandidateValidator().validate(request, malformed);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.status, "failed");
      assert.equal(result.value.checks.find((entry) => entry.id === "manifest-consistency")?.status, "failed");
    }
  });
});

test("assembly and validation do not mutate the workspace or an accepted version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-candidate-boundary-"));
  try {
    const store = new JsonStore(directory);
    await store.initialize();
    const before = store.read();
    const { request, candidate } = await candidateFixture();
    const requestBefore = structuredClone(request);
    const validation = await new ForgeWebCandidateValidator().validate(request, candidate);
    assert.equal(validation.ok, true);
    assert.deepEqual(store.read(), before);
    assert.deepEqual(request, requestBefore);
    assert.equal(candidate.acceptanceState, "unaccepted");
    assert.equal("currentVersionId" in candidate, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
