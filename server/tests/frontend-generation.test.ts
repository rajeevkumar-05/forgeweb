import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKEND_SLICE_CONTRACT_VERSION } from "../generation/backend.ts";
import type { BackendSlice } from "../generation/backend.ts";
import { fileManifestDigest } from "../generation/contract.ts";
import type { GenerationRequest, PlanningRequest } from "../generation/engine.ts";
import { FRONTEND_SLICE_CONTRACT_VERSION, FRONTEND_TARGET_PROFILE } from "../generation/frontend.ts";
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from "../generation/nexarch/adapter.ts";
import { NexArchBackendAdapter } from "../generation/nexarch/backend-adapter.ts";
import type { BackendEmitter } from "../generation/nexarch/backend-adapter.ts";
import { NexArchFrontendAdapter } from "../generation/nexarch/frontend-adapter.ts";
import type { FrontendEmitter } from "../generation/nexarch/frontend-adapter.ts";
import { generateBackend } from "../generation/nexarch/upstream/modules/backend-generator/backend-generator.service.ts";
import { generateFrontend } from "../generation/nexarch/upstream/modules/frontend-generator/frontend-generator.service.ts";
import { planPrompt } from "../generation/planning.ts";
import { digest } from "../lib.ts";
import { JsonStore } from "../store.ts";

const PROMPT = "Build a task management application where users create, edit, assign, delete, and track tasks with authentication.";
const CONFIRMED_AT = "2026-01-02T03:04:05.000Z";

function planningRequest(): PlanningRequest {
  return {
    scope: { projectId: "project-frontend", buildId: "build-frontend", operationId: "operation-frontend", actor: { kind: "authenticated", subjectId: "owner-1", ownerId: "owner-1" } },
    base: { kind: "empty", projectId: "project-frontend", manifestDigest: fileManifestDigest([]), files: [] },
    prompt: PROMPT,
    databaseDialect: "postgresql",
    options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 200, maxTotalBytes: 2_000_000 },
  };
}

async function generationRequest(): Promise<GenerationRequest> {
  const planning = planningRequest();
  const result = await planPrompt(new NexArchPlanningAdapter(), planning);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Planning fixture failed");
  const proposal = result.value;
  if (!proposal.architecture || !proposal.database) throw new Error("Planning fixture is incomplete");
  const architecture = {
    ...proposal.architecture,
    endpoints: proposal.architecture.endpoints.map((endpoint) => endpoint.path.startsWith("/auth") ? endpoint : { ...endpoint, auth: false, roles: [] }),
  };
  const specification: GenerationRequest["approved"]["specification"] = {
    id: "spec-frontend", projectId: planning.scope.projectId, version: 1, status: "approved", prompt: PROMPT,
    productName: proposal.analysis.facets?.productName ?? "Task Manager", summary: PROMPT,
    roles: [...(proposal.analysis.facets?.roles ?? [])], entities: proposal.database.entities.map((entity) => entity.name),
    requirements: proposal.analysis.proposedRequirements.map((requirement, index) => ({ ...requirement, acceptanceCriteria: [...requirement.acceptanceCriteria], id: `REQ-${String(index + 1).padStart(3, "0")}` })),
    assumptions: [...(proposal.analysis.facets?.missingRequirements ?? [])], architecture: architecture.projection,
    createdAt: "2026-01-01T00:00:00.000Z", confirmedAt: CONFIRMED_AT,
  };
  const design = { architecture, database: proposal.database };
  return {
    scope: planning.scope, base: planning.base, options: planning.options, design,
    approved: { planId: "plan-frontend", bindingDigest: "binding-frontend", specification, digest: digest(JSON.stringify(specification)), planDigest: digest(JSON.stringify(design)) },
  };
}

function withDesign(request: GenerationRequest, design: GenerationRequest["design"]): GenerationRequest {
  return { ...request, design, approved: { ...request.approved, planDigest: digest(JSON.stringify(design)) } };
}

async function backendFor(request: GenerationRequest, emitter?: BackendEmitter): Promise<BackendSlice> {
  const result = await new NexArchBackendAdapter(emitter).generate(request);
  if (!result.ok) throw new Error(result.error.message);
  assert.equal(result.ok, true);
  assert.equal(result.value.contractVersion, BACKEND_SLICE_CONTRACT_VERSION);
  return result.value;
}

function emitterWithFile(path: string): FrontendEmitter {
  return (...args) => {
    const project = generateFrontend(...args);
    return { ...project, files: [{ path, content: "export {};\n", language: "typescript" }] };
  };
}

test("Phase 4C returns a typed, frozen, in-memory FrontendSlice", async () => {
  const request = await generationRequest();
  const backend = await backendFor(request);
  const before = structuredClone(request);
  const result = await new NexArchFrontendAdapter().generate(request, backend);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.contractVersion, FRONTEND_SLICE_CONTRACT_VERSION);
  assert.ok(result.value.files.length > 20);
  assert.ok(result.value.files.every((file) => file.path.startsWith("frontend/") && file.digest === digest(file.content)));
  assert.ok(result.value.pages.length && result.value.routes.length && result.value.components.length && result.value.stores.length);
  assert.equal("state" in result.value, false);
  assert.equal("acceptanceState" in result.value, false);
  assert.equal("artifacts" in result.value, false);
  assert.deepEqual(request, before);
  assert.equal(Object.isFrozen(result.value), true);
});

