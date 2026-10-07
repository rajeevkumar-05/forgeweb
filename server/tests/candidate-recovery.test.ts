import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { CandidateAcceptanceService, type CandidateRecoveryIdentity } from "../generation/acceptance.ts";
import { CandidateAssembler } from "../generation/candidate.ts";
import { NexArchBackendAdapter } from "../generation/nexarch/backend-adapter.ts";
import { NexArchFrontendAdapter } from "../generation/nexarch/frontend-adapter.ts";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import { ForgeWebBoundedRepair } from "../generation/repair.ts";
import type { IsolatedCandidateRunner } from "../generation/validation.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier, validationRunner, validationRunnerWithoutPostgres } from "./generation-integration-fixture.ts";

async function failedFixture() {
  const f = await integrationFixture();
  const result = await new ForgeWebSafeGenerationWorkflow(f.store, integrationOwnerVerifier, {
    validationRunner: validationRunner("backend/src/index.ts"),
  }).runApproved(f.request, integrationActor);
  assert.equal(result.status, "validation_failed");
  assert.ok(result.candidateId);
  await f.store.mutate((db) => {
    db.builds["build-integration"].generationMode = "safe";
    db.builds["build-integration"].status = "failed";
    db.projects["project-integration"].status = "validation_failed";
  });
  const record = f.store.read().generationCandidates[result.candidateId];
  const identity: CandidateRecoveryIdentity = {
    candidateId: record.id, candidateDigest: record.candidateDigest,
    projectId: record.projectId, buildId: record.buildId,
  };
  return { ...f, identity };
}

