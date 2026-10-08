import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const selection = await import(new URL("../../src/lib/project-selection.ts", import.meta.url).href);
const source = (await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const projectId = "project_0123456789abcdef0123";
const otherProjectId = "project_abcdef0123456789abcd";

test("reload selection contains only a canonical project ID and retains unrelated navigation", () => {
  const href = selection.projectSelectionUrl("http://localhost:5173/?view=files#top", projectId);
  assert.equal(selection.selectedProjectId(href), projectId);
  assert.equal(new URL(href).searchParams.get("view"), "files");
  assert.equal(new URL(href).hash, "#top");
  for (const invalid of ["token-value", "https://evil.test", "../project", "project_%00"]) {
    assert.equal(selection.selectedProjectId(`http://localhost/?project=${encodeURIComponent(invalid)}`), undefined);
    assert.equal(new URL(selection.projectSelectionUrl(href, invalid)).searchParams.has("project"), false);
  }
  assert.equal(new URL(selection.projectSelectionUrl(href)).searchParams.has("project"), false);
});

type SavedBuild = { id: string; projectId: string; generationMode: "legacy" | "safe"; status: string; stageDetail: string };
type Workspace = { project: { currentBuildId?: string } };
const savedBuild = (id = projectId, generationMode: "legacy" | "safe" = "legacy"): SavedBuild => ({
  id: `build-${id}`, projectId: id, generationMode, status: "completed", stageDetail: "Accepted snapshot",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// Run Hero's real state/effects and action closures; only React scheduling, browser history and API I/O are substituted.
const heroBody = source.slice(source.indexOf("function Hero() {") + "function Hero() {".length, source.indexOf('\n  return (\n    <section id="top"'));
assert.ok(heroBody.includes("const launchDemo") && heroBody.includes("const handleProjectDeleted"));
assert.match(source, /onDeleted=\{handleProjectDeleted\}/);
const newAction = source.match(/onNew=\{(\(\) => \{[^\n]+\})\}/)![1];
const stateNames = [...heroBody.matchAll(/const \[(\w+),[^\n]+?= useState/g)].map(match => match[1]);
const renderHero = new Function("d", `const {useState,useRef,useEffect,window,document,console,buildStages,visibleBuildStage,visibleBuildDetail,
selectedProjectId,projectSelectionUrl,getOwnerSession,getSafeGenerationStatus,getLlmStatus,getProjectWorkspace,getBuild,
activateSafeGeneration,createBuild,createSafeBuild,confirmBuild,confirmSafeBuild,waitForBuild,reviseBuild}=d;
${stripTypeScriptTypes(heroBody)}
return {launchDemo,handleProjectDeleted,openSavedProject,refreshOwner,newProject:${newAction}};`);

function appHarness(options: {
  href?: string;
  mode?: "legacy" | "safe";
  workspace?: (id: string) => Promise<Workspace>;
  build?: (id: string) => Promise<SavedBuild>;
  create?: () => Promise<SavedBuild>;
} = {}) {
  type Hook = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
  const hooks: Hook[] = [], states = new Map<string, Hook>();
  const events = new EventTarget();
  const location = { href: options.href ?? `http://localhost:5173/?project=${projectId}#top` };
  const entries = [location.href]; let entry = 0;
  const history = {
    replaceState(_state: unknown, _unused: string, href: string) { location.href = entries[entry] = href; },
    pushState(_state: unknown, _unused: string, href: string) { entries.splice(++entry); location.href = entries[entry] = href; },
    back() { if (entry > 0) { location.href = entries[--entry]; events.dispatchEvent(new Event("popstate")); } },
    forward() { if (entry < entries.length - 1) { location.href = entries[++entry]; events.dispatchEvent(new Event("popstate")); } },
  };
  const calls = { workspace: [] as string[], build: [] as string[], create: [] as string[] };
  let cursor = 0, stateCursor = 0, dirty = false;
  let effects: Array<() => void> = [];
  let actions!: {
    launchDemo: (event: { preventDefault: () => void }) => Promise<void>;
    handleProjectDeleted: (id: string) => void;
    openSavedProject: (build: SavedBuild) => void;
    refreshOwner: () => Promise<void>;
    newProject: () => void;
  };
  const dependencies = {
    ...selection,
    useState(initial: unknown) {
      const index = cursor++, name = stateNames[stateCursor++];
      const hook = hooks[index] ??= { value: name === "workflowMode" ? options.mode ?? initial : initial };
      states.set(name, hook);
      return [hook.value, (value: unknown) => {
        const next = typeof value === "function" ? value(hook.value) : value;
        if (!Object.is(next, hook.value)) { hook.value = next; dirty = true; }
      }];
    },
    useRef(initial: unknown) { return (hooks[cursor++] ??= { value: { current: initial } }).value; },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) {
      const hook = hooks[cursor++] ??= {};
      if (!hook.deps || deps.some((value, index) => !Object.is(value, hook.deps![index]))) {
        hook.deps = deps;
        effects.push(() => { hook.cleanup?.(); hook.cleanup = effect() || undefined; });
      }
    },
    window: { location, history, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), scrollTo() {} },
    document: { getElementById() { return null; } }, console: { log() {}, error() {} },
    buildStages: Array.from({ length: 4 }, () => ({ icon: null })),
    visibleBuildStage() { return 3; }, visibleBuildDetail(build: SavedBuild) { return build.stageDetail; },
    async getOwnerSession() { return { user: { id: "test-owner" }, migration: { standard: 0, verified: 0 } }; },
    async getSafeGenerationStatus() { return { enabled: true, authenticated: true }; },
    async getLlmStatus() { return null; },
    async getProjectWorkspace(id: string) { calls.workspace.push(id); return options.workspace ? options.workspace(id) : { project: { currentBuildId: `build-${id}` } }; },
    async getBuild(id: string) { calls.build.push(id); return options.build ? options.build(id) : savedBuild(id.slice("build-".length), options.mode); },
    async createBuild() { calls.create.push("legacy"); return options.create ? options.create() : savedBuild(otherProjectId); },
    async createSafeBuild() { calls.create.push("safe"); return options.create ? options.create() : savedBuild(otherProjectId, "safe"); },
    async waitForBuild(id: string, progress: (build: SavedBuild) => void) { const result = savedBuild(id.slice("build-".length), options.mode); progress(result); return result; },
    activateSafeGeneration() { assert.fail("authenticated fixture must not activate again"); },
    confirmBuild() { assert.fail("unexpected confirmation"); }, confirmSafeBuild() { assert.fail("unexpected confirmation"); }, reviseBuild() { assert.fail("unexpected revision"); },
  };
  function render() { cursor = stateCursor = 0; dirty = false; actions = renderHero(dependencies); }
  render();
  return {
    calls, location, history,
    get actions() { return actions; },
    state() { return {
      build: states.get("build")?.value as SavedBuild | null,
      running: states.get("running")?.value as boolean,
      detail: states.get("statusDetail")?.value as string,
      refreshToken: states.get("projectRefreshToken")?.value as number,
      mode: states.get("workflowMode")?.value,
    }; },
    async flush() {
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
        if (dirty) render();
        const pending = effects; effects = []; pending.forEach(effect => effect());
      }
      assert.equal(dirty, false, "component effects must settle without a render loop");
    },
    dispose() { hooks.forEach(hook => hook.cleanup?.()); },
  };
}

test("App refresh reopens both workflow modes through authorized workspace and build APIs", async () => {
  for (const mode of ["legacy", "safe"] as const) {
    const app = appHarness({ mode }); await app.flush();
    assert.deepEqual(app.calls.workspace, [projectId]);
    assert.deepEqual(app.calls.build, [`build-${projectId}`]);
    assert.equal(app.state().build?.projectId, projectId); assert.equal(app.state().mode, mode);
    app.dispose();
  }
});

test("App clears unauthorized, deleted, missing-build and mismatched selections without leaking errors", async () => {
  for (const failure of ["workspace", "missing-build", "build", "mismatch"]) {
    const app = appHarness({
      async workspace() { if (failure === "workspace") throw Error("private-error-token"); return { project: failure === "missing-build" ? {} : { currentBuildId: "build-1" } }; },
      async build() { if (failure === "build") throw Error("private-error-token"); return savedBuild(otherProjectId); },
    });
    await app.flush();
    assert.equal(app.state().build, null); assert.equal(selection.selectedProjectId(app.location.href), undefined);
    assert.match(app.state().detail, /Select an owned project/); assert.ok(!app.state().detail.includes("private-error"));
    app.dispose();
  }
});

test("actual generation start cancels both restoration awaits and preserves failure state in Standard and Verified", async () => {
  for (const mode of ["legacy", "safe"] as const) for (const stage of ["workspace", "build"]) {
    const workspace = deferred<Workspace>(), oldBuild = deferred<SavedBuild>(), generation = deferred<SavedBuild>();
    const app = appHarness({ mode,
      workspace: stage === "workspace" ? () => workspace.promise : undefined,
      build: stage === "build" ? () => oldBuild.promise : undefined,
      create: () => generation.promise,
    });
    await app.flush(); assert.equal(app.state().build, null);
    const pending = app.actions.launchDemo({ preventDefault() {} }); await app.flush();
    assert.equal(app.state().running, true); assert.equal(selection.selectedProjectId(app.location.href), undefined);
    await app.actions.launchDemo({ preventDefault() {} });
    assert.deepEqual(app.calls.create, [mode], "an already-running generation must not submit another request");
    workspace.resolve({ project: { currentBuildId: `build-${projectId}` } }); oldBuild.resolve(savedBuild(projectId, mode));
    await app.flush(); assert.equal(app.state().build, null);
    generation.reject(Error("Test generation request rejected")); await pending; await app.flush();
    assert.equal(app.state().build, null); assert.equal(app.state().running, false);
    assert.equal(app.state().detail, "Build stopped — Test generation request rejected");
    assert.deepEqual(app.calls.create, [mode]);
    if (stage === "workspace") assert.equal(app.calls.build.length, 0);
    app.dispose();
  }
});

test("actual generation action still completes and selects its new project in both workflow modes", async () => {
  for (const mode of ["legacy", "safe"] as const) {
    const oldBuild = deferred<SavedBuild>();
    const app = appHarness({ mode, build: () => oldBuild.promise }); await app.flush();
    await app.actions.launchDemo({ preventDefault() {} }); await app.flush();
    oldBuild.resolve(savedBuild(projectId, mode)); await app.flush();
    assert.equal(app.state().build?.projectId, otherProjectId); assert.equal(app.state().running, false);
    assert.equal(app.state().mode, mode); assert.equal(selection.selectedProjectId(app.location.href), otherProjectId);
    app.dispose();
  }
});

for (const outcome of ["success", "failure"] as const) {
  test(`active generation blocks competing Back/Forward restoration on ${outcome} in both workflow modes`, async () => {
    for (const mode of ["legacy", "safe"] as const) {
      const generation = deferred<SavedBuild>();
      const app = appHarness({ mode, create: () => generation.promise }); await app.flush();
      assert.equal(app.state().build?.projectId, projectId);
      app.history.pushState(null, "", selection.projectSelectionUrl("http://localhost:5173/#system", projectId));
      app.history.pushState(null, "", selection.projectSelectionUrl("http://localhost:5173/#languages", projectId));
      app.history.back(); await app.flush();
      const workspaceCalls = [...app.calls.workspace], buildCalls = [...app.calls.build];
      const pending = app.actions.launchDemo({ preventDefault() {} });
      const generationDetail = app.state().detail;
      // Fire before the busy render as well: the listener must observe the current action.
      app.history.back(); await app.flush();
      assert.equal(app.state().running, true); assert.equal(app.state().build, null);
      assert.equal(app.state().detail, generationDetail);
      assert.equal(selection.selectedProjectId(app.location.href), undefined);
      assert.equal(new URL(app.location.href).hash, "#top");
      app.history.forward(); await app.flush();
      assert.equal(new URL(app.location.href).hash, "#system");
      app.history.forward(); await app.flush();
      assert.equal(new URL(app.location.href).hash, "#languages");
      assert.equal(selection.selectedProjectId(app.location.href), undefined);
      assert.equal(app.state().build, null); assert.equal(app.state().detail, generationDetail);
      assert.deepEqual(app.calls.workspace, workspaceCalls, "busy history must not start workspace restoration");
      assert.deepEqual(app.calls.build, buildCalls, "busy history must not load another project's build");
      assert.deepEqual(app.calls.create, [mode]);
      if (outcome === "success") generation.resolve(savedBuild(otherProjectId, mode));
      else generation.reject(Error("Test generation request rejected"));
      await pending; await app.flush();
      assert.equal(app.state().running, false); assert.equal(app.state().mode, mode);
      if (outcome === "success") {
        assert.equal(app.state().build?.projectId, otherProjectId);
        assert.equal(selection.selectedProjectId(app.location.href), otherProjectId);
        assert.equal(app.state().detail, "Accepted snapshot");
      } else {
        assert.equal(app.state().build, null);
        assert.equal(selection.selectedProjectId(app.location.href), undefined);
        assert.equal(app.state().detail, "Build stopped — Test generation request rejected");
      }
      // The same listener must resume normal authorized restoration after busy ends.
      app.history.pushState(null, "", selection.projectSelectionUrl(app.location.href, projectId));
      app.history.back(); await app.flush(); app.history.forward(); await app.flush();
      assert.equal(app.state().build?.projectId, projectId);
      assert.equal(selection.selectedProjectId(app.location.href), projectId);
      assert.equal(app.calls.workspace.length, workspaceCalls.length + 1);
      app.dispose();
    }
  });
}

test("actual deletion callback cancels a URL-selected restoration while build is null", async () => {
  for (const stage of ["workspace", "build"]) {
    const workspace = deferred<Workspace>(), oldBuild = deferred<SavedBuild>();
    const app = appHarness({ workspace: stage === "workspace" ? () => workspace.promise : undefined, build: stage === "build" ? () => oldBuild.promise : undefined });
    await app.flush(); assert.equal(app.state().build, null);
    app.actions.handleProjectDeleted(projectId); await app.flush();
    workspace.resolve({ project: { currentBuildId: `build-${projectId}` } }); oldBuild.resolve(savedBuild()); await app.flush();
    assert.equal(app.state().build, null); assert.equal(selection.selectedProjectId(app.location.href), undefined);
    assert.equal(app.state().detail, "Project deleted."); assert.equal(app.state().refreshToken, 1);
    if (stage === "workspace") assert.equal(app.calls.build.length, 0);
    app.dispose();
  }
});

test("deleting an unrelated project preserves both pending and displayed selections", async () => {
  const oldBuild = deferred<SavedBuild>();
  const app = appHarness({ build: () => oldBuild.promise }); await app.flush();
  app.actions.handleProjectDeleted(otherProjectId); await app.flush();
  oldBuild.resolve(savedBuild()); await app.flush();
  assert.equal(app.state().build?.projectId, projectId); assert.equal(selection.selectedProjectId(app.location.href), projectId);
  app.actions.handleProjectDeleted(otherProjectId); await app.flush();
  assert.equal(app.state().build?.projectId, projectId); assert.equal(app.state().refreshToken, 2);
  app.actions.handleProjectDeleted(projectId); await app.flush();
  assert.equal(app.state().build, null); assert.equal(selection.selectedProjectId(app.location.href), undefined);
  app.dispose();
});

test("actual account refresh, New Project and newer sidebar selection cancel pending restoration", async () => {
  for (const action of ["refreshOwner", "newProject", "openSavedProject"] as const) {
    const oldBuild = deferred<SavedBuild>();
    const app = appHarness({ build: () => oldBuild.promise }); await app.flush();
    if (action === "openSavedProject") app.actions.openSavedProject(savedBuild(otherProjectId));
    else await app.actions[action]();
    await app.flush(); oldBuild.resolve(savedBuild()); await app.flush();
    assert.equal(app.state().build?.projectId, action === "openSavedProject" ? otherProjectId : undefined);
    app.dispose();
  }
  assert.ok(!/localStorage|sessionStorage|activationToken|previewUrl/.test(await readFile(new URL("../../src/lib/project-selection.ts", import.meta.url), "utf8")));
});

test("Back and Forward reconcile project IDs through authorized APIs without reloading for hash-only navigation", async () => {
  const app = appHarness(); await app.flush();
  app.history.pushState(null, "", selection.projectSelectionUrl("http://localhost:5173/#system", projectId));
  app.actions.openSavedProject(savedBuild(otherProjectId, "safe")); await app.flush();
  assert.equal(app.state().build?.projectId, otherProjectId);
  app.history.back(); await app.flush();
  assert.equal(selection.selectedProjectId(app.location.href), projectId);
  assert.equal(app.state().build?.projectId, projectId);
  app.history.forward(); await app.flush();
  assert.equal(app.state().build?.projectId, otherProjectId);
  const count = app.calls.workspace.length;
  app.history.pushState(null, "", selection.projectSelectionUrl("http://localhost:5173/#languages", otherProjectId));
  app.history.back(); await app.flush(); app.history.forward(); await app.flush();
  assert.equal(app.calls.workspace.length, count);
  app.dispose();
});

test("a later history selection wins over a delayed earlier restoration", async () => {
  const lateBuild = deferred<SavedBuild>(); let first = true;
  const app = appHarness({ async build(id) {
    if (id === `build-${projectId}`) {
      if (!first) return lateBuild.promise;
      first = false;
    }
    return savedBuild(id.slice("build-".length), id === `build-${otherProjectId}` ? "safe" : "legacy");
  } });
  await app.flush();
  app.history.pushState(null, "", selection.projectSelectionUrl("http://localhost:5173/#system", projectId));
  app.actions.openSavedProject(savedBuild(otherProjectId, "safe")); await app.flush();
  app.history.back(); await app.flush(); assert.equal(app.state().build, null);
  app.history.forward(); await app.flush();
  lateBuild.resolve(savedBuild()); await app.flush();
  assert.equal(app.state().build?.projectId, otherProjectId); assert.equal(app.state().mode, "safe");
  assert.equal(selection.selectedProjectId(app.location.href), otherProjectId);
  app.dispose();
});

test("history navigation to an unauthorized project fails closed through the existing workspace API", async () => {
  const app = appHarness({ async workspace(id) {
    if (id === otherProjectId) throw Error("private-error-token");
    return { project: { currentBuildId: `build-${id}` } };
  } });
  await app.flush();
  app.history.pushState(null, "", selection.projectSelectionUrl(app.location.href, otherProjectId));
  app.history.back(); await app.flush(); app.history.forward(); await app.flush();
  assert.deepEqual(app.calls.workspace, [projectId, otherProjectId]);
  assert.deepEqual(app.calls.build, [`build-${projectId}`]);
  assert.equal(app.state().build, null); assert.equal(selection.selectedProjectId(app.location.href), undefined);
  assert.match(app.state().detail, /Select an owned project/); assert.ok(!app.state().detail.includes("private-error"));
  app.dispose();
});

test("history navigation without a project clears selection and can reopen it on Forward", async () => {
  const app = appHarness({ href: "http://localhost:5173/#top" }); await app.flush();
  assert.equal(app.calls.workspace.length, 0);
  app.history.pushState(null, "", "http://localhost:5173/#system");
  app.actions.openSavedProject(savedBuild()); await app.flush();
  app.history.back(); await app.flush();
  assert.equal(app.state().build, null); assert.equal(selection.selectedProjectId(app.location.href), undefined);
  assert.equal(app.calls.workspace.length, 0);
  app.history.forward(); await app.flush();
  assert.equal(app.state().build?.projectId, projectId); assert.deepEqual(app.calls.workspace, [projectId]);
  app.dispose();
});

test("disposing the App effect removes history listeners and invalidates pending restoration", async () => {
  const lateBuild = deferred<SavedBuild>();
  const app = appHarness({ build: () => lateBuild.promise }); await app.flush();
  app.history.pushState(null, "", selection.projectSelectionUrl(app.location.href, otherProjectId));
  app.dispose();
  lateBuild.resolve(savedBuild()); await app.flush();
  app.history.back(); app.history.forward(); await app.flush();
  assert.equal(app.state().build, null); assert.deepEqual(app.calls.workspace, [projectId]);
});
