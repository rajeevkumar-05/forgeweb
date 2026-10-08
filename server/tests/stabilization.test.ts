import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SafeGenerationActivationService } from "../generation/activation.ts";
import { ApiError } from "../lib.ts";
import { JsonStore } from "../store.ts";
import { SandboxExecutionError } from "../generation/runner.ts";
import { CombinedValidationRunner, ForgeWebPostgresValidator } from "../generation/postgres-validation.ts";
import { ForgeWebIsolatedRunner } from "../generation/runner.ts";
import { validationRunner } from "./generation-integration-fixture.ts";

test("malformed Verified cookies are unauthenticated rather than server errors", () => {
  const service = new SafeGenerationActivationService(new JsonStore(tmpdir()), {
    enabled: true, token: "test-only-malformed-cookie-token-00000000", ownerId: "owner", subjectId: "owner",
  });
  for (const value of ["%", "%ZZ", "%E0%A4%A", "forged"]) {
    const request = { headers: { cookie: `forgeweb_safe_session=${value}` } } as IncomingMessage;
    assert.equal(service.status(request, "owner").authenticated, false);
    assert.throws(() => service.requireActor(request, "owner"), error => error instanceof ApiError && error.status === 401);
  }
});

test("failed generated typecheck is identified without accepting a version or leaking executor text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-stabilization-"));
  const store = new JsonStore(directory);
  await store.initialize();
  const actor = { kind: "authenticated" as const, ownerId: "owner", subjectId: "owner" };
  const service = new SafeGenerationActivationService(store, {
    enabled: true, token: "test-only-validation-detail-token-000000", ownerId: "owner", subjectId: "owner",
  }, { validationRunner: validationRunner("backend/src/modules/tasks/task.service.ts") });
  try {
    const build = await service.create("Build a task management application. Users can create, edit and view tasks. Tasks have title and description. No payments.", actor);
    const result = await service.confirm(build.id, actor);
    assert.equal(result.generation.status, "validation_failed");
    assert.equal(result.build.error?.code, "VALIDATION_FAILED");
    assert.match(result.build.error!.message, /typecheck/);
    assert.equal(Object.keys(store.read().versions).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preview unavailability cannot misrepresent successful validation or acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-stabilization-preview-"));
  const store = new JsonStore(directory); await store.initialize();
  const actor = { kind: "authenticated" as const, ownerId: "owner", subjectId: "owner" };
  const service = new SafeGenerationActivationService(store, {
    enabled: true, token: "test-only-preview-detail-token-000000000", ownerId: "owner", subjectId: "owner",
  }, { validationRunner: validationRunner() });
  try {
    const build = await service.create("Build a task management application. Users can create and view tasks. Tasks have title. No payments.", actor);
    const result = await service.confirm(build.id, actor);
    assert.equal(result.generation.status, "accepted");
    assert.equal(Object.keys(store.read().versions).length, 1);
    assert.match(result.build.stageDetail, /accepted after successful validation/);
    assert.match(result.build.stageDetail, /Open Preview/);
    assert.doesNotMatch(result.build.stageDetail, /not executed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("delayed project opening cannot restore a prior owner's project", async () => {
  const source = await readFile(new URL("../../src/components/ProjectLibrary.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  const openProject ="), source.indexOf("  const [deleting"));
  const bind = new Function("d", `const { busy, loadSequence, openingSequence, setOpening, setError, getProjectWorkspace, getBuild, onOpen, setOpen } = d; ${stripTypeScriptTypes(handler)}; return openProject;`);
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  const loadSequence = { current: 1 };
  let opened = 0; let buildRequests = 0;
  const open = bind({ busy: false, loadSequence, openingSequence: { current: 0 }, setOpening() {}, setError() {}, setOpen() {},
    getProjectWorkspace: () => ready, async getBuild() { buildRequests++; return {}; }, onOpen() { opened++; },
  });
  const pending = open({ id: "owner-a-project", currentBuildId: "owner-a-build" });
  loadSequence.current++;
  resolve();
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout() {} } });
  try { await pending; assert.equal(opened, 0); assert.equal(buildRequests, 0); }
  finally { if (before) Object.defineProperty(globalThis, "window", before); else Reflect.deleteProperty(globalThis, "window"); }
});

test("out-of-order workspace loads cannot replace the latest selected project", async () => {
  const source = await readFile(new URL("../../src/components/ProjectWorkspace.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  const loadWorkspace ="), source.indexOf("  useEffect(() =>"));
  const bind = new Function("d", `const { projectId, workspaceSequence, setLoading, setWorkspaceError, setWorkspace, getProjectWorkspace } = d; const useCallback = action => action; ${stripTypeScriptTypes(handler)}; return loadWorkspace;`);
  const responses: (() => void)[] = [];
  const selected: string[] = [];
  const workspaceSequence = { current: 0 };
  const dependencies = { workspaceSequence, setLoading() {}, setWorkspaceError() {},
    setWorkspace(value: { project: { id: string } }) { selected.push(value.project.id); },
    getProjectWorkspace(id: string) { return new Promise(done => { responses.push(() => done({ project: { id } })); }); },
  };
  const a = bind({ ...dependencies, projectId: "a" })();
  const b = bind({ ...dependencies, projectId: "b" })();
  responses[1](); await b;
  responses[0](); await a;
  assert.deepEqual(selected, ["b"]);
});

test("the most recent project selection wins even when an earlier build response finishes last", async () => {
  const source = await readFile(new URL("../../src/components/ProjectLibrary.tsx", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("  const openProject ="), source.indexOf("  const [deleting"));
  const bind = new Function("d", `const { busy, loadSequence, openingSequence, setOpening, setError, getProjectWorkspace, getBuild, onOpen, setOpen } = d; ${stripTypeScriptTypes(handler)}; return openProject;`);
  const responses = new Map<string, (value: { id: string }) => void>();
  const selected: string[] = [];
  const open = bind({ busy: false, loadSequence: { current: 1 }, openingSequence: { current: 0 }, setOpening() {}, setError() {}, setOpen() {},
    async getProjectWorkspace() {}, getBuild(id: string) { return new Promise(resolve => { responses.set(id, resolve); }); },
    onOpen(build: { id: string }) { selected.push(build.id); },
  });
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout() {} } });
  try {
    const a = open({ id: "a", currentBuildId: "a-build" });
    await new Promise<void>(done => setImmediate(done));
    const b = open({ id: "b", currentBuildId: "b-build" });
    await new Promise<void>(done => setImmediate(done));
    responses.get("b-build")!({ id: "b-build" }); await b;
    responses.get("a-build")!({ id: "a-build" }); await a;
    assert.deepEqual(selected, ["b-build"]);
  } finally { if (before) Object.defineProperty(globalThis, "window", before); else Reflect.deleteProperty(globalThis, "window"); }
});

