import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createForgeWebServer } from "../app.ts";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";
import { resetLlmConfig, resetLlmProvider } from "../llm/index.ts";
import { ownerFixture } from "./owner-fixture.ts";

process.env.FORGEWEB_LLM_ENABLED = "false";
process.env.FORGEWEB_LLM_API_KEY = "test-secret-must-never-be-served";
resetLlmConfig();
resetLlmProvider();

test("HTTP boundaries expose proposal, confirmation, and completed build phases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-http-test-"));
  const store = new JsonStore(directory);
  await store.initialize();
  const workflow = new BuildWorkflow(store, 0);
  const server = createForgeWebServer(workflow);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { fetch } = await ownerFixture(baseUrl);

  try {
    const healthResponse = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json() as { status: string }).status, "ok");

    const invalidResponse = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "short" }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.equal((await invalidResponse.json() as { error: { code: string } }).error.code, "PROMPT_TOO_SHORT");

    const createResponse = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a secure team scheduler with client access and audit history." }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json() as { build: { id: string; projectId: string } };
    let status = "queued";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/builds/${created.build.id}`);
      const payload = await response.json() as { build: { status: string } };
      status = payload.build.status;
      if (["awaiting_confirmation", "failed"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(status, "awaiting_confirmation");

    const projectBeforeConfirmation = await fetch(`${baseUrl}/api/projects/${created.build.projectId}`);
    assert.equal(projectBeforeConfirmation.status, 200);
    const snapshot = await projectBeforeConfirmation.json() as { files: unknown[] };
    assert.equal(snapshot.files.length, 0);

    const confirmationResponse = await fetch(`${baseUrl}/api/builds/${created.build.id}/confirm`, { method: "POST" });
    assert.equal(confirmationResponse.status, 202);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/builds/${created.build.id}`);
      const payload = await response.json() as { build: { status: string } };
      status = payload.build.status;
      if (["completed", "failed"].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(status, "completed");

    const workspaceResponse = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/workspace`);
    assert.equal(workspaceResponse.status, 200);
    const workspacePayload = await workspaceResponse.json() as { workspace: { currentVersion: { versionNumber: number }; files: unknown[] } };
    assert.equal(workspacePayload.workspace.currentVersion.versionNumber, 1);
    assert.equal(workspacePayload.workspace.files.length, 15);

    const previewResponse = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/preview`);
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    const previewHtml = await previewResponse.text();
    assert.match(previewHtml, /Team Scheduler/i);
    assert.match(previewHtml, /forgeweb-professional-v2/);
    assert.match(previewHtml, /aria-label="Primary navigation"/);
    assert.match(previewHtml, /class="workspace-layout"/);

    const editResponse = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Make the navbar smaller and add a glass effect. Keep everything else unchanged." }),
    });
    assert.equal(editResponse.status, 201);
    const editPayload = await editResponse.json() as { modifiedFiles: string[]; workspace: { currentVersion: { versionNumber: number } } };
    assert.equal(editPayload.workspace.currentVersion.versionNumber, 2);
    assert.deepEqual(editPayload.modifiedFiles.sort(), ["frontend/preview.html", "frontend/src/styles.css"]);

    const validateExportResponse = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/export/validate`, { method: "POST" });
    assert.equal(validateExportResponse.status, 200);
    assert.equal((await validateExportResponse.json() as { summary: { validation: string } }).summary.validation, "passed");
    const exportResponse = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/export`, { method: "POST" });
    assert.equal(exportResponse.status, 200);
    assert.equal(exportResponse.headers.get("content-type"), "application/zip");
    assert.equal(Buffer.from(await exportResponse.arrayBuffer()).subarray(0, 2).toString(), "PK");

    const eventsResponse = await fetch(`${baseUrl}/api/builds/${created.build.id}/events`);
    assert.equal(eventsResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const eventStream = await eventsResponse.text();
    assert.match(eventStream, /event: build\.created/);
    assert.match(eventStream, /event: build\.awaiting_confirmation/);
    assert.match(eventStream, /event: build\.confirmed/);
    assert.match(eventStream, /event: build\.completed/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("the HTTP layer enforces the confirmation gate and never leaks secrets or internal paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-gate-test-"));
  const store = new JsonStore(directory);
  await store.initialize();
  // A deliberate per-stage delay keeps the build in a pre-proposal state long
  // enough to prove the gate is enforced by the backend, not by the UI.
  const workflow = new BuildWorkflow(store, 120);
  const server = createForgeWebServer(workflow);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { fetch } = await ownerFixture(baseUrl);
  let buildId: string | undefined;

  try {
    const createResponse = await fetch(`${baseUrl}/api/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Build a task management application with authentication, projects, tasks, due dates, and status tracking." }),
    });
    assert.equal(createResponse.status, 202);
    const created = await createResponse.json() as { build: { id: string; projectId: string; status: string } };
    buildId = created.build.id;
    assert.ok(["queued", "specifying"].includes(created.build.status));

    // Confirming before the architecture proposal exists must be rejected.
    const prematureConfirmation = await fetch(`${baseUrl}/api/builds/${created.build.id}/confirm`, { method: "POST" });
    assert.equal(prematureConfirmation.status, 409);
    assert.equal((await prematureConfirmation.json() as { error: { code: string } }).error.code, "INVALID_BUILD_STATE");

    // The rejected confirmation must not have produced any source code.
    const projectAfterRejection = await fetch(`${baseUrl}/api/projects/${created.build.projectId}`);
    assert.equal((await projectAfterRejection.json() as { files: unknown[] }).files.length, 0);

    // Editing or exporting a project that was never generated is also refused.
    const prematureEdit = await fetch(`${baseUrl}/api/projects/${created.build.projectId}/edits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Make the navbar smaller and add a glass effect." }),
    });
    assert.equal(prematureEdit.status, 409);
    assert.equal((await prematureEdit.json() as { error: { code: string } }).error.code, "PROJECT_NOT_GENERATED");

    // The LLM status endpoint reports configuration without exposing credentials.
    const llmStatusResponse = await fetch(`${baseUrl}/api/llm/status`);
    assert.equal(llmStatusResponse.status, 200);
    const llmStatusText = await llmStatusResponse.text();
    assert.ok(!llmStatusText.includes("test-secret-must-never-be-served"));
    assert.ok(!/api[_-]?key/i.test(llmStatusText));
    const llmStatus = JSON.parse(llmStatusText) as { llm: Record<string, unknown> };
    assert.equal(llmStatus.llm.enabled, false);
    assert.equal(llmStatus.llm.mode, "template-fallback");

    // Unknown resources and routes return generic errors with no host details.
    for (const path of ["/api/projects/project_does_not_exist", "/api/builds/build_does_not_exist", "/api/not-a-route"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 404);
      const text = await response.text();
      assert.ok(!text.includes(directory), `error response leaked an internal path: ${path}`);
      assert.ok(!text.includes(tmpdir()));
      assert.ok(!/\bat \S+:\d+:\d+/.test(text), `error response leaked a stack trace: ${path}`);
    }
  } finally {
    // The build is intentionally left unconfirmed. Let it settle at the gate
    // before tearing down its store so no background stage writes to a removed
    // directory. `awaiting_confirmation` is quiescent: the workflow stops there
    // until an explicit confirmation arrives.
    for (let attempt = 0; buildId && attempt < 300; attempt += 1) {
      if (["awaiting_confirmation", "needs_context", "completed", "failed"].includes(workflow.get(buildId).status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
