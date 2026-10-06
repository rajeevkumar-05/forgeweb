import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKEND_SLICE_CONTRACT_VERSION } from "../generation/backend.ts";
import { fileManifestDigest } from "../generation/contract.ts";
import type { GenerationRequest, PlanningRequest } from "../generation/engine.ts";
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from "../generation/nexarch/adapter.ts";
import { NexArchBackendAdapter } from "../generation/nexarch/backend-adapter.ts";
import { generateBackend } from "../generation/nexarch/upstream/modules/backend-generator/backend-generator.service.ts";
import type { BackendEmitter } from "../generation/nexarch/backend-adapter.ts";
import { planPrompt } from "../generation/planning.ts";
import { digest } from "../lib.ts";
import { JsonStore } from "../store.ts";

const PROMPT = "Build a task management application where users create, edit, assign, delete, and track tasks with authentication.";
const CONFIRMED_AT = "2026-01-02T03:04:05.000Z";

function planningRequest(): PlanningRequest {
  return {
    scope: { projectId: "project-backend", buildId: "build-backend", operationId: "operation-backend", actor: { kind: "authenticated", subjectId: "owner-1", ownerId: "owner-1" } },
    base: { kind: "empty", projectId: "project-backend", manifestDigest: fileManifestDigest([]), files: [] },
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
  const architecture = proposal.architecture;
  const database = proposal.database;
  const specification: GenerationRequest["approved"]["specification"] = {
    id: "spec-backend", projectId: planning.scope.projectId, version: 1, status: "approved", prompt: PROMPT,
    productName: proposal.analysis.facets?.productName ?? "Task Manager", summary: PROMPT,
    roles: [...(proposal.analysis.facets?.roles ?? [])], entities: database.entities.map((entity) => entity.name),
    requirements: proposal.analysis.proposedRequirements.map((requirement, index) => ({ ...requirement, acceptanceCriteria: [...requirement.acceptanceCriteria], id: `REQ-${String(index + 1).padStart(3, "0")}` })),
    assumptions: [...(proposal.analysis.facets?.missingRequirements ?? [])], architecture: architecture.projection,
    createdAt: "2026-01-01T00:00:00.000Z", confirmedAt: CONFIRMED_AT,
  };
  const design = { architecture, database };
  return {
    scope: planning.scope, base: planning.base, options: planning.options, design,
    approved: { planId: "plan-backend", bindingDigest: "binding-backend", specification, digest: digest(JSON.stringify(specification)), planDigest: digest(JSON.stringify(design)) },
  };
}

function withDesign(request: GenerationRequest, design: GenerationRequest["design"]): GenerationRequest {
  return { ...request, design, approved: { ...request.approved, planDigest: digest(JSON.stringify(design)) } };
}

function emitterWithFile(path: string): BackendEmitter {
  return (...args) => {
    const project = generateBackend(...args);
    return { ...project, files: [{ path, content: "export {};\n", language: "typescript" }] };
  };
}

test("Phase 4B returns a typed in-memory BackendSlice with no candidate or acceptance state", async () => {
  const request = await generationRequest();
  const before = structuredClone(request);
  const result = await new NexArchBackendAdapter().generate(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.contractVersion, BACKEND_SLICE_CONTRACT_VERSION);
  assert.ok(result.value.files.length > 10);
  assert.ok(result.value.modules.some((module) => module.crud && module.files.length));
  assert.ok(result.value.files.every((file) => file.path.startsWith("backend/") && file.digest === digest(file.content)));
  assert.equal("state" in result.value, false);
  assert.equal("acceptanceState" in result.value, false);
  assert.equal("validationState" in result.value, false);
  assert.equal("artifacts" in result.value, false);
  assert.deepEqual(request, before);
  assert.equal(Object.isFrozen(result.value), true);
});

test("identical approved inputs produce byte-for-byte deterministic backend output", async () => {
  const request = await generationRequest();
  const adapter = new NexArchBackendAdapter();
  const first = await adapter.generate(request);
  const second = await adapter.generate(structuredClone(request));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
  assert.equal(first.value.determinism.outputDigest, second.value.determinism.outputDigest);
});

test("PostgreSQL Prisma emission is native, placeholder-only, and preserves defaults and FK actions", async () => {
  const result = await new NexArchBackendAdapter().generate(await generationRequest());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const prisma = result.value.files.find((file) => file.path === "backend/prisma/schema.prisma")?.content ?? "";
  const environment = result.value.files.find((file) => file.path === "backend/environment.example")?.content ?? "";
  assert.match(prisma, /provider = "postgresql"/);
  assert.match(prisma, /url\s+= env\("DATABASE_URL"\)/);
  assert.match(prisma, /@db\.Uuid/);
  assert.match(prisma, /@default\(uuid\(\)\)/);
  assert.match(prisma, /@db\.Timestamptz\(3\)/);
  assert.match(prisma, /@updatedAt/);
  assert.match(prisma, /onDelete: SetNull, onUpdate: Cascade/);
  assert.doesNotMatch(prisma, /provider = "mysql"|CHAR\(36\)|ENUM\s*\(|InnoDB|utf8mb4|SET FOREIGN_KEY_CHECKS/i);
  assert.match(environment, /postgresql:\/\/USER:PASSWORD@HOST:5432\/DATABASE\?schema=public/);
  assert.doesNotMatch(environment, /owner-1|mysql:\/\//i);
  assert.equal(result.value.database.provider, "postgresql");
});

test("canonical CRUD routes are implemented while custom routes remain explicit stubs", async () => {
  const request = await generationRequest();
  const requirementId = request.approved.specification.requirements[0]?.id ?? "REQ-001";
  const design = { ...request.design, architecture: { ...request.design.architecture, endpoints: [...request.design.architecture.endpoints, { method: "POST", path: "/tasks/archive", description: "Archive tasks", auth: true, roles: ["Admin"], requirementIds: [requirementId] }] } };
  const result = await new NexArchBackendAdapter().generate(withDesign(request, design));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.value.routes.some((route) => route.path === "/api/v1/tasks" && route.status === "implemented"));
  const custom = result.value.routes.find((route) => route.path === "/api/v1/tasks/archive");
  assert.equal(custom?.status, "stub");
  assert.deepEqual(custom?.requirementIds, [requirementId]);
  assert.deepEqual(custom?.roles, ["Admin"]);
  assert.equal(result.value.capabilities.stubRoutes, result.value.routes.filter((route) => route.status === "stub").length);
});

test("route and module-file traceability uses only approved requirement IDs", async () => {
  const request = await generationRequest();
  const result = await new NexArchBackendAdapter().generate(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const approvedIds = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
  assert.ok(result.value.traceability.routes.some((route) => route.requirementIds.length));
  assert.ok(result.value.traceability.files.some((file) => file.requirementIds.length));
  assert.ok(result.value.traceability.routes.flatMap((route) => route.requirementIds).every((id) => approvedIds.has(id)));
  assert.ok(result.value.traceability.files.flatMap((file) => file.requirementIds).every((id) => approvedIds.has(id)));
  assert.ok(result.value.traceability.untracedFiles.every((file) => file.reason === "shared-infrastructure"));
});

test("generated dependency requirements remain metadata and do not mutate ForgeWeb package.json", async () => {
  const before = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const result = await new NexArchBackendAdapter().generate(await generationRequest());
  const after = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(after, before);
  assert.equal(result.value.dependencies.runtime.express, "^5.1.0");
  assert.equal(result.value.dependencies.runtime["@prisma/client"], "^6.8.0");
  assert.equal(JSON.parse(after).dependencies.express, undefined);
});

test("backend generation does not persist projects, versions, candidates, or files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-backend-slice-"));
  try {
    const store = new JsonStore(directory);
    await store.initialize();
    const before = store.read();
    const result = await new NexArchBackendAdapter().generate(await generationRequest());
    assert.equal(result.ok, true);
    assert.deepEqual(store.read(), before);
    const reopened = new JsonStore(directory);
    await reopened.initialize();
    assert.deepEqual(reopened.read(), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a PostgreSQL label with a mismatched target contract is rejected instead of relabeled", async () => {
  const request = await generationRequest();
  const database = request.design.database!;
  const design = { ...request.design, database: { ...database, target: { ...database.target, provider: "mysql" as const } } };
  const result = await new NexArchBackendAdapter().generate(withDesign(request, design));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "generation_failure");
    assert.match(result.error.diagnostics?.[0]?.message ?? "", /verified PostgreSQL target/);
  }
});

