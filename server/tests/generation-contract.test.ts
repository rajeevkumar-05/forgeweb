import assert from "node:assert/strict";
import test from "node:test";
import { baseReference, candidateManifestDigest, fileManifestDigest, prepareCandidate, prepareGenerationRequest, prepareValidation } from "../generation/contract.ts";
import type { CandidateArtifacts, CandidateValidation, EngineFailureCode, EngineFile, EngineResult, GenerationRequest } from "../generation/engine.ts";
import { digest } from "../lib.ts";

function requestWithBase(kind: "empty" | "version" = "version"): GenerationRequest {
  const files: EngineFile[] = kind === "empty" ? [] : [{ path: "README.md", content: "base", digest: digest("base"), requirementIds: ["REQ-001"] }];
  const specification = {
    id: "spec_1",
    projectId: "project_1",
    version: 1,
    status: "approved" as const,
    prompt: "Build a small inventory application.",
    productName: "Inventory",
    summary: "Track items.",
    roles: ["owner"],
    entities: ["Item"],
    requirements: [{ id: "REQ-001", title: "Track items", description: "Create and list items.", acceptanceCriteria: ["Items are listed."], priority: "P0" as const }],
    assumptions: [],
    architecture: {
      systemShape: "single service",
      frontend: { framework: "React", pages: ["Items"], components: [], motion: [] },
      backend: { runtime: "Node", modules: ["items"], apiStyle: "REST", jobs: [] },
      data: { database: "PostgreSQL", entities: ["Item"], rules: [] },
      security: ["owner access"],
      delivery: [],
      diagram: "",
      markdown: "",
      capabilities: [],
    },
    createdAt: "2026-10-05T00:00:00.000Z",
    confirmedAt: "2026-10-05T00:01:00.000Z",
  };
  const base = kind === "empty"
    ? { kind: "empty" as const, projectId: "project_1", manifestDigest: fileManifestDigest(files), files: [] as [] }
    : { kind: "version" as const, projectId: "project_1", versionId: "version_1", manifestDigest: fileManifestDigest(files), files };

  const design = { architecture: { projection: structuredClone(specification.architecture), endpoints: [{ method: "GET", path: "/items", requirementIds: ["REQ-001"] }] }, database: { dialect: "PostgreSQL", entities: [], relationships: [] } };
  return {
    scope: { projectId: "project_1", buildId: "build_1", operationId: "operation_1", actor: { kind: "authenticated", subjectId: "user_1", ownerId: "user_1" } },
    base,
    approved: { specification, digest: digest(JSON.stringify(specification)), planDigest: digest(JSON.stringify(design)), planId: "plan_1", bindingDigest: digest("stored-approval") },
    design,
    options: { targetProfile: "forgeweb-postgresql-v1", maxFiles: 2, maxTotalBytes: 1000 },
  };
}

function candidateFor(request: GenerationRequest): CandidateArtifacts {
  const files = [{ path: "frontend/src/App.tsx", content: "export default function App() { return null; }", digest: digest("export default function App() { return null; }"), requirementIds: ["REQ-001"] }];
  const artifacts = [{ kind: "architecture" as const, format: "json" as const, content: "{}", digest: digest("{}") }];
  const candidate = {
    actor: request.scope.actor,
    approvedPlanId: request.approved.planId,
    bindingDigest: request.approved.bindingDigest,
    engine: { name: "test", version: "1", contractVersion: "forgeweb-generation-v1" as const },
    generatedAt: "2026-10-05T00:00:00Z",
    validationState: "pending" as const,
    acceptanceState: "unaccepted" as const,
    state: "candidate" as const,
    id: "candidate_1",
    projectId: request.scope.projectId,
    specificationId: request.approved.specification.id,
    specificationDigest: request.approved.digest,
    planDigest: request.approved.planDigest,
    base: baseReference(request),
    files,
    artifacts,
    manifestDigest: "",
  };
  return { ...candidate, manifestDigest: candidateManifestDigest(candidate) };
}

test("approved requests carry project identity and an immutable base snapshot", () => {
  const input = requestWithBase();
  const prepared = prepareGenerationRequest(input);
  assert.notEqual(prepared, input);
  assert.equal(prepared.scope.projectId, prepared.base.projectId);
  assert.equal(prepared.base.kind, "version");
  assert.equal(prepared.base.kind === "version" && prepared.base.versionId, "version_1");
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.base.files), true);
  assert.equal(Reflect.set(prepared.base.files[0], "content", "engine mutation"), false);
  assert.equal(prepared.base.files[0].content, "base");
  Reflect.set(input.approved.specification, "productName", "Changed outside the engine");
  assert.equal(prepared.approved.specification.productName, "Inventory");
  assert.equal("currentVersionId" in prepared, false);
  assert.equal("acceptedVersionId" in prepared, false);
});

