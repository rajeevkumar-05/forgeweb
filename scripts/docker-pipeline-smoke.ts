import "../server/env.ts";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createForgeWebServer } from "../server/app.ts";
import { JsonStore } from "../server/store.ts";
import { BuildWorkflow } from "../server/workflow.ts";
import { SafeGenerationActivationService } from "../server/generation/activation.ts";
import { dockerWorkflowFromEnvironment } from "../server/generation/docker-infrastructure.ts";
import { getLlmProvider, getLlmStatus } from "../server/llm/index.ts";

// This trusted diagnostic harness never executes generated source on the host.
// It uses the actual authenticated API, approvals and Docker-backed pipeline,
// with an empty disposable control-plane store rather than user project data.
const directory = await mkdtemp(join(tmpdir(), "forgeweb-docker-smoke-"));
const store = new JsonStore(directory);
await store.initialize();
const infrastructure = dockerWorkflowFromEnvironment({ ...process.env, FORGEWEB_DOCKER_ENABLED: "true" });
const token = randomBytes(32).toString("hex");
const activation = new SafeGenerationActivationService(store, {
  enabled: true, token, ownerId: "docker-smoke-owner", subjectId: "docker-smoke-subject",
}, infrastructure.options);
const server = createForgeWebServer(new BuildWorkflow(store), activation);
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function json(path: string, payload?: unknown, cookie?: string) {
  const response = await fetch(origin + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (!response.ok) throw new Error(`SMOKE_HTTP_${response.status}`);
  return { value: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

try {
  const health = await json("/api/health");
  console.log(JSON.stringify({ apiStarted: Boolean(health.value) }));
  const status = await getLlmStatus();
  let connectivity = false;
  if (status.available) {
    try {
      await getLlmProvider().generate("Reply with OK only.", { maxTokens: 128 });
      connectivity = true;
    } catch { /* No response payload or provider exception is printed. */ }
  }
  console.log(JSON.stringify({ groq: { provider: status.provider, model: status.model, available: status.available, realRequest: connectivity } }));
  const account = await json("/api/auth/register", { username: "docker-smoke", password: randomBytes(32).toString("hex") });
  const session = await json("/api/safe/session", { token }, account.cookie);
  session.cookie = `${account.cookie}; ${session.cookie}`;
  const created = await json("/api/safe/builds", {
    prompt: "Build a simple task management application where users can create, edit, delete, and mark tasks as completed. Roles: Admin and User. Authentication: email and password. Payments: none. External integrations: none.",
  }, session.cookie);
  console.log(JSON.stringify({ requirements: created.value.build.specification?.requirements?.length ?? created.value.build.requirements?.length,
    approvalRequired: created.value.build.status === "awaiting_confirmation" }));
  const confirmed = await json(`/api/safe/builds/${created.value.build.id}/confirm`, {}, session.cookie);
  const database = store.read();
  const candidate = Object.values(database.generationCandidates)[0];
  console.log(JSON.stringify({
    generation: confirmed.value.generation,
    backendFiles: candidate?.candidate.files.filter((file) => file.path.startsWith("backend/")).length ?? 0,
    frontendFiles: candidate?.candidate.files.filter((file) => file.path.startsWith("frontend/")).length ?? 0,
    candidateAssembled: Boolean(candidate), engineeringGraph: Boolean(candidate?.engineeringGraph),
    validationChecks: candidate?.validation?.checks.map((check) => ({ id: check.id, status: check.status, evidence: check.evidence })),
    acceptedVersions: Object.keys(database.versions).length,
    execution: candidate?.validation?.execution.kind,
  }));
  if (confirmed.value.generation.status !== "accepted" || confirmed.value.generation.validation !== "passed" || confirmed.value.generation.runtime !== "ready") process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ failure: error instanceof Error && /^SMOKE_HTTP_\d+$/.test(error.message) ? error.message : "SMOKE_TEST_FAILED" }));
  process.exitCode = 1;
} finally {
  await infrastructure.dispose();
  await new Promise<void>((done) => { server.close(done); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ temporaryServicesStopped: true }));
}
