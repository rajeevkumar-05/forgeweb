import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createForgeWebServer } from "../app.ts";
import { ApiError } from "../lib.ts";
import { BuildWorkflow } from "../workflow.ts";
import { SafeGenerationActivationService } from "../generation/activation.ts";
import { ForgeWebSafeGenerationWorkflow } from "../generation/pipeline.ts";
import type { RuntimePreviewExecutor } from "../generation/runtime-preview.ts";
import { integrationActor, integrationFixture, integrationOwnerVerifier, validationRunner } from "./generation-integration-fixture.ts";

const activationToken = "test-only-preview-activation-token-00000000";
const previewUrl = "https://localhost:9443/session/test-only-capability";

// Contract seams exercise real approval/validation/CAS services; no Docker or live execution is claimed here.
async function fixture(options: { unavailable?: boolean; insecure?: boolean; failed?: boolean } = {}) {
  const fixture = await integrationFixture();
  await fixture.store.mutate(db => { db.builds["build-integration"].generationMode = "safe"; });
  const accepted = await new ForgeWebSafeGenerationWorkflow(fixture.store, integrationOwnerVerifier, { validationRunner: validationRunner() })
    .runApproved(fixture.request, integrationActor);
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.acceptance);
  let calls = 0;
  const runtimeExecutor: RuntimePreviewExecutor = {
    async start(request) {
      calls++;
      if (options.failed) throw new Error("test-only-private-runtime-detail");
      return {
        projectId: request.projectId, versionId: request.versionId, candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest, policyDigest: request.policyDigest,
        sessionId: "contract-preview-session", imageDigest: "sha256:contract-preview-image",
        previewUrl: options.insecure ? previewUrl.replace("https:", "http:") : previewUrl,
      };
    },
  };
  const activation = new SafeGenerationActivationService(fixture.store, {
    enabled: true, token: activationToken, ownerId: integrationActor.ownerId!, subjectId: integrationActor.subjectId!,
  }, options.unavailable ? {} : { runtimeExecutor });
  const server = createForgeWebServer(new BuildWorkflow(fixture.store, 0), activation);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const session = await fetch(`${origin}/api/safe/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: activationToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  const versionId = accepted.acceptance!.versionId;
  const path = `/api/safe/projects/project-integration/versions/${versionId}/preview`;
  return {
    ...fixture, activation, versionId, origin, path, cookie, calls: () => calls,
    async dispose() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await rm(fixture.directory, { recursive: true, force: true });
    },
  };
}

test("authenticated activation opens only an accepted immutable version and never persists its capability", async () => {
  const f = await fixture();
  try {
    const before = f.store.read();
    const response = await fetch(f.origin + f.path, { method: "POST", headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(await response.json(), { preview: { status: "ready", versionId: f.versionId, previewUrl } });
    assert.equal(new URL(previewUrl).protocol, "https:");
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.store.read(), before);
    assert.ok(!JSON.stringify(f.store.read()).includes("test-only-capability"));
  } finally { await f.dispose(); }
});

test("missing/expired sessions and wrong owners cannot activate preview", async () => {
  const f = await fixture();
  try {
    for (const cookie of [undefined, "forgeweb_safe_session=expired-session"]) {
      const response = await fetch(f.origin + f.path, { method: "POST", headers: cookie ? { cookie } : {} });
      assert.equal(response.status, 401);
      assert.ok(!(await response.text()).includes("test-only-capability"));
    }
    await assert.rejects(f.activation.previewAccepted("project-integration", f.versionId, { kind: "authenticated", subjectId: "integration-owner", ownerId: "other-owner" }),
      error => error instanceof ApiError && error.status === 403);
    assert.equal(f.calls(), 0);
  } finally { await f.dispose(); }
});

test("preview activation rejects missing versions, stale acceptance linkage and changed immutable files before execution", async () => {
  const f = await fixture();
  try {
    const headers = { cookie: f.cookie };
    const missing = await fetch(f.origin + f.path.replace(f.versionId, "missing"), { method: "POST", headers });
    assert.equal(missing.status, 409);
    const database = f.store.read();
    const candidateId = database.versions[f.versionId].candidateId!;
    await f.store.mutate(db => { db.generationCandidates[candidateId].acceptedVersionId = "other"; });
    assert.equal((await fetch(f.origin + f.path, { method: "POST", headers })).status, 409);
    await f.store.mutate(db => {
      db.generationCandidates[candidateId] = database.generationCandidates[candidateId];
      db.versionFiles[f.versionId][0].content += "\n// tampered";
    });
    assert.equal((await fetch(f.origin + f.path, { method: "POST", headers })).status, 409);
    assert.equal(f.calls(), 0);
  } finally { await f.dispose(); }
});

test("unavailable preview is explicit and does not alter the accepted ProjectVersion", async () => {
  const f = await fixture({ unavailable: true });
  try {
    const before = f.store.read();
    const response = await fetch(f.origin + f.path, { method: "POST", headers: { cookie: f.cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json() as { preview: { status: string; versionId: string; previewUrl?: string } };
    assert.equal(payload.preview.status, "unavailable");
    assert.equal(payload.preview.versionId, f.versionId);
    assert.equal(payload.preview.previewUrl, undefined);
    assert.deepEqual(f.store.read(), before);
  } finally { await f.dispose(); }
});

test("insecure URLs and executor failures remain closed and do not expose runtime details", async () => {
  for (const options of [{ insecure: true }, { failed: true }]) {
    const f = await fixture(options);
    try {
      const response = await fetch(f.origin + f.path, { method: "POST", headers: { cookie: f.cookie } });
      assert.equal(response.status, 503);
      const output = await response.text();
      assert.ok(!output.includes("test-only-capability"));
      assert.ok(!output.includes("test-only-private-runtime-detail"));
    } finally { await f.dispose(); }
  }
});

test("safe versions cannot use the legacy HTML route and legacy preview remains functional", async () => {
  const f = await fixture();
  try {
    const denied = await fetch(`${f.origin}/api/projects/project-integration/preview`, { headers: { cookie: f.cookie } });
    assert.equal(denied.status, 409);
    const workflow = new BuildWorkflow(f.store, 0);
    const build = await workflow.create("Build a team task manager with assignments and status tracking.");
    for (let i = 0; i < 300 && workflow.get(build.id).status !== "awaiting_confirmation"; i++) await new Promise(done => setTimeout(done, 10));
    await workflow.confirm(build.id);
    for (let i = 0; i < 300 && !["completed", "failed"].includes(workflow.get(build.id).status); i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(workflow.get(build.id).status, "completed");
    const legacy = await fetch(`${f.origin}/api/projects/${build.projectId}/preview`);
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    assert.match(await legacy.text(), /<html/i);
    assert.equal(f.calls(), 0);
  } finally { await f.dispose(); }
});
