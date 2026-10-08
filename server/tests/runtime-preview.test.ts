import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import type { AcceptedRuntimePreviewRequest, RuntimePreviewExecutor } from "../generation/runtime-preview.ts";
import { AcceptedRuntimePreviewService } from "../generation/runtime-preview.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier, validationRunner } from "./generation-integration-fixture.ts";

test("runtime boundary sends only an accepted immutable snapshot to an external executor", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const accepted = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.acceptance && accepted.candidateId);
    if (!accepted.acceptance || !accepted.candidateId) return;
    let received: AcceptedRuntimePreviewRequest | undefined;
    const executor: RuntimePreviewExecutor = {
      async start(request) {
        received = request;
        return {
          projectId: request.projectId,
          versionId: request.versionId,
          candidateId: request.candidateId,
          snapshotDigest: request.snapshotDigest,
          policyDigest: request.policyDigest,
          sessionId: "contract-preview-session",
          imageDigest: "sha256:contract-preview-image",
          previewUrl: "https://preview.invalid/session/contract-preview-session",
        };
      },
    };
    const result = await new AcceptedRuntimePreviewService(fixture.store, integrationOwnerVerifier, executor)
      .preview("project-integration", accepted.acceptance.versionId, integrationActor);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "ready");
    assert.ok(received);
    assert.equal(received?.candidateId, accepted.candidateId);
    assert.equal(received?.policy.boundary, "external-container");
    assert.equal(received?.policy.network, "none");
    assert.equal(received?.policy.userSecretAccess, false);
    assert.equal(received?.policy.forgeWebControlPlaneAccess, false);
    assert.deepEqual(received?.policy.environment, { CI: "true", NODE_ENV: "test" });
    assert.deepEqual(received?.files, fixture.store.read().versionFiles[accepted.acceptance.versionId].map((file) => ({ path: file.path, content: file.content, digest: file.digest })));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("runtime preview rejects a legacy or mutable version without candidate acceptance linkage", async () => {
  const fixture = await integrationFixture();
  try {
    await fixture.store.mutate((database) => {
      database.versions.legacy = {
        id: "legacy",
        projectId: "project-integration",
        buildId: "build-integration",
        versionNumber: 1,
        label: "Legacy",
        editPrompt: "",
        modifiedFiles: [],
        validationStatus: "passed",
        validationChecks: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      database.versionFiles.legacy = [];
    });
    const result = await new AcceptedRuntimePreviewService(fixture.store, integrationOwnerVerifier)
      .preview("project-integration", "legacy", integrationActor);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "ACCEPTED_GENERATED_VERSION_REQUIRED");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("preview health failures disclose only an allowlisted reason and retries request a fresh session", async () => {
  const fixture = await integrationFixture();
  try {
    const accepted = await new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() })
      .runApproved(fixture.request, integrationActor);
    assert.ok(accepted.acceptance);
    const versionId = accepted.acceptance.versionId;
    const before = fixture.store.read();
    let calls = 0;
    const service = new AcceptedRuntimePreviewService(fixture.store, integrationOwnerVerifier, {
      async start(request) {
        calls++;
        if (calls === 1) throw new Error("DOCKER_RUNTIME_HEALTH_FAILED");
        return {
          projectId: request.projectId, versionId: request.versionId, candidateId: request.candidateId,
          snapshotDigest: request.snapshotDigest, policyDigest: request.policyDigest,
          sessionId: `fresh-session-${calls}`, imageDigest: "sha256:contract-preview-image",
          previewUrl: `https://preview.invalid/session/fresh-${calls}`,
        };
      },
    });
    const failed = await service.preview("project-integration", versionId, integrationActor);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error.message, /runtime health check failed/);
    const retry = await service.preview("project-integration", versionId, integrationActor);
    const fresh = await service.preview("project-integration", versionId, integrationActor);
    assert.ok(retry.ok && retry.value.status === "ready");
    assert.ok(fresh.ok && fresh.value.status === "ready");
    assert.notEqual(retry.value.execution.previewUrl, fresh.value.execution.previewUrl);
    assert.deepEqual(fixture.store.read(), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