test("an initial project declares an empty immutable base", () => {
  const prepared = prepareGenerationRequest(requestWithBase("empty"));
  assert.deepEqual(baseReference(prepared), { kind: "empty", manifestDigest: fileManifestDigest([]) });
});

test("requests reject a missing or cross-project base and unapproved specifications", () => {
  const missingVersion = requestWithBase();
  Reflect.set(missingVersion.base, "versionId", "");
  assert.throws(() => prepareGenerationRequest(missingVersion), /base version ID/);

  const foreignBase = requestWithBase();
  Reflect.set(foreignBase.base, "projectId", "project_2");
  assert.throws(() => prepareGenerationRequest(foreignBase), /another project/);

  const unapproved = requestWithBase();
  Reflect.set(unapproved.approved.specification, "status", "proposed");
  assert.throws(() => prepareGenerationRequest(unapproved), /not approved/);

  const tamperedBase = requestWithBase();
  Reflect.set(tamperedBase.base, "manifestDigest", digest("wrong"));
  assert.throws(() => prepareGenerationRequest(tamperedBase), /base manifest digest/);

  const changedPlan = requestWithBase();
  Reflect.set(changedPlan.design.architecture.projection.backend, "runtime", "Other runtime");
  assert.throws(() => prepareGenerationRequest(changedPlan), /approved plan digest/);
});

test("candidate artifacts remain candidates tied to the approved project and base", () => {
  const request = prepareGenerationRequest(requestWithBase());
  const candidate = candidateFor(request);
  const prepared = prepareCandidate(candidate, request);
  assert.equal(prepared.state, "candidate");
  assert.equal(prepared.base.kind, "version");
  assert.equal(prepared.files[0].requirementIds[0], "REQ-001");
  assert.equal(Object.isFrozen(prepared.files[0]), true);
  assert.equal("acceptedVersionId" in prepared, false);

  const foreign = structuredClone(candidate);
  Reflect.set(foreign, "projectId", "project_2");
  assert.throws(() => prepareCandidate(foreign, request), /another project/);

  const wrongBase = structuredClone(candidate);
  Reflect.set(wrongBase.base, "versionId", "version_other");
  assert.throws(() => prepareCandidate(wrongBase, request), /base version mismatch/);

  const wrongApproval = structuredClone(candidate);
  Reflect.set(wrongApproval, "planDigest", digest("different plan"));
  assert.throws(() => prepareCandidate(wrongApproval, request), /approval digest mismatch/);

  const unsafe = structuredClone(candidate);
  Reflect.set(unsafe.files[0], "path", "C:/secrets.txt");
  assert.throws(() => prepareCandidate(unsafe, request), /drive or device/);
});

test("validation evidence retains blocked checks without accepting a version", () => {
  const request = prepareGenerationRequest(requestWithBase());
  const candidate = prepareCandidate(candidateFor(request), request);
  const evidence: CandidateValidation = {
    candidateId: candidate.id,
    checks: [{ id: "generated-typecheck", status: "blocked", required: true, evidence: "Runner unavailable", subjectPaths: ["frontend/src/App.tsx"] }],
    findings: [{ code: "RUNNER_UNAVAILABLE", severity: "error", message: "No isolated runner", paths: [], requirementIds: [] }],
  };
  const prepared = prepareValidation(evidence, candidate);
  assert.equal(prepared.checks[0].status, "blocked");
  assert.equal(prepared.checks[0].required, true);
  assert.equal("acceptedVersionId" in prepared, false);
  assert.throws(() => prepareValidation({ ...evidence, candidateId: "candidate_other" }, candidate), /another candidate/);
});

test("engine errors have distinct failure categories and no acceptance operation", () => {
  const codes: EngineFailureCode[] = ["validation_failure", "generation_failure", "provider_failure", "unsupported_capability", "security_failure", "dependency_failure", "runner_failure", "internal_engine_error"];
  for (const code of codes) {
    const result: EngineResult<never> = { ok: false, error: { code, message: "Sanitized failure", retryable: false, stage: "contract-test" }, engine: { name: "contract-test", version: "0", contractVersion: "forgeweb-generation-v1" } };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal("acceptedVersionId" in result, false);
  }
});
