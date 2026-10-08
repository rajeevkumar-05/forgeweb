import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.FORGEWEB_LLM_ENABLED = "false";
import { createForgeWebServer } from "../app.ts";
import { SafeGenerationActivationService } from "../generation/activation.ts";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";
import { ownerFixture } from "./owner-fixture.ts";

const activationToken = "test-only-safe-activation-token-000000000000";

test("authenticated public activation reaches the safe pipeline and fails closed without trusted validators", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-safe-activation-"));
  const store = new JsonStore(directory);
  await store.initialize();
  const workflow = new BuildWorkflow(store, 0);
  const activation = new SafeGenerationActivationService(store, {
    enabled: true,
    token: activationToken,
    ownerId: "owner-http-test",
    subjectId: "subject-http-test",
  });
  const server = createForgeWebServer(workflow, activation);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { fetch } = await ownerFixture(baseUrl);

  try {
    const statusResponse = await fetch(`${baseUrl}/api/safe/status`);
    assert.equal(statusResponse.status, 200);
    assert.deepEqual(await statusResponse.json(), {
      enabled: true,
      authenticated: false,
      target: "forgeweb-postgresql-v1",
      isolatedValidation: "unavailable",
      disposablePostgresql: "unavailable",
      trustedRuntime: "unavailable",
    });

    const unauthenticatedCreate = await fetch(`${baseUrl}/api/safe/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a secure client portal with projects, invoices, and role-based access." }),
    });
    assert.equal(unauthenticatedCreate.status, 401);

    const wrongSession = await fetch(`${baseUrl}/api/safe/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong-token" }),
    });
    assert.equal(wrongSession.status, 401);
    assert.ok(!(await wrongSession.text()).includes(activationToken));

    const sessionResponse = await fetch(`${baseUrl}/api/safe/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: activationToken }),
    });
    assert.equal(sessionResponse.status, 200);
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie?.startsWith("forgeweb_safe_session="));
    assert.match(sessionResponse.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.match(sessionResponse.headers.get("set-cookie") ?? "", /SameSite=Strict/);

    const createResponse = await fetch(`${baseUrl}/api/safe/builds`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ prompt: "Build a secure client portal with projects, invoices, and role-based access." }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json() as { build: { id: string; projectId: string; status: string; generationMode: string; planningRecordId: string; filePaths: string[] } };
    assert.equal(created.build.status, "awaiting_confirmation");
    assert.equal(created.build.generationMode, "safe");
    assert.equal(created.build.filePaths.length, 0);
    assert.ok(created.build.planningRecordId);

    const plan = store.read().planningRecords?.[created.build.planningRecordId];
    assert.equal(plan?.proposal.databaseDialect, "postgresql");
    assert.equal(plan?.proposal.database?.target.provider, "postgresql");
    assert.equal(plan?.approval, undefined);

    const ownerlessRead = await globalThis.fetch(`${baseUrl}/api/builds/${created.build.id}`);
    assert.equal(ownerlessRead.status, 401);
    const ownerRead = await fetch(`${baseUrl}/api/builds/${created.build.id}`, { headers: { cookie: cookie! } });
    assert.equal(ownerRead.status, 200);

    const legacyRevisionAttempt = await fetch(`${baseUrl}/api/builds/${created.build.id}/revise`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie! },
      body: JSON.stringify({ prompt: "Replace the approved PostgreSQL architecture with an unrelated legacy plan." }),
    });
    assert.equal(legacyRevisionAttempt.status, 409);
    assert.equal((await legacyRevisionAttempt.json() as { error: { code: string } }).error.code, "SAFE_REVISION_UNAVAILABLE");

    const ownerlessConfirmation = await globalThis.fetch(`${baseUrl}/api/safe/builds/${created.build.id}/confirm`, { method: "POST" });
    assert.equal(ownerlessConfirmation.status, 401);
    assert.equal(Object.keys(store.read().generationCandidates).length, 0);

    const confirmationResponse = await fetch(`${baseUrl}/api/safe/builds/${created.build.id}/confirm`, {
      method: "POST",
      headers: { cookie: cookie! },
    });
    assert.equal(confirmationResponse.status, 202);
    const confirmation = await confirmationResponse.json() as {
      build: { status: string; error?: { code: string }; filePaths: string[] };
      generation: { status: string; stage: string; validation: string; runtime: string; candidateId?: string };
    };
    assert.equal(confirmation.build.status, "failed");
    assert.equal(confirmation.build.error?.code, "VALIDATION_UNAVAILABLE");
    assert.equal(confirmation.build.filePaths.length, 0);
    assert.equal(confirmation.generation.status, "validation_unavailable");
    assert.equal(confirmation.generation.stage, "validation");
    assert.equal(confirmation.generation.validation, "unavailable");
    assert.equal(confirmation.generation.runtime, "not-run");

    const database = store.read();
    const candidates = Object.values(database.generationCandidates);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].status, "validation_unavailable");
    assert.equal(candidates[0].candidate.assembly.target.profile, "forgeweb-postgresql-v1");
    assert.equal(candidates[0].candidate.assembly.target.database.target.provider, "postgresql");
    assert.ok(candidates[0].engineeringGraph);
    assert.equal(Object.keys(database.versions).length, 0);
    assert.equal(database.projects[created.build.projectId].currentVersionId, undefined);

    const legacyResponse = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a secure team scheduler with client access and audit history." }),
    });
    assert.equal(legacyResponse.status, 202);
    const legacy = await legacyResponse.json() as { build: { id: string; generationMode?: string } };
    assert.notEqual(legacy.build.generationMode, "safe");
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (["awaiting_confirmation", "needs_context", "failed"].includes(workflow.get(legacy.build.id).status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(workflow.get(legacy.build.id).status, "awaiting_confirmation");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
