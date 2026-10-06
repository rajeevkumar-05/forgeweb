import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { engineeringGraphDigest, verifyEngineeringGraph } from "../generation/engineering-graph.ts";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import { AcceptedRuntimePreviewService } from "../generation/runtime-preview.ts";
import { JsonStore } from "../store.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier, validationRunner, validationRunnerWithoutPostgres } from "./generation-integration-fixture.ts";

test("safe workflow creates an evidence graph, accepts one version, and reports runtime unavailable", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const result = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(result.status, "accepted", result.error?.message);
    assert.ok(result.candidateId && result.graph && result.acceptance);
    assert.equal(result.preview?.status, "unavailable");
    if (!result.graph || !result.candidateId || !result.acceptance) return;

    const record = fixture.store.read().generationCandidates[result.candidateId];
    verifyEngineeringGraph(result.graph, record.candidate);
    assert.equal(result.graph.digest, engineeringGraphDigest(result.graph));
    assert.equal(result.graph.validationStatus, "passed");
    assert.equal(result.graph.databaseProvider, "postgresql");
    const nodeTypes = new Set(result.graph.nodes.map((node) => node.type));
    for (const type of ["PROJECT", "REQUIREMENT", "FEATURE", "COMPONENT", "API", "ENTITY", "FIELD", "MODULE", "SERVICE", "FILE", "TEST", "SECURITY_RULE", "DEPENDENCY"] as const) {
      assert.ok(nodeTypes.has(type), `missing ${type} evidence node`);
    }
    assert.ok(result.graph.edges.some((edge) => edge.type === "IMPLEMENTS" && edge.from.startsWith("file:")));
    assert.ok(result.graph.edges.some((edge) => edge.type === "CALLS"));
    assert.ok(result.graph.edges.some((edge) => edge.type === "USES"));
    assert.ok(result.graph.edges.some((edge) => edge.type === "SECURED_BY"));
    assert.equal(fixture.store.read().projects["project-integration"].currentVersionId, result.acceptance.versionId);
    assert.deepEqual(fixture.store.read().versionFiles[result.acceptance.versionId], record.candidate.files);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("missing disposable PostgreSQL fails closed before acceptance", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunnerWithoutPostgres() });
    const result = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(result.status, "validation_unavailable");
    assert.equal(result.stage, "validation");
    assert.ok(result.record?.validation?.checks.some((check) => check.id === "postgresql-runtime" && check.status === "unavailable"));
    assert.equal(fixture.store.read().projects["project-integration"].currentVersionId, undefined);
    assert.equal(Object.keys(fixture.store.read().versions).length, 0);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("workflow rejects the wrong owner before generation", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const before = fixture.store.read();
    const result = await workflow.runApproved(fixture.request, { kind: "authenticated", subjectId: "attacker", ownerId: "attacker" });
    assert.equal(result.status, "failed");
    assert.equal(result.stage, "request");
    assert.deepEqual(fixture.store.read(), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("accepted graph and runtime-unavailable state survive store restart", async () => {
  const fixture = await integrationFixture();
  try {
    const workflow = new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() });
    const result = await workflow.runApproved(fixture.request, integrationActor);
    assert.equal(result.status, "accepted");
    assert.ok(result.acceptance && result.candidateId);
    if (!result.acceptance || !result.candidateId) return;

    const restarted = new JsonStore(fixture.directory);
    await restarted.initialize();
    const record = restarted.read().generationCandidates[result.candidateId];
    assert.equal(record.engineeringGraph?.candidateId, result.candidateId);
    assert.equal(record.status, "accepted");
    const preview = await new AcceptedRuntimePreviewService(restarted, integrationOwnerVerifier).preview("project-integration", result.acceptance.versionId, integrationActor);
    assert.equal(preview.ok, true);
    if (preview.ok) assert.equal(preview.value.status, "unavailable");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
