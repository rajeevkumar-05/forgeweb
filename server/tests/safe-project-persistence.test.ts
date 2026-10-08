import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createForgeWebServer } from "../app.ts";
import type { BuildView, Project, ProjectWorkspace } from "../domain.ts";
import { SafeGenerationActivationService } from "../generation/activation.ts";
import type { SafeGenerationConfirmation } from "../generation/activation.ts";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";
import { validationRunner } from "./generation-integration-fixture.ts";
import { ownerFixture } from "./owner-fixture.ts";

const config = { enabled: true, token: "test-only-project-session-token-00000000", ownerId: "project-owner", subjectId: "project-subject" };
const prompt = "Build a task management application. Users can create, edit, and view tasks. Tasks have title, description, status, priority and due date.";
type ApiPayload = {
  build: BuildView;
  projects: Project[];
  workspace: ProjectWorkspace;
  generation: SafeGenerationConfirmation["generation"];
};

async function openServer(directory: string, validated: boolean, owner = config) {
  const store = new JsonStore(directory);
  await store.initialize();
  // Contract evidence seams exercise normal approval and CAS; live Docker is verified separately.
  const activation = new SafeGenerationActivationService(store, owner, validated ? { validationRunner: validationRunner() } : {});
  const server = createForgeWebServer(new BuildWorkflow(store, 0), activation);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const username = owner.ownerId === config.ownerId ? "test-owner" : "other-owner";
  const account = await ownerFixture(origin, !Object.values(store.read().users ?? {}).some(user => user.username === username), username);
  let cookie = "";
  return {
    store,
    user: account.user,
    async authenticate() {
      const response = await account.fetch(origin + "/api/safe/session", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: owner.token }),
      });
      assert.equal(response.status, 200);
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    },
    async api(path: string, options: { body?: unknown; post?: boolean; anonymous?: boolean } = {}) {
      const response = await (options.anonymous ? globalThis.fetch : account.fetch)(origin + path, {
        method: options.post ? "POST" : "GET",
        headers: { "content-type": "application/json", ...(!options.anonymous && cookie ? { cookie } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      return { status: response.status, value: await response.json() as ApiPayload };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}

test("Verified project persists before approval and its accepted version reopens through the normal Projects API after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-project-persistence-"));
  let server = await openServer(directory, true);
  try {
    await server.authenticate();
    const created = await server.api("/api/safe/builds", { post: true, body: { prompt } });
    assert.equal(created.status, 202);
    const build = created.value.build;
    const id = build.projectId;
    assert.equal(build.project.id, id);
    assert.equal(server.store.read().projects[id].status, "awaiting_confirmation");
    assert.equal(Object.keys(server.store.read().versions).length, 0);
    assert.equal((await server.api("/api/projects")).value.projects[0].id, id);
    assert.equal((await server.api("/api/projects", { anonymous: true })).status, 401);
    assert.equal((await server.api(`/api/projects/${id}/workspace`, { anonymous: true })).status, 401);

    const confirmation = await server.api(`/api/safe/builds/${build.id}/confirm`, { post: true });
    assert.equal(confirmation.status, 202);
    assert.equal(confirmation.value.generation.status, "accepted");
    const database = server.store.read();
    const project = database.projects[id];
    const version = database.versions[project.currentVersionId!];
    const candidate = database.generationCandidates[version.candidateId!];
    assert.equal(version.projectId, id);
    assert.equal(version.buildId, build.id);
    assert.equal(version.versionNumber, 1);
    assert.equal(candidate.status, "accepted");
    assert.equal(candidate.acceptedVersionId, version.id);
    assert.equal(candidate.ownerId, server.user.id);
    assert.equal(candidate.subjectId, server.user.id);
    assert.deepEqual(database.versionFiles[version.id].map(f => f.path), candidate.candidate.files.map(f => f.path));
    assert.equal((await server.api(`/api/safe/builds/${build.id}/confirm`, { post: true })).status, 409);
    assert.equal(Object.keys(server.store.read().projects).length, 1);
    assert.equal(Object.keys(server.store.read().versions).length, 1);

    await server.close();
    server = await openServer(directory, true);
    assert.equal((await server.api("/api/projects")).value.projects.length, 1);
    await server.authenticate();
    for (let attempt = 0; attempt < 2; attempt++) {
      const list = await server.api("/api/projects");
      assert.equal(list.value.projects.length, 1);
      assert.equal(list.value.projects[0].currentVersionNumber, 1);
      const workspace = await server.api(`/api/projects/${id}/workspace`);
      assert.equal(workspace.status, 200);
      assert.equal(workspace.value.workspace.currentVersion?.id, version.id);
      assert.deepEqual(workspace.value.workspace.files, database.versionFiles[version.id]);
      assert.equal(workspace.value.workspace.database.engine, "PostgreSQL");
      assert.equal(workspace.value.workspace.versions.length, 1);
      const reopenedBuild = await server.api(`/api/builds/${build.id}`);
      assert.equal(reopenedBuild.value.build.generationMode, "safe");
    }
    assert.equal(Object.keys(server.store.read().projects).length, 1);

    await server.close();
    server = await openServer(directory, true, { ...config, ownerId: "other-owner", subjectId: "other-subject" });
    await server.authenticate();
    assert.equal((await server.api("/api/projects")).value.projects.length, 0);
    assert.equal((await server.api(`/api/projects/${id}/workspace`)).status, 403);
    assert.equal((await server.api(`/api/builds/${build.id}`)).status, 403);
    assert.equal((await server.api(`/api/safe/builds/${build.id}/confirm`, { post: true })).status, 403);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("infrastructure validation failure leaves the same owned durable project listed without a version or duplicate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-project-failure-"));
  let server = await openServer(directory, false);
  try {
    await server.authenticate();
    const created = await server.api("/api/safe/builds", { post: true, body: { prompt } });
    const build = created.value.build;
    const failed = await server.api(`/api/safe/builds/${build.id}/confirm`, { post: true });
    assert.equal(failed.value.generation.status, "validation_unavailable");
    await server.close();
    server = await openServer(directory, false);
    await server.authenticate();
    const projects = (await server.api("/api/projects")).value.projects;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].id, build.projectId);
    assert.equal(projects[0].status, "validation_failed");
    const workspace = (await server.api(`/api/projects/${build.projectId}/workspace`)).value.workspace;
    assert.equal(workspace.currentVersion, undefined);
    assert.equal(workspace.files.length, 0);
    assert.equal((await server.api(`/api/safe/builds/${build.id}/confirm`, { post: true })).status, 409);
    assert.equal(Object.keys(server.store.read().projects).length, 1);
    assert.equal(Object.keys(server.store.read().versions).length, 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
