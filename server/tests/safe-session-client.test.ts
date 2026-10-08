import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const client = await import(new URL("../../src/lib/forgeweb-api.ts", import.meta.url).href);
const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");
const token = "test-only-activation-token-not-a-real-secret";
const authenticated = { enabled: true, authenticated: true, target: "forgeweb-postgresql-v1", isolatedValidation: "configured", disposablePostgresql: "configured", trustedRuntime: "configured" };
const unauthenticated = { ...authenticated, authenticated: false };
const build = { id: "build-test", status: "awaiting_confirmation", stageDetail: "Review requirements." };

type Request = { path: string; init?: RequestInit };

async function withBrowser(respond: (request: Request) => Promise<Response> | Response, action: (requests: Request[]) => Promise<void>) {
  const fetchBefore = globalThis.fetch;
  const descriptors = new Map(["window", "localStorage", "sessionStorage"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const forbiddenStorage = () => { throw new Error("Activation must not access persistent browser storage."); };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() { return forbiddenStorage(); },
    get sessionStorage() { return forbiddenStorage(); },
  } });
  for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, name, { configurable: true, get: forbiddenStorage });
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = { path: String(input), init };
    requests.push(request);
    return respond(request);
  };
  try { await action(requests); }
  finally {
    globalThis.fetch = fetchBefore;
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Exercise the actual form handler with state setters, without adding a DOM test dependency.
const submission = app.slice(app.indexOf("  const launchDemo ="), app.indexOf("  const confirmProposal ="));
const bindSubmit = new Function("dependencies", `
  const { workflowMode, safeStatus, activationToken, running, prompt,
    activateSafeGeneration, createSafeBuild, createBuild, waitForBuild,
    setRunning, setBuild, setStage, setStatusDetail, setActivationToken,
    setSafeStatus, setProjectRefreshToken, rememberProject, visibleBuildStage, visibleBuildDetail } = dependencies;
  ${submission.replace("event: FormEvent", "event")}
  return launchDemo;
`) as (dependencies: Record<string, unknown>) => (event: { preventDefault(): void }) => Promise<void>;

async function submit(mode: "safe" | "legacy" = "safe", status = unauthenticated) {
  const state = { running: false, token, status, detail: "", build: undefined as unknown };
  const handler = bindSubmit({
    workflowMode: mode, safeStatus: status, activationToken: token, running: false,
    prompt: "Build a simple task management application.",
    activateSafeGeneration: client.activateSafeGeneration,
    createSafeBuild: client.createSafeBuild, createBuild: client.createBuild,
    waitForBuild: async (_id: string, progress: (value: unknown) => void) => { progress(build); return build; },
    setRunning: (value: boolean) => { state.running = value; },
    setBuild: (value: unknown) => { state.build = value; },
    setStage: () => undefined,
    setStatusDetail: (value: string) => { state.detail = value; },
    setActivationToken: (value: string) => { state.token = value; },
    setSafeStatus: (value: typeof authenticated) => { state.status = value; },
    setProjectRefreshToken: () => undefined,
    rememberProject: () => undefined,
    visibleBuildStage: () => 1, visibleBuildDetail: () => build.stageDetail,
  });
  await handler({ preventDefault() {} });
  return state;
}

test("activation awaits the existing session POST before refreshing authenticated status", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await withBrowser(async ({ path, init }) => {
    if (path === "/api/safe/session") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.credentials, "same-origin");
      assert.deepEqual(JSON.parse(String(init?.body)), { token });
      await gate;
      return json({ authenticated: true });
    }
    assert.equal(path, "/api/safe/status");
    assert.equal(init?.credentials, "same-origin");
    return json(authenticated);
  }, async requests => {
    const activation = client.activateSafeGeneration(token);
    assert.deepEqual(requests.map(r => r.path), ["/api/safe/session"]);
    release();
    const result = await activation;
    assert.deepEqual(result, authenticated);
    assert.ok(!JSON.stringify(result).includes(token));
    assert.deepEqual(requests.map(r => r.path), ["/api/safe/session", "/api/safe/status"]);
  });
});

test("Verified submission refreshes React status and clears the token before creating a safe build", async () => {
  await withBrowser(({ path, init }) => {
    if (path === "/api/safe/session") return json({ authenticated: true });
    if (path === "/api/safe/status") return json(authenticated);
    assert.equal(path, "/api/safe/builds");
    assert.deepEqual(JSON.parse(String(init?.body)), { prompt: "Build a simple task management application." });
    return json({ build });
  }, async requests => {
    const state = await submit();
    assert.equal(state.token, "");
    assert.deepEqual(state.status, authenticated);
    assert.equal(state.running, false);
    assert.equal(state.build, build);
    assert.ok(!JSON.stringify(state).includes(token));
    assert.deepEqual(requests.map(r => r.path), ["/api/safe/session", "/api/safe/status", "/api/safe/builds"]);
    assert.equal(requests.filter(r => String(r.init?.body).includes(token)).length, 1);
  });
});

test("failed authentication clears the token, shows a sanitized error and never starts a build", async () => {
  await withBrowser(() => json({ error: { message: `Rejected ${token}` } }, 401), async requests => {
    const state = await submit();
    assert.equal(state.token, "");
    assert.equal(state.status.authenticated, false);
    assert.equal(state.build, null);
    assert.equal(state.running, false);
    assert.match(state.detail, /Verified activation failed/);
    assert.ok(!state.detail.includes(token));
    assert.deepEqual(requests.map(r => r.path), ["/api/safe/session"]);
  });
});

test("a successful POST without authenticated enabled status does not submit a build", async () => {
  for (const status of [unauthenticated, { ...authenticated, enabled: false }]) {
    await withBrowser(({ path }) => json(path === "/api/safe/session" ? { authenticated: true } : status), async requests => {
      const state = await submit();
      assert.equal(state.token, "");
      assert.equal(state.build, null);
      assert.match(state.detail, /Verified activation failed/);
      assert.deepEqual(requests.map(r => r.path), ["/api/safe/session", "/api/safe/status"]);
    });
  }
});

test("status refresh failure is sanitized, clears the token and stops submission", async () => {
  await withBrowser(({ path }) => {
    if (path === "/api/safe/session") return json({ authenticated: true });
    throw new Error(`Connection failure ${token}`);
  }, async requests => {
    const state = await submit();
    assert.equal(state.token, "");
    assert.equal(state.build, null);
    assert.match(state.detail, /Verified activation failed/);
    assert.ok(!state.detail.includes(token));
    assert.equal(requests.length, 2);
  });
});

test("already-authenticated Verified submission does not repeat activation", async () => {
  await withBrowser(() => json({ build }), async requests => {
    await submit("safe", authenticated);
    assert.deepEqual(requests.map(r => r.path), ["/api/safe/builds"]);
    assert.ok(!String(requests[0].init?.body).includes(token));
  });
});

test("Standard submission retains its legacy endpoint and never activates a safe session", async () => {
  await withBrowser(() => json({ build }), async requests => {
    const state = await submit("legacy");
    assert.equal(state.build, build);
    assert.deepEqual(requests.map(r => r.path), ["/api/builds"]);
    assert.ok(!String(requests[0].init?.body).includes(token));
  });
});

test("the existing form uses the tested handler and displays authenticated state without token persistence", () => {
  assert.match(app, /<form onSubmit=\{launchDemo\}/);
  assert.match(app, /"Verified session active"/);
  assert.match(app, /aria-label="Verified workflow activation token"[\s\S]*?autoComplete="off"/);
  assert.ok(!/localStorage|sessionStorage/.test(submission));
});
