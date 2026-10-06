import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";
import { ProjectWorkspaceService } from "../project-workspace.ts";
import { digest } from "../lib.ts";
import { PlanningApprovalService } from "../generation/approval.ts";
import { APPLICATION_TARGET, databaseTargetContract, requireApplicationTarget } from "../generation/targets.ts";
import { planPrompt } from "../generation/planning.ts";
import type { PlanningSpecification } from "../generation/planning.ts";
import type { CandidateArtifacts, EngineActor, EngineMetadata, GenerationRequest, PlanningRequest } from "../generation/engine.ts";
import { baseReference, candidateManifestDigest, fileManifestDigest, prepareCandidate } from "../generation/contract.ts";
import { candidateReadyForAcceptance, REQUIRED_CHECKS, UnavailableValidator } from "../generation/validation.ts";
import type { IsolatedValidationResult } from "../generation/validation.ts";
import { layoutCompatibility } from "../generation/layout.ts";

const actor: EngineActor = { kind: "authenticated", subjectId: "user-1", ownerId: "owner-1" };
const engine: EngineMetadata = { name: "contract-fixture", version: "1", contractVersion: "forgeweb-generation-v1" };
const options = { targetProfile: APPLICATION_TARGET.profile, maxFiles: 20, maxTotalBytes: 100_000 };
const base = { kind: "empty" as const, manifestDigest: fileManifestDigest([]) };