for (const classification of ["timeout", "engine_unavailable"] as const) {
  test(`${classification} has a safe distinct public message and cannot create a version`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "forgeweb-stabilization-error-"));
    const store = new JsonStore(directory); await store.initialize();
    const runner = new CombinedValidationRunner(new ForgeWebIsolatedRunner({ async execute() {
      throw new SandboxExecutionError("test-only-private-subprocess-message", [{ operation: "health", startedAt: new Date().toISOString(),
        elapsedMs: 1, completed: false, timedOut: classification === "timeout", classification,
        message: "test-only-private-subprocess-message" }]);
    } }), new ForgeWebPostgresValidator());
    const actor = { kind: "authenticated" as const, ownerId: "owner", subjectId: "owner" };
    const service = new SafeGenerationActivationService(store, {
      enabled: true, token: "test-only-distinct-validation-token-000000", ownerId: "owner", subjectId: "owner",
    }, { validationRunner: runner });
    try {
      const build = await service.create("Build a task management application. Users can create and view tasks. Tasks have title. No payments.", actor);
      const result = await service.confirm(build.id, actor);
      assert.equal(result.generation.status, "validation_unavailable");
      assert.match(result.build.error!.message, classification === "timeout" ? /timed out during health/ : /Docker engine is unavailable/);
      assert.ok(!result.build.error!.message.includes("test-only-private"));
      assert.equal(Object.keys(store.read().versions).length, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("runtime smoke prepares its control-plane store under the configured disposable root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-stabilization-smoke-"));
  const primary = new URL("../../.forgeweb-data/forgeweb.json", import.meta.url);
  const before = await readFile(primary).catch(() => undefined);
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/generated-application-runtime-smoke.ts", "scripts/runtime-verification/recipe.json", "new"], {
      cwd: new URL("../../", import.meta.url), encoding: "utf8",
      env: { ...process.env, FORGEWEB_DATA_DIR: directory, FORGEWEB_SAFE_GENERATION_ENABLED: "false" },
      timeout: 15_000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SAFE_CONFIGURATION_REQUIRED/);
    const [prepared] = await readdir(directory);
    assert.match(prepared, /^generated-runtime-verification-/);
    const saved = JSON.parse(await readFile(join(directory, prepared, "forgeweb.json"), "utf8"));
    assert.deepEqual(saved.projects, {});
    assert.deepEqual(await readFile(primary).catch(() => undefined), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
