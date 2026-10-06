import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import { ForgeWebBoundedRepair, MAX_REPAIR_ATTEMPTS } from "../generation/repair.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier, validationRunner } from "./generation-integration-fixture.ts";

const TARGET = "backend/src/index.ts";

test("bounded repair creates a new candidate, revalidates, and preserves the failed original", async () => {
  const fixture = await integrationFixture();
  try {
    const failingWorkflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner(TARGET) });
    const failed = await failingWorkflow.runApproved(fixture.request, integrationActor);
    assert.equal(failed.status, "validation_failed");
    assert.ok(failed.candidateId && failed.record);
    if (!failed.candidateId || !failed.record) return;
    const originalFile = failed.record.candidate.files.find((file) => file.path === TARGET);
    assert.ok(originalFile);
    if (!originalFile) return;

    const successfulWorkflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const repaired = await successfulWorkflow.repairAndRetry(fixture.request, integrationActor, failed.candidateId, {
      findingId: "TYPECHECK_FAILED",
      attempt: 1,
      changes: [{ path: TARGET, expectedDigest: originalFile.digest, content: `${originalFile.content}\n// Explicit bounded repair.\n` }],
    });
    assert.equal(repaired.status, "accepted", repaired.error?.message);
    assert.notEqual(repaired.candidateId, failed.candidateId);
    assert.ok(repaired.acceptance && repaired.record?.candidate.assembly.repair);
    if (!repaired.acceptance || !repaired.record) return;

    const database = fixture.store.read();
    const original = database.generationCandidates[failed.candidateId];
    assert.equal(original.status, "superseded");
    assert.equal(original.supersededByCandidateId, repaired.candidateId);
    assert.equal(original.candidate.files.find((file) => file.path === TARGET)?.content, originalFile.content);
    assert.deepEqual(repaired.record.candidate.assembly.repair, {
      baseCandidateId: failed.candidateId,
      findingId: "TYPECHECK_FAILED",
      attempt: 1,
      modifiedFiles: [TARGET],
    });
    assert.match(database.versionFiles[repaired.acceptance.versionId].find((file) => file.path === TARGET)?.content ?? "", /Explicit bounded repair/);
    assert.equal(database.versions[repaired.acceptance.versionId].sourceVersionId, undefined);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("bounded repair rejects untargeted paths and attempt overflow without persistence", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner(TARGET) });
    const failed = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(failed.status, "validation_failed");
    assert.ok(failed.record);
    if (!failed.record) return;
    const unrelated = failed.record.candidate.files.find((file) => file.path.startsWith("frontend/"))!;
    const before = fixture.store.read();
    const repairer = new ForgeWebBoundedRepair();
    const untargeted = repairer.repair(fixture.request, failed.record, {
      findingId: "TYPECHECK_FAILED",
      attempt: 1,
      changes: [{ path: unrelated.path, expectedDigest: unrelated.digest, content: `${unrelated.content}\nchanged` }],
    });
    assert.equal(untargeted.ok, false);
    if (!untargeted.ok) assert.equal(untargeted.error.diagnostics?.[0]?.code, "REPAIR_PATH_NOT_TARGETED");
    const overflow = repairer.repair(fixture.request, failed.record, {
      findingId: "TYPECHECK_FAILED",
      attempt: MAX_REPAIR_ATTEMPTS + 1,
      changes: [],
    });
    assert.equal(overflow.ok, false);
    assert.deepEqual(fixture.store.read(), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepted candidate and ProjectVersion cannot be repaired in place", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const accepted = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.record && accepted.acceptance);
    if (!accepted.record || !accepted.acceptance) return;
    const file = accepted.record.candidate.files.find((entry) => entry.path === TARGET)!;
    const before = fixture.store.read();
    const result = new ForgeWebBoundedRepair().repair(fixture.request, accepted.record, {
      findingId: "TYPECHECK_FAILED",
      attempt: 1,
      changes: [{ path: file.path, expectedDigest: file.digest, content: `${file.content}\nchanged` }],
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fixture.store.read(), before);
    assert.deepEqual(fixture.store.read().versionFiles[accepted.acceptance.versionId], before.versionFiles[accepted.acceptance.versionId]);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