test("BackendSlice capabilities drive generated calls and stub routes remain unavailable", async () => {
  const request = await generationRequest();
  const requirementId = request.approved.specification.requirements[0]?.id ?? "REQ-001";
  const design = { ...request.design, architecture: { ...request.design.architecture, endpoints: [...request.design.architecture.endpoints, { method: "POST", path: "/tasks/archive", description: "Archive tasks", auth: false, roles: [], requirementIds: [requirementId] }] } };
  const input = withDesign(request, design);
  const backend = await backendFor(input);
  const result = await new NexArchFrontendAdapter().generate(input, backend);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const implemented = new Set(backend.routes.filter((route) => route.status === "implemented").map((route) => `${route.method} ${route.path}`));
  assert.ok(result.value.api.generatedCalls.length);
  assert.ok(result.value.api.generatedCalls.every((call) => implemented.has(`${call.method} ${call.path}`)));
  assert.ok(result.value.api.unavailableRoutes.some((route) => route.path === "/api/v1/tasks/archive"));
  assert.equal(result.value.api.generatedCalls.some((call) => call.path === "/api/v1/tasks/archive"), false);
  assert.equal(result.value.files.some((file) => file.content.includes("/tasks/archive")), false);
});

test("entity pages require every emitted CRUD operation to be implemented", async () => {
  const request = await generationRequest();
  const emitter: BackendEmitter = (...args) => {
    const project = generateBackend(...args);
    return { ...project, routes: project.routes.map((route) => route.method === "DELETE" && route.path === "/api/v1/tasks/:id" ? { ...route, implemented: false } : route) };
  };
  const backend = await backendFor(request, emitter);
  const result = await new NexArchFrontendAdapter().generate(request, backend);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const tasks = result.value.pages.find((page) => page.entity === "Tasks");
  assert.equal(tasks?.status, "unavailable");
  assert.equal(tasks?.unavailableReason, "backend-capability-unavailable");
  assert.equal(result.value.api.generatedCalls.some((call) => call.feature === "Tasks"), false);
  assert.equal(result.value.files.some((file) => file.path === "frontend/src/features/tasks/services/tasks.service.ts"), false);
});

test("PostgreSQL and frontend target metadata propagate without runtime credentials", async () => {
  const request = await generationRequest();
  const result = await new NexArchFrontendAdapter().generate(request, await backendFor(request));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.target.frontendProfile, FRONTEND_TARGET_PROFILE);
  assert.equal(result.value.target.databaseDialect, "postgresql");
  assert.equal(result.value.target.databaseProvider, "postgresql");
  assert.equal(result.value.target.databaseProfile, NEXARCH_POSTGRESQL_PLANNING_PROFILE);
  const environment = result.value.files.find((file) => file.path === "frontend/environment.example")?.content ?? "";
  assert.doesNotMatch(environment, /password|secret|token|postgresql:\/\//i);
});

test("generated dependencies stay isolated from ForgeWeb package metadata", async () => {
  const before = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const request = await generationRequest();
  const result = await new NexArchFrontendAdapter().generate(request, await backendFor(request));
  const after = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(after, before);
  assert.equal(result.value.dependencies.runtime.react, "^19.1.0");
  assert.equal(result.value.dependencies.runtime["@tanstack/react-query"], "^5.75.0");
  assert.equal(JSON.parse(after).dependencies.axios, undefined);
});

