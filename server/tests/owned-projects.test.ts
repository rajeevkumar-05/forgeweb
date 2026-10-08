import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createForgeWebServer } from "../app.ts";
import { ForgeWebAuthentication } from "../auth.ts";
import { SafeGenerationActivationService } from "../generation/activation.ts";
import type { RuntimePreviewExecutor } from "../generation/runtime-preview.ts";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";
import type { BuildView, Project } from "../domain.ts";
import { ownerFixture } from "./owner-fixture.ts";
import { validationRunner } from "./generation-integration-fixture.ts";

process.env.FORGEWEB_LLM_ENABLED = "false";

const token = "test-only-unified-generation-token-0000000000";
const taskPrompt = "Build a task management application. Users can create, edit and view tasks. Tasks have title, description, status, priority and due date. No payments.";
type ApiPayload = { build: BuildView; projects: Project[]; generation: { status: string }; preview: { status: string }; authenticated: boolean; claimed: number };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-owned-projects-"));
  const store = new JsonStore(directory); await store.initialize();
  const workflow = new BuildWorkflow(store, 0);
  const stopped: string[] = [];
  let cleanupFailed = false;
  const runtimeExecutor: RuntimePreviewExecutor = {
    async start(request) { return { ...request, sessionId: "contract-session", imageDigest: "sha256:contract-image",
      previewUrl: `https://localhost:9443/session/${"a".repeat(64)}`, expiresAt: Date.now() + 30_000 }; },
    async stopProject(id) { if (cleanupFailed) throw new Error("contract-cleanup-failure"); stopped.push(id); },
  };
  const safe = new SafeGenerationActivationService(store, { enabled: true, token, ownerId: "legacy-owner", subjectId: "legacy-subject" }, { validationRunner: validationRunner(), runtimeExecutor });
  const server = createForgeWebServer(workflow, safe);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = await ownerFixture(origin);
  const api = async (path: string, method = "GET", payload?: unknown, cookie = owner.cookie) => {
    const response = await fetch(origin + path, { method, headers: { cookie, "content-type": "application/json" }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    return { status: response.status, value: await response.json() as ApiPayload };
  };
  const authorize = async (cookie = owner.cookie) => {
    const response = await fetch(origin + "/api/safe/session", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(response.status, 200);
    return `${cookie}; ${response.headers.get("set-cookie")!.split(";")[0]}`;
  };
  return { directory, store, workflow, safe, origin, owner, api, authorize, stopped,
    failCleanup() { cleanupFailed = true; },
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); },
  };
}

test("owner login uses salted hashes, hashed persistent sessions, bounded cookies, rotation, logout and expiry", async () => {
  const f = await fixture();
  try {
    const raw = f.owner.cookie.split("=")[1];
    const database = f.store.read();
    assert.equal(database.users?.[f.owner.user.id].username, "test-owner");
    assert.ok(!JSON.stringify(database).includes(raw));
    assert.ok(!JSON.stringify(database).includes("test-only-owner-password"));
    const login = await fetch(f.origin + "/api/auth/login", { method: "POST", headers: { cookie: f.owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ username: "test-owner", password: "test-only-owner-password-not-a-real-secret" }) });
    assert.equal(login.status, 200);
    const header = login.headers.get("set-cookie")!;
    assert.match(header, /HttpOnly; SameSite=Strict; Path=\/api; Max-Age=28800/);
    assert.notEqual(header.split(";")[0], f.owner.cookie);
    assert.equal((await f.api("/api/projects")).status, 401);
    const cookie = header.split(";")[0];
    assert.equal((await f.api("/api/projects", "GET", undefined, cookie)).status, 200);
    const reloaded = new JsonStore(f.directory); await reloaded.initialize();
    const auth = new ForgeWebAuthentication(reloaded, true);
    const result = await auth.login("test-owner", "test-only-owner-password-not-a-real-secret");
    assert.match(result.cookie, /; Secure$/);
    assert.equal(result.user.id, f.owner.user.id);
    const logout = await f.api("/api/auth/logout", "POST", undefined, cookie); assert.equal(logout.status, 200);
    assert.equal((await f.api("/api/projects", "GET", undefined, cookie)).status, 401);
    const fresh = await ownerFixture(f.origin, false);
    await f.store.mutate(db => { for (const session of Object.values(db.userSessions ?? {})) session.expiresAt = 0; });
    assert.equal((await f.api("/api/projects", "GET", undefined, fresh.cookie)).status, 401);
  } finally { await f.close(); }
});

