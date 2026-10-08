import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = await readFile(new URL("../../src/components/ProjectLibrary.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
const loaderSource = source.slice(source.indexOf("  const [projects"), source.indexOf("  const openProject"));

type Hook = { value?: unknown; dependencies?: unknown[]; cleanup?: () => void };
type Project = { id: string; name: string; status: string; createdAt: string; updatedAt: string };
const standard: Project = { id: "standard-id", name: "Standard", status: "ready", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const verified = { ...standard, id: "verified-id", name: "Verified" };

// Execute the component's actual loader/hooks; no DOM dependency or copied loader logic.
function library(listProjects: () => Promise<Project[]>) {
  const hooks: Hook[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  const different = (a: unknown[] | undefined, b: unknown[]) => !a || a.length !== b.length || a.some((v, i) => v !== b[i]);
  const slot = () => hooks[cursor++] ?? (hooks[cursor - 1] = {});
  const react = {
    useState(initial: unknown) {
      const hook = slot();
      if (!Object.hasOwn(hook, "value")) hook.value = initial;
      return [hook.value, (value: unknown) => { hook.value = typeof value === "function" ? value(hook.value) : value; }];
    },
    useRef(initial: unknown) {
      const hook = slot();
      if (!hook.value) hook.value = { current: initial };
      return hook.value;
    },
    useCallback(action: unknown, dependencies: unknown[]) {
      const hook = slot();
      if (different(hook.dependencies, dependencies)) { hook.value = action; hook.dependencies = dependencies; }
      return hook.value;
    },
    useEffect(action: () => (() => void), dependencies: unknown[]) {
      const hook = slot();
      if (different(hook.dependencies, dependencies)) effects.push(() => {
        hook.cleanup?.();
        hook.dependencies = dependencies;
        hook.cleanup = action();
      });
    },
  };
  const component = new Function("d", `
    const { useState, useRef, useCallback, useEffect, listProjects } = d;
    return function({ userId, refreshToken }) {
      ${stripTypeScriptTypes(loaderSource)}
    };
  `)({ ...react, listProjects }) as (props: unknown) => void;
  return {
    render(userId: string | undefined, refreshToken = 0) {
      cursor = 0;
      effects = [];
      component({ userId, refreshToken, onOpen: () => undefined });
      effects.forEach(effect => effect());
    },
    projects: () => hooks[0].value as Project[],
    dispose: () => hooks.forEach(hook => hook.cleanup?.()),
  };
}

async function settled() { await new Promise<void>(done => setImmediate(done)); }

test("owner changes reload the unified list and stale owner responses cannot restore another user's projects", async () => {
  const pending: ((projects: Project[]) => void)[] = [];
  const ui = library(() => new Promise(resolve => pending.push(resolve)));
  try {
    ui.render("owner-a");
    assert.equal(pending.length, 1);
    ui.render("owner-b");
    assert.equal(pending.length, 2);
    pending[1]([verified, standard]);
    await settled();
    assert.deepEqual(ui.projects(), [standard, verified]);
    pending[0]([standard]);
    await settled();
    assert.deepEqual(ui.projects(), [standard, verified]);
    ui.render(undefined);
    assert.deepEqual(ui.projects(), []);
    assert.equal(pending.length, 2);
  } finally { ui.dispose(); }
});

test("Standard listing keeps its existing refresh-token behavior and unmounted requests cannot restore stale owner data", async () => {
  const pending: ((projects: Project[]) => void)[] = [];
  const ui = library(() => new Promise(resolve => pending.push(resolve)));
  ui.render("owner-a");
  pending[0]([standard]);
  await settled();
  ui.render("owner-a");
  assert.equal(pending.length, 1);
  assert.deepEqual(ui.projects(), [standard]);
  ui.render("owner-a", 1);
  assert.equal(pending.length, 2);
  ui.dispose();
  pending[1]([verified]);
  await settled();
  assert.deepEqual(ui.projects(), [standard]);
});

test("Verified confirmation failure refreshes persisted Projects while Standard failure does not change its refresh behavior", async () => {
  const handlerSource = app.slice(app.indexOf("  const confirmProposal ="), app.indexOf("  const reviseProposal ="));
  const bind = new Function("d", `
    const { build, running, setRunning, setStatusDetail, setBuild, setStage, setProjectRefreshToken,
      confirmSafeBuild, confirmBuild, waitForBuild, visibleBuildStage, visibleBuildDetail } = d;
    ${handlerSource}
    return confirmProposal;
  `) as (dependencies: Record<string, unknown>) => () => Promise<void>;
  for (const mode of ["safe", "legacy"]) {
    let refreshes = 0;
    const handler = bind({
      build: { id: "build-id", status: "awaiting_confirmation", generationMode: mode }, running: false,
      setRunning: () => undefined, setStatusDetail: () => undefined, setBuild: () => undefined, setStage: () => undefined,
      setProjectRefreshToken: () => { refreshes++; },
      confirmSafeBuild: async () => ({}), confirmBuild: async () => ({}),
      waitForBuild: async () => ({ status: "failed", error: { message: "Required validation unavailable" } }),
      visibleBuildStage: () => 0, visibleBuildDetail: () => "",
    });
    await handler();
    assert.equal(refreshes, mode === "safe" ? 1 : 0);
  }
  assert.ok(!source.includes("safeAuthenticated"));
  assert.match(app, /userId=\{ownerSession.user\?\.id\}/);
});