test("absolute, drive, UNC, traversal, and protected ForgeWeb output paths are rejected", async (t) => {
  const cases = ["/absolute.ts", "C:/drive.ts", "\\\\host\\share.ts", "../escape.ts", "server/app.ts"];
  for (const path of cases) {
    await t.test(path, async () => {
      const result = await new NexArchBackendAdapter(emitterWithFile(path)).generate(await generationRequest());
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "security_failure");
        assert.match(result.error.diagnostics?.[0]?.code ?? "", /PATH/);
      }
    });
  }
});

test("duplicate and case-colliding generated paths are rejected", async () => {
  const emitter: BackendEmitter = (...args) => {
    const project = generateBackend(...args);
    const original = project.files.find((file) => file.path === "package.json")!;
    return { ...project, files: [...project.files, { ...original, path: "PACKAGE.JSON" }] };
  };
  const result = await new NexArchBackendAdapter(emitter).generate(await generationRequest());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "DUPLICATE_PATH");
});

test("file-count and byte budgets fail as typed generation errors", async (t) => {
  const original = await generationRequest();
  await t.test("file count", async () => {
    const result = await new NexArchBackendAdapter().generate({ ...original, options: { ...original.options, maxFiles: 1 } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "FILE_BUDGET_EXCEEDED");
  });
  await t.test("bytes", async () => {
    const result = await new NexArchBackendAdapter().generate({ ...original, options: { ...original.options, maxTotalBytes: 64 } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.diagnostics?.[0]?.code, "BYTE_BUDGET_EXCEEDED");
  });
});

test("malformed upstream output and thrown failures return diagnostics without candidate/version state", async (t) => {
  await t.test("malformed", async () => {
    const emitter = (() => null) as unknown as BackendEmitter;
    const result = await new NexArchBackendAdapter(emitter).generate(await generationRequest());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "generation_failure");
      assert.equal("value" in result, false);
      assert.match(result.error.diagnostics?.[0]?.message ?? "", /malformed project/);
    }
  });
  await t.test("thrown diagnostic", async () => {
    const emitter = (() => { throw new Error("upstream diagnostic 42"); }) as BackendEmitter;
    const result = await new NexArchBackendAdapter(emitter).generate(await generationRequest());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.diagnostics?.[0]?.code, "UPSTREAM_GENERATION_FAILED");
      assert.equal(result.error.diagnostics?.[0]?.message, "upstream diagnostic 42");
      assert.equal("candidate" in result, false);
      assert.equal("version" in result, false);
    }
  });
});