test("normal login cannot bypass Verified authorization; both creation paths use the same owner and canonical list", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.api("/api/projects", "GET", undefined, "")).status, 401);
    assert.equal((await f.api("/api/safe/builds", "POST", { prompt: taskPrompt })).status, 401);
    const standard = await f.api("/api/builds", "POST", { prompt: "Build a Standard Test Project task management application." });
    assert.equal(standard.status, 202); assert.equal(standard.value.build.project.ownerId, f.owner.user.id);
    for (let i = 0; i < 300 && f.workflow.isProjectRunning(standard.value.build.projectId); i++) await new Promise(done => setTimeout(done, 10));
    const verifiedCookie = await f.authorize();
    const safe = await f.api("/api/safe/builds", "POST", { prompt: taskPrompt }, verifiedCookie);
    assert.equal(safe.status, 202); assert.equal(safe.value.build.project.ownerId, f.owner.user.id);
    const list = await f.api("/api/projects");
    assert.equal(list.value.projects.length, 2);
    assert.equal(new Set(list.value.projects.map((p: { id: string }) => p.id)).size, 2);
    assert.deepEqual(list.value.projects.map((p: { updatedAt: string }) => p.updatedAt), [...list.value.projects.map((p: { updatedAt: string }) => p.updatedAt)].sort().reverse());
    const approved = await f.api(`/api/safe/builds/${safe.value.build.id}/confirm`, "POST", undefined, verifiedCookie);
    assert.equal(approved.value.generation.status, "accepted");
    for (const build of [standard.value.build, safe.value.build]) {
      assert.equal((await f.api(`/api/builds/${build.id}`)).status, 200);
      assert.equal((await f.api(`/api/projects/${build.projectId}/workspace`)).status, 200);
    }
    const version = f.store.read().projects[safe.value.build.projectId].currentVersionId!;
    assert.equal((await f.api(`/api/safe/projects/${safe.value.build.projectId}/versions/${version}/preview`, "POST")).value.preview.status, "ready");
    const persisted = new JsonStore(f.directory); await persisted.initialize();
    assert.equal(persisted.read().projects[safe.value.build.projectId].ownerId, f.owner.user.id);
  } finally { await f.close(); }
});

test("User B cannot list, open, mutate, preview or delete User A projects, or reuse A's Verified cookie", async () => {
  const f = await fixture();
  try {
    const verifiedCookie = await f.authorize();
    const build = (await f.api("/api/safe/builds", "POST", { prompt: taskPrompt }, verifiedCookie)).value.build;
    const other = await ownerFixture(f.origin, true, "other-owner");
    assert.equal((await f.api("/api/projects", "GET", undefined, other.cookie)).value.projects.length, 0);
    for (const [path, method] of [[`/api/projects/${build.projectId}`, "GET"], [`/api/projects/${build.projectId}/workspace`, "GET"], [`/api/builds/${build.id}`, "GET"], [`/api/builds/${build.id}/events`, "GET"], [`/api/projects/${build.projectId}`, "DELETE"], [`/api/safe/builds/${build.id}/confirm`, "POST"]]) {
      assert.equal((await f.api(path, method, method === "DELETE" ? { confirmed: true } : undefined, other.cookie)).status, 403);
    }
    const combined = `${other.cookie}; ${verifiedCookie.split("; ")[1]}`;
    assert.equal((await f.api("/api/safe/status", "GET", undefined, combined)).value.authenticated, false);
    assert.equal((await f.api("/api/safe/builds", "POST", { prompt: taskPrompt }, combined)).status, 403);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true }, other.cookie)).status, 403);
    assert.ok(f.store.read().projects[build.projectId]);
  } finally { await f.close(); }
});

test("legacy claiming is explicit, authenticated, transactional, idempotent and does not rewrite immutable Verified metadata", async () => {
  const f = await fixture();
  try {
    const old = await f.workflow.create("Build a legacy task management application.");
    for (let i = 0; i < 300 && f.workflow.isProjectRunning(old.projectId); i++) await new Promise(done => setTimeout(done, 10));
    const oldSafe = await f.safe.create(taskPrompt, { kind: "authenticated", ownerId: "legacy-owner", subjectId: "legacy-subject" });
    const records = f.store.read().planningRecords;
    assert.equal((await f.api("/api/projects")).value.projects.length, 0);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true }, "")).status, 401);
    assert.equal((await f.api("/api/projects/claim", "POST", {})).status, 400);
    assert.equal(f.store.read().projects[old.projectId].ownerId, undefined);
    assert.equal(f.store.read().projects[oldSafe.projectId].ownerId, undefined);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true })).value.claimed, 1);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true })).value.claimed, 0);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true, includeVerified: true })).value.claimed, 1);
    const cookie = await f.authorize();
    assert.deepEqual(f.store.read().planningRecords, records);
    assert.equal(f.store.read().projects[oldSafe.projectId].ownershipClaim?.userId, f.owner.user.id);
    assert.equal((await f.api("/api/projects")).value.projects.length, 2);
    assert.equal((await f.api(`/api/projects/${oldSafe.projectId}/workspace`)).status, 200);
    assert.equal((await f.api("/api/projects/claim", "POST", { confirmed: true, includeVerified: true }, cookie)).value.claimed, 0);
    const approved = await f.api(`/api/safe/builds/${oldSafe.id}/confirm`, "POST", undefined, cookie);
    assert.equal(approved.value.generation.status, "accepted");
    const version = f.store.read().projects[oldSafe.projectId].currentVersionId!;
    assert.equal((await f.api(`/api/safe/projects/${oldSafe.projectId}/versions/${version}/preview`, "POST")).status, 200);
  } finally { await f.close(); }
});