test("bearer authentication state is memory-only and auth calls require implemented backend routes", async () => {
  const request = await generationRequest();
  const backend = await backendFor(request);
  const result = await new NexArchFrontendAdapter().generate(request, backend);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const authStore = result.value.files.find((file) => file.path === "frontend/src/shared/store/auth.store.ts")?.content ?? "";
  assert.ok(authStore);
  assert.doesNotMatch(authStore, /persist\(|localStorage|sessionStorage|app\.auth/);
  assert.deepEqual(result.value.stores.find((store) => store.name === "auth"), {
    name: "auth", file: "frontend/src/shared/store/auth.store.ts", persisted: false, sensitive: true, requirementIds: [],
  });
  assert.equal(result.value.pages.some((page) => page.kind === "auth"), false);
  assert.equal(result.value.api.generatedCalls.some((call) => call.path.startsWith("/api/v1/auth/")), false);
});

test("requirement traceability covers evidenced pages, feature files, routes, and components", async () => {
  const request = await generationRequest();
  const result = await new NexArchFrontendAdapter().generate(request, await backendFor(request));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const approved = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  const tasks = result.value.pages.find((page) => page.entity === "Tasks");
  assert.ok(tasks?.requirementIds.length);
  assert.ok(result.value.traceability.files.some((file) => file.path.includes("/features/tasks/services/") && file.requirementIds.length));
  assert.ok(result.value.traceability.components.some((component) => component.file.includes("/features/tasks/") && component.requirementIds.length));
  assert.ok(result.value.traceability.pages.flatMap((page) => page.requirementIds).every((id) => approved.has(id)));
  assert.ok(result.value.traceability.untracedFiles.every((file) => file.reason === "shared-infrastructure"));
});

test("identical approved request and BackendSlice produce deterministic frontend output", async () => {
  const request = await generationRequest();
  const backend = await backendFor(request);
  const adapter = new NexArchFrontendAdapter();
  const first = await adapter.generate(request, backend);
  const second = await adapter.generate(structuredClone(request), structuredClone(backend));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
  assert.equal(first.value.determinism.outputDigest, second.value.determinism.outputDigest);
});

test("absolute, drive, UNC, traversal, and protected frontend paths are rejected", async (t) => {
  const cases = ["/absolute.tsx", "C:/drive.tsx", "\\\\host\\share.tsx", "../escape.tsx", "server/app.ts"];
  const request = await generationRequest();
  const backend = await backendFor(request);
  for (const path of cases) {
    await t.test(path, async () => {
      const result = await new NexArchFrontendAdapter(emitterWithFile(path)).generate(request, backend);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "security_failure");
        assert.match(result.error.diagnostics?.[0]?.code ?? "", /PATH/);
      }
    });
  }
});

test("duplicate and case-colliding frontend paths are rejected", async () => {
  const emitter: FrontendEmitter = (...args) => {
    const project = generateFrontend(...args);
    const original = project.files.find((file) => file.path === "package.json")!;
    return { ...project, files: [...project.files, { ...original, path: "PACKAGE.JSON" }] };
  };
  const request = await generationRequest();
  const result = await new NexArchFrontendAdapter(emitter).generate(request, await backendFor(request));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "DUPLICATE_PATH");
});

test("frontend file-count and byte limits return typed failures", async (t) => {
  const original = await generationRequest();
  const backend = await backendFor(original);
  await t.test("file count", async () => {
    const request = { ...original, options: { ...original.options, maxFiles: backend.files.length } };
    const compatibleBackend = await backendFor(request);
    const emitter: FrontendEmitter = (...args) => {
      const project = generateFrontend(...args);
      const template = project.files[0]!;
      const extraFiles = Array.from({ length: compatibleBackend.files.length + 1 }, (_, index) => ({
        ...template,
        path: `budget/file-${index}.ts`,
        content: "export {};\n",
      }));
      return { ...project, files: [...project.files, ...extraFiles] };
    };
    const result = await new NexArchFrontendAdapter(emitter).generate(request, compatibleBackend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "FILE_BUDGET_EXCEEDED");
  });
  await t.test("bytes", async () => {
    const backendBytes = backend.files.reduce((total, file) => total + file.bytes, 0);
    const request = { ...original, options: { ...original.options, maxTotalBytes: backendBytes } };
    const compatibleBackend = await backendFor(request);
    const emitter: FrontendEmitter = (...args) => {
      const project = generateFrontend(...args);
      return {
        ...project,
        files: project.files.map((file) => file.path === "README.md"
          ? { ...file, content: `${file.content}${"x".repeat(backendBytes + 1)}` }
          : file),
      };
    };
    const result = await new NexArchFrontendAdapter(emitter).generate(request, compatibleBackend);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "BYTE_BUDGET_EXCEEDED");
  });
  assert.ok(backend.files.length);
});

test("malformed output and generator exceptions preserve typed diagnostics", async (t) => {
  const request = await generationRequest();
  const backend = await backendFor(request);
  await t.test("malformed", async () => {
    const emitter = (() => null) as unknown as FrontendEmitter;
    const result = await new NexArchFrontendAdapter(emitter).generate(request, backend);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "generation_failure");
      assert.match(result.error.diagnostics?.[0]?.message ?? "", /malformed project/);
      assert.equal("value" in result, false);
    }
  });
  await t.test("thrown diagnostic", async () => {
    const emitter = (() => { throw new Error("frontend diagnostic 42"); }) as FrontendEmitter;
    const result = await new NexArchFrontendAdapter(emitter).generate(request, backend);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.diagnostics?.[0]?.code, "UPSTREAM_GENERATION_FAILED");
      assert.equal(result.error.diagnostics?.[0]?.message, "frontend diagnostic 42");
    }
  });
});

test("frontend generation does not persist files, candidates, acceptance, or ProjectVersions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-frontend-slice-"));
  try {
    const store = new JsonStore(directory);
    await store.initialize();
    const before = store.read();
    const request = await generationRequest();
    const result = await new NexArchFrontendAdapter().generate(request, await backendFor(request));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(store.read(), before);
    assert.equal("candidate" in result.value, false);
    assert.equal("version" in result.value, false);
    assert.equal("acceptanceState" in result.value, false);
    const reopened = new JsonStore(directory);
    await reopened.initialize();
    assert.deepEqual(reopened.read(), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