// Hand-authored PostgreSQL contract fixture, not output from NexArch.
function proposal(): PlanningSpecification {
  return {
    state: "proposed", scope: { projectId: "p1", buildId: "b1", operationId: "op1", actor },
    prompt: "Manage tasks with authorized team members.", databaseDialect: "postgresql", files: [],
    analysis: { questions: [], proposedRequirements: [{ title: "Manage tasks", description: "Track tasks", priority: "P0", acceptanceCriteria: ["Authorized members can list tasks"] }] },
    architecture: { endpoints: [], projection: {
      systemShape: "single service", frontend: { framework: "React", pages: ["Tasks"], components: [], motion: [] },
      backend: { runtime: "Node", modules: ["Tasks"], apiStyle: "REST", jobs: [] }, data: { database: "PostgreSQL", entities: ["Task"], rules: [] },
      security: ["Authenticated access"], delivery: [], diagram: "", markdown: "Task plan", capabilities: [],
    } },
    database: { dialect: "PostgreSQL", target: databaseTargetContract(APPLICATION_TARGET), entities: [{ name: "Task", fields: [{ name: "id", type: "UUID", nullable: false, defaultExpression: "gen_random_uuid()" }] }], relationships: [] },
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-gates-"));
  const store = new JsonStore(directory);
  await store.initialize();
  await store.mutate((db) => {
    db.projects.p1 = { id: "p1", slug: "p1", name: "Tasks", status: "awaiting_confirmation", createdAt: "now", updatedAt: "now", currentBuildId: "b1" };
    db.builds.b1 = { id: "b1", projectId: "p1", status: "awaiting_confirmation", currentStageIndex: 1, stageDetail: "Proposed", stages: [], taskIds: [], filePaths: [], reviewFindings: [], validationChecks: [], createdAt: "now", updatedAt: "now" };
  });
  const verifier = (project: { id: string }, principal: EngineActor) => project.id === "p1" && principal.kind === "authenticated" && principal.ownerId === "owner-1" && principal.subjectId === "user-1";
  return { directory, store, verifier, service: new PlanningApprovalService(store, verifier) };
}

test("canonical PostgreSQL target rejects missing and mismatched dialects before approval", async () => {
  assert.doesNotThrow(() => requireApplicationTarget(proposal()));
  for (const dialect of [undefined, "mysql8"]) {
    const plan = proposal();
    Reflect.set(plan, "databaseDialect", dialect);
    assert.throws(() => requireApplicationTarget(plan), /UNSUPPORTED_DATABASE_TARGET/);
  }
  const plan = proposal();
  Reflect.set(plan.database!, "dialect", "MySQL 8");
  assert.throws(() => requireApplicationTarget(plan), /UNSUPPORTED_DATABASE_TARGET/);
  const relabeledMySql = proposal();
  Reflect.set(relabeledMySql.database!.entities[0].fields[0], "type", "CHAR(36)");
  Reflect.set(relabeledMySql.database!.entities[0].fields[0], "defaultExpression", "UUID()");
  assert.throws(() => requireApplicationTarget(relabeledMySql), /UNSUPPORTED_DATABASE_TARGET/);
  const mismatchedProvider = proposal();
  Reflect.set(mismatchedProvider.database!.target, "provider", "mysql");
  assert.throws(() => requireApplicationTarget(mismatchedProvider), /UNSUPPORTED_DATABASE_TARGET/);
  const result = await planPrompt({
    analyzeRequirements: async () => { throw new Error("must not run"); },
    planArchitecture: async () => { throw new Error("must not run"); },
    designDatabase: async () => { throw new Error("must not run"); },
  }, { databaseDialect: undefined } as unknown as PlanningRequest);
  assert.equal(result.ok, false);
});

test("approval survives restart, identifies exact plan and cannot start legacy generation", async () => {
  const f = await fixture();
  try {
    const record = await f.service.save(proposal(), base, engine, options);
    await f.service.approve(record.id, record.digest, "p1", actor);
    const reopened = new JsonStore(f.directory);
    await reopened.initialize();
    const service = new PlanningApprovalService(reopened, f.verifier);
    const request = await service.generationRequest(record.id, record.digest, "p1", actor);
    assert.equal(request.approved.planId, record.id);
    assert.equal(request.approved.bindingDigest, record.digest);
    assert.equal(Object.isFrozen(request.design), true);
    assert.equal(reopened.read().builds.b1.status, "awaiting_confirmation");
    assert.equal(reopened.read().projects.p1.currentVersionId, undefined);
    assert.deepEqual(reopened.read().files, {});
    await assert.rejects(() => new BuildWorkflow(reopened).confirm("b1"), { code: "PLANNING_GENERATION_UNAVAILABLE" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("owner authorization is denied by default and cannot be claimed by engine context", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => new PlanningApprovalService(f.store).save(proposal(), base, engine, options), /authorization unavailable/);
    const record = await f.service.save(proposal(), base, engine, options);
    await assert.rejects(() => f.service.approve(record.id, record.digest, "another-project", actor), /another project/);
    await assert.rejects(() => f.service.approve(record.id, record.digest, "p1", { kind: "authenticated", subjectId: "other", ownerId: "other" }), /authorization unavailable/);
    await assert.rejects(() => f.service.approve(record.id, record.digest, "p1", { kind: "local", subjectId: "user-1", ownerId: null }), /Verified ForgeWeb owner/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("changed plan, dialect, base and superseding revision invalidate old approval", async () => {
  for (const change of ["plan", "dialect", "base", "revision", "specification"]) {
    const f = await fixture();
    try {
      const record = await f.service.save(proposal(), base, engine, options);
      await f.service.approve(record.id, record.digest, "p1", actor);
      if (change === "revision") await f.service.save(proposal(), base, engine, options);
      else await f.store.mutate((db) => {
        if (change === "plan") Reflect.set(db.planningRecords![record.id].proposal, "prompt", "Changed plan");
        if (change === "dialect") Reflect.set(db.planningRecords![record.id].proposal, "databaseDialect", "mysql8");
        if (change === "specification") db.specifications[record.specificationId].requirements[0].description = "changed";
        if (change === "base") {
          db.versions.v2 = { id: "v2", projectId: "p1", buildId: "b1", versionNumber: 2, label: "Accepted", editPrompt: "", modifiedFiles: [], validationStatus: "passed", validationChecks: [], createdAt: "now" };
          db.versionFiles.v2 = [];
          db.projects.p1.currentVersionId = "v2";
        }
      });
      await assert.rejects(() => f.service.generationRequest(record.id, record.digest, "p1", actor));
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  }
});

test("unknown layout refuses replacement and preserves accepted snapshots; approved layout is read-only", async () => {
  const f = await fixture();
  try {
    const record = await f.service.save(proposal(), base, engine, options);
    await f.service.approve(record.id, record.digest, "p1", actor);
    await f.store.mutate((db) => {
      db.versions.v1 = { id: "v1", projectId: "p1", buildId: "b1", versionNumber: 1, label: "Accepted", editPrompt: "", modifiedFiles: [], validationStatus: "passed", validationChecks: [], createdAt: "now" };
      db.versionFiles.v1 = [{ path: "custom/app.ts", content: "custom source", digest: digest("custom source"), requirementIds: ["REQ-001"] }];
      db.projects.p1.currentVersionId = "v1";
    });
    const workspace = new ProjectWorkspaceService(f.store);
    const before = f.store.read();
    assert.equal(layoutCompatibility(before.versionFiles.v1), "unsupported");
    await assert.rejects(() => workspace.getReady("p1"), { code: "LAYOUT_UNSUPPORTED" });
    await assert.rejects(() => workspace.edit("p1", "Replace the application layout"), { code: "LAYOUT_UNSUPPORTED" });
    assert.deepEqual(f.store.read(), before);
    await f.store.mutate((db) => { db.versions.v1.layout = { profile: "forgeweb-generated-v1", approvedPlanId: record.id }; });
    const approvedSnapshot = f.store.read();
    const ready = await workspace.getReady("p1");
    assert.equal(ready.currentVersion?.id, "v1");
    await assert.rejects(() => workspace.edit("p1", "Replace the application layout"), { code: "LAYOUT_UNSUPPORTED" });
    assert.deepEqual(f.store.read(), approvedSnapshot);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

function candidateFor(request: GenerationRequest): CandidateArtifacts {
  const candidate: CandidateArtifacts = {
    state: "candidate", id: "c1", projectId: "p1", actor, approvedPlanId: request.approved.planId, bindingDigest: request.approved.bindingDigest,
    specificationId: request.approved.specification.id, specificationDigest: request.approved.digest, planDigest: request.approved.planDigest,
    base: baseReference(request), engine, generatedAt: "2026-10-05T00:00:00Z", validationState: "pending", acceptanceState: "unaccepted", files: [], artifacts: [], manifestDigest: "",
  };
  return { ...candidate, manifestDigest: candidateManifestDigest(candidate) };
}

test("candidate generation, isolated validation and acceptance remain separate", async () => {
  const f = await fixture();
  try {
    await f.store.mutate((db) => {
      db.versions.accepted = { id: "accepted", projectId: "p1", buildId: "b1", versionNumber: 1, label: "Accepted fixture", editPrompt: "", modifiedFiles: [], validationStatus: "passed", validationChecks: [], createdAt: "now" };
      db.versionFiles.accepted = [];
      db.projects.p1.currentVersionId = "accepted";
    });
    const record = await f.service.save(proposal(), { kind: "version", versionId: "accepted", manifestDigest: fileManifestDigest([]) }, engine, options);
    await f.service.approve(record.id, record.digest, "p1", actor);
    const request = await f.service.generationRequest(record.id, record.digest, "p1", actor);
    const candidate = prepareCandidate(candidateFor(request), request);
    const before = f.store.read();
    const forged = structuredClone(candidate);
    Reflect.set(forged, "acceptanceState", "accepted");
    assert.throws(() => prepareCandidate(forged, request), /cannot accept or validate/);
    Reflect.set(forged, "acceptanceState", "unaccepted");
    Reflect.set(forged, "validationState", "passed");
    assert.throws(() => prepareCandidate(forged, request), /cannot accept or validate/);
    const unavailable = await new UnavailableValidator().validate(candidate);
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "unsupported_capability");
    const validation: IsolatedValidationResult = {
      candidateId: candidate.id, manifestDigest: candidate.manifestDigest, execution: { kind: "isolated", sessionId: "fixture", imageDigest: "fixture-image", snapshotDigest: candidate.manifestDigest, policyDigest: "fixture-policy" }, findings: [],
      checks: REQUIRED_CHECKS.map((id) => ({ id, status: "passed", required: true, evidence: "Fixture evidence only", subjectPaths: [] })),
    };
    const review = { candidateId: candidate.id, manifestDigest: candidate.manifestDigest, passed: true };
    assert.equal(candidateReadyForAcceptance(candidate, validation, review), true);
    for (const status of ["failed", "blocked", "skipped"] as const) {
      const failed = { ...validation, checks: validation.checks.map((check, i) => i === 0 ? { ...check, status } : check) };
      assert.equal(candidateReadyForAcceptance(candidate, failed, review), false);
    }
    assert.equal(candidateReadyForAcceptance(candidate, { ...validation, manifestDigest: "other" }, review), false);
    assert.equal(candidateReadyForAcceptance(candidate, validation, { ...review, passed: false }), false);
    assert.deepEqual(f.store.read(), before);
    assert.equal(candidate.acceptanceState, "unaccepted");
    assert.equal(f.store.read().projects.p1.currentVersionId, "accepted");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