test("project deletion cleans only its runtime before persistent records, preserves B's CAS snapshot and survives reload", async () => {
  const f = await fixture();
  try {
    const cookie = await f.authorize();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const build = (await f.api("/api/safe/builds", "POST", { prompt: taskPrompt }, cookie)).value.build;
      assert.equal((await f.api(`/api/safe/builds/${build.id}/confirm`, "POST", undefined, cookie)).value.generation.status, "accepted");
      ids.push(build.projectId);
    }
    const before = f.store.read();
    const b = before.projects[ids[1]];
    const bVersion = before.versions[b.currentVersionId!];
    const bFiles = before.versionFiles[bVersion.id];
    assert.equal((await f.api(`/api/projects/${ids[0]}`, "DELETE", {})).status, 400);
    assert.ok(f.store.read().projects[ids[0]]);
    assert.equal((await f.api(`/api/projects/${ids[0]}`, "DELETE", { confirmed: true })).status, 200);
    assert.deepEqual(f.stopped, [ids[0]]);
    const after = f.store.read();
    assert.equal(after.projects[ids[0]], undefined);
    for (const collection of [after.builds, after.versions, after.generationCandidates, after.specifications, after.graphs]) assert.ok(Object.values(collection).every(record => record.projectId !== ids[0]));
    assert.ok(Object.values(after.planningRecords ?? {}).every(record => record.proposal.scope.projectId !== ids[0]));
    const buildId = before.projects[ids[0]].currentBuildId!;
    assert.equal(after.files[buildId], undefined); assert.equal(after.events[buildId], undefined);
    assert.deepEqual(after.projects[b.id], b); assert.deepEqual(after.versions[bVersion.id], bVersion); assert.deepEqual(after.versionFiles[bVersion.id], bFiles);
    assert.equal(after.generationCandidates[bVersion.candidateId!].status, "accepted");
    const reloaded = new JsonStore(f.directory); await reloaded.initialize();
    assert.equal(reloaded.read().projects[ids[0]], undefined); assert.deepEqual(reloaded.read().versionFiles[bVersion.id], bFiles);
    assert.equal((await f.api(`/api/projects/${b.id}/workspace`)).status, 200);
    assert.equal((await f.api(`/api/projects/${ids[0]}`, "DELETE", { confirmed: true })).status, 404);
  } finally { await f.close(); }
});

test("cleanup failure and active generation fail closed without removing project data", async () => {
  const f = await fixture();
  try {
    const cookie = await f.authorize();
    const build = (await f.api("/api/safe/builds", "POST", { prompt: taskPrompt }, cookie)).value.build;
    await f.store.mutate(db => { db.builds[build.id].status = "generating"; });
    assert.equal((await f.api(`/api/projects/${build.projectId}`, "DELETE", { confirmed: true })).status, 409);
    assert.equal(f.stopped.length, 0);
    await f.store.mutate(db => { db.builds[build.id].status = "failed"; });
    const before = f.store.read(); f.failCleanup();
    assert.equal((await f.api(`/api/projects/${build.projectId}`, "DELETE", { confirmed: true })).status, 503);
    assert.deepEqual(f.store.read(), before);
  } finally { await f.close(); }
});

test("cross-origin mutations, forged sessions, invalid login and rapid credential guesses are rejected", async () => {
  const f = await fixture();
  try {
    const crossed = await fetch(f.origin + "/api/projects/claim", { method: "POST", headers: { cookie: f.owner.cookie, origin: "https://attacker.invalid" }, body: "{}" });
    assert.equal(crossed.status, 403);
    const forged = await f.api("/api/projects", "GET", undefined, `forgeweb_owner_session=${"0".repeat(64)}`); assert.equal(forged.status, 401);
    for (let i = 0; i < 9; i++) assert.equal((await f.api("/api/auth/login", "POST", { username: "not-found", password: "wrong-test-password" })).status, 401);
    assert.equal((await f.api("/api/auth/login", "POST", { username: "not-found", password: "wrong-test-password" })).status, 429);
  } finally { await f.close(); }
});