test("recovery persists fresh validation and graph before existing acceptance without generation, repair or build mutation", async (t) => {
  const f = await failedFixture();
  try {
    const before = f.store.read();
    const runner = validationRunner();
    let calls = 0;
    const fresh: IsolatedCandidateRunner = {
      async validate(candidate) {
        calls++;
        assert.equal(f.store.read().generationCandidates[candidate.id].status, "validation_failed");
        const result = await runner.validate(candidate);
        if (result.ok) return { ...result, value: { ...result.value, execution: { ...result.value.execution, sessionId: "fresh-recovery-session" } } };
        return result;
      },
    };
    const service = new CandidateAcceptanceService(f.store, integrationOwnerVerifier, fresh);
    const accept = service.accept.bind(service);
    t.mock.method(service, "accept", async (...args: Parameters<typeof service.accept>) => {
      const record = f.store.read().generationCandidates[args[0]];
      assert.equal(record.status, "validated");
      assert.equal(record.validation?.status, "passed");
      assert.equal(record.engineeringGraph?.validationStatus, "passed");
      assert.equal(record.validation?.execution.kind === "isolated" && record.validation.execution.sessionId, "fresh-recovery-session");
      return accept(...args);
    });
    const forbidden = () => { throw new Error("Recovery must not generate or repair"); };
    t.mock.method(NexArchBackendAdapter.prototype, "generate", forbidden);
    t.mock.method(NexArchFrontendAdapter.prototype, "generate", forbidden);
    t.mock.method(CandidateAssembler.prototype, "assemble", forbidden);
    t.mock.method(ForgeWebBoundedRepair.prototype, "repair", forbidden);
    const result = await service.recoverCandidate(f.identity, f.request, integrationActor);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const after = f.store.read();
    assert.equal(calls, 1);
    assert.equal(after.generationCandidates[f.identity.candidateId].status, "accepted");
    assert.equal(after.projects[f.identity.projectId].currentVersionId, result.value.versionId);
    assert.equal(after.versions[result.value.versionId].candidateDigest, f.identity.candidateDigest);
    assert.deepEqual(after.versionFiles[result.value.versionId], before.generationCandidates[f.identity.candidateId].candidate.files);
    assert.deepEqual(after.generationCandidates[f.identity.candidateId].candidate, before.generationCandidates[f.identity.candidateId].candidate);
    assert.deepEqual(Object.keys(after.generationCandidates), Object.keys(before.generationCandidates));
    assert.deepEqual(after.builds, before.builds);
    assert.deepEqual(after.events, before.events);
    assert.equal(result.value.versionNumber, 1);
    assert.equal(result.value.idempotent, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("direct acceptance still rejects failed or absent persisted validation", async (t) => {
  for (const absent of [false, true]) await t.test(absent ? "absent evidence" : "failed evidence", async () => {
    const f = await failedFixture();
    try {
      if (absent) await f.store.mutate(db => { delete db.generationCandidates[f.identity.candidateId].validation; });
      const result = await new CandidateAcceptanceService(f.store, integrationOwnerVerifier, validationRunner()).accept(f.identity.candidateId, f.request, integrationActor);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "VALIDATION_NOT_PASSED");
      assert.equal(Object.keys(f.store.read().versions).length, 0);
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});

test("recovery preflight rejects owner, identity, integrity, approval and CAS conflicts without changing candidate state", async (t) => {
  for (const issue of ["owner", "digest", "project", "build", "files", "plan", "approval", "specification", "base", "version"] as const) {
    await t.test(issue, async () => {
      const f = await failedFixture();
      try {
        const identity = { ...f.identity };
        let actor = integrationActor;
        if (issue === "owner") actor = { kind: "authenticated", subjectId: "other", ownerId: "other" };
        if (issue === "digest") identity.candidateDigest = "sha256:" + "0".repeat(64);
        if (issue === "project") identity.projectId = "other-project";
        if (issue === "build") identity.buildId = "other-build";
        if (["files", "plan", "approval", "specification", "base", "version"].includes(issue)) await f.store.mutate(db => {
          if (issue === "files") Reflect.set(db.generationCandidates[identity.candidateId].candidate.files[0], "content", "changed");
          if (issue === "plan") db.planningRecords![f.request.approved.planId].digest = "changed";
          if (issue === "approval") delete db.planningRecords![f.request.approved.planId].approval;
          if (issue === "specification") db.specifications[f.request.approved.specification.id].summary = "changed";
          if (issue === "base") db.projects[identity.projectId].currentVersionId = "competing-version";
          if (issue === "version") db.versions["unlinked"] = { id: "unlinked", projectId: identity.projectId, buildId: identity.buildId, versionNumber: 1, label: "Unlinked", editPrompt: "Fixture", modifiedFiles: [], validationStatus: "passed", validationChecks: [], createdAt: "now" };
        });
        const before = f.store.read();
        const runner: IsolatedCandidateRunner = { async validate() { throw new Error("Preflight must stop before validation"); } };
        const result = await new CandidateAcceptanceService(f.store, integrationOwnerVerifier, runner).recoverCandidate(identity, f.request, actor);
        assert.equal(result.ok, false);
        assert.deepEqual(f.store.read(), before);
      } finally { await rm(f.directory, { recursive: true, force: true }); }
    });
  }
});

test("fresh failed or unavailable validation never reaches recovery acceptance", async (t) => {
  for (const runner of [validationRunner("backend/src/index.ts"), validationRunnerWithoutPostgres()]) await t.test("not passed", async (t) => {
    const f = await failedFixture();
    try {
      const service = new CandidateAcceptanceService(f.store, integrationOwnerVerifier, runner);
      t.mock.method(service, "accept", () => { throw new Error("Non-passing validation must not accept"); });
      const result = await service.recoverCandidate(f.identity, f.request, integrationActor);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "RECOVERY_VALIDATION_NOT_PASSED");
      assert.equal(Object.keys(f.store.read().versions).length, 0);
      assert.equal(f.store.read().builds[f.identity.buildId].status, "failed");
    } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
});

test("recovery is idempotent only for its existing immutable accepted version", async () => {
  const f = await failedFixture();
  try {
    const service = new CandidateAcceptanceService(f.store, integrationOwnerVerifier, validationRunner());
    const first = await service.recoverCandidate(f.identity, f.request, integrationActor);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const before = f.store.read();
    const unavailable: IsolatedCandidateRunner = { async validate() { throw new Error("Accepted retry must not revalidate"); } };
    const retry = await new CandidateAcceptanceService(f.store, integrationOwnerVerifier, unavailable).recoverCandidate(f.identity, f.request, integrationActor);
    assert.equal(retry.ok, true);
    if (retry.ok) { assert.equal(retry.value.versionId, first.value.versionId); assert.equal(retry.value.idempotent, true); }
    assert.deepEqual(f.store.read(), before);
    await f.store.mutate(db => { db.versionFiles[first.value.versionId][0].content += "\nchanged"; });
    const tampered = f.store.read();
    const rejected = await service.recoverCandidate(f.identity, f.request, integrationActor);
    assert.equal(rejected.ok, false);
    assert.deepEqual(f.store.read(), tampered);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a base change during fresh validation is rejected by existing durable-context CAS checks", async () => {
  const f = await failedFixture();
  try {
    const runner = validationRunner();
    const racing: IsolatedCandidateRunner = { async validate(candidate) {
      const result = await runner.validate(candidate);
      await f.store.mutate(db => { db.projects[f.identity.projectId].currentVersionId = "competing-version"; });
      return result;
    } };
    const result = await new CandidateAcceptanceService(f.store, integrationOwnerVerifier, racing).recoverCandidate(f.identity, f.request, integrationActor);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "CAS_BASE_CONFLICT");
    assert.equal(f.store.read().projects[f.identity.projectId].currentVersionId, "competing-version");
    assert.equal(Object.keys(f.store.read().versions).length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
