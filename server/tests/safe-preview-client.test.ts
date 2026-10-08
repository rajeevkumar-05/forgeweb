import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the browser client without adding DOM dependencies to the server typecheck.
const client = await import(new URL("../../src/lib/forgeweb-api.ts", import.meta.url).href);
const capability = "a".repeat(64);
const previewUrl = `https://localhost:9443/session/${capability}`;

async function browserTest(action: (state: { tab: { opener: unknown; closed: boolean; close: () => void }; requests: Array<{ path: string; init?: RequestInit }>; navigations: string[]; respond: (body: unknown, status?: number) => void; block: (value?: boolean) => void; defer: () => () => void }) => Promise<void>) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const navigations: string[] = [];
  let body: unknown = { preview: { status: "ready", versionId: "version-1", previewUrl, expiresAt: Date.now() + 60_000 } };
  let status = 200;
  let blocked = false;
  let gate: Promise<void> | undefined;
  const tab = { opener: {} as unknown, closed: false, close() { this.closed = true; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    open(url: string, target: string) { assert.notEqual(url, "about:blank"); assert.equal(target, "_blank"); if (blocked) return null; navigations.push(url); return tab; },
    get localStorage() { throw new Error("Capability persistence forbidden"); },
    get sessionStorage() { throw new Error("Capability persistence forbidden"); },
  } });
  globalThis.fetch = async (path, init) => {
    requests.push({ path: String(path), init });
    await gate;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  try { await action({ tab, requests, navigations, respond(value, code = 200) { body = value; status = code; }, block(value = true) { blocked = value; }, defer() {
    let release!: () => void;
    gate = new Promise<void>(resolve => { release = resolve; });
    return release;
  } }); }
  finally {
    globalThis.fetch = fetchBefore;
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("preview handoff uses authenticated safe activation, a detached new tab and transient capability only", async () => {
  await browserTest(async ({ tab, requests, navigations }) => {
    const result = await client.openSafePreview("project/1", "version-1");
    assert.deepEqual(result, { status: "ready", opened: true });
    assert.equal(tab.opener, null);
    assert.equal(tab.closed, false);
    assert.deepEqual(navigations, [previewUrl]);
    assert.equal(requests[0].path, "/api/safe/projects/project%2F1/versions/version-1/preview");
    assert.equal(requests[0].init?.method, "POST");
    assert.equal(requests[0].init?.credentials, "same-origin");
    assert.equal(requests[0].init?.body, undefined);
    assert.ok(!JSON.stringify(result).includes(capability));
    assert.ok(!JSON.stringify(requests).includes(capability));
  });
});

test("blocked automatic opening provides an ephemeral user-gesture fallback without another runtime or blank tab", async () => {
  await browserTest(async ({ block, requests, navigations, tab }) => {
    block();
    const ready = await client.openSafePreview("project-1", "version-1");
    assert.ok(ready.status === "ready" && !ready.opened);
    assert.equal(requests.length, 1);
    assert.equal(navigations.length, 0);
    assert.ok(!JSON.stringify(ready).includes(capability));
    assert.throws(() => ready.open(), /Allow a new preview tab/);
    block(false);
    ready.open();
    assert.deepEqual(navigations, [previewUrl]);
    assert.equal(tab.opener, null);
    assert.equal(requests.length, 1);
    assert.throws(() => ready.open(), /fresh preview session/);
  });
});

test("unavailable previews never open an empty tab", async () => {
  await browserTest(async ({ tab, navigations, respond }) => {
    respond({ preview: { status: "unavailable", versionId: "version-1", message: "Trusted runtime unavailable." } });
    assert.deepEqual(await client.openSafePreview("project-1", "version-1"), { status: "unavailable", message: "Trusted runtime unavailable." });
    assert.equal(tab.closed, false);
    assert.equal(navigations.length, 0);
  });
});

test("unauthorized/expired sessions and runtime failures never open a tab", async () => {
  for (const status of [401, 403, 503]) {
    await browserTest(async ({ tab, navigations, respond }) => {
      respond({ error: { message: "Preview denied." } }, status);
      await assert.rejects(client.openSafePreview("project-1", "version-1"), error => error instanceof Error && error instanceof client.ApiRequestError && "status" in error && error.status === status);
      assert.equal(tab.closed, false);
      assert.equal(navigations.length, 0);
    });
  }
});

test("insecure, untrusted, malformed or wrong-version responses never navigate or leak the rejected capability", async () => {
  for (const preview of [
    { status: "ready", versionId: "version-1", previewUrl: "http://localhost/session/test-only-capability" },
    { status: "ready", versionId: "version-1", previewUrl: "javascript:alert('test-only-capability')" },
    { status: "ready", versionId: "wrong-version", previewUrl },
    { status: "ready", versionId: "version-1", previewUrl: "https://user:password@localhost/session/test-only-capability" },
    { status: "ready", versionId: "version-1", previewUrl: previewUrl.replace("localhost", "untrusted.invalid") },
    { status: "ready", versionId: "version-1", previewUrl: previewUrl + "?token=test-only-capability" },
    { status: "ready", versionId: "version-1", previewUrl: previewUrl + "#test-only-capability" },
    { status: "ready", versionId: "version-1", previewUrl: "" },
    { status: "ready", versionId: "version-1" },
    undefined,
  ]) {
    await browserTest(async ({ tab, navigations, respond }) => {
      respond({ preview });
      await assert.rejects(client.openSafePreview("project-1", "version-1"), error => error instanceof Error && !error.message.includes("test-only-capability"));
      assert.equal(tab.closed, false);
      assert.equal(navigations.length, 0);
    });
  }
});

test("runtime startup is awaited before the initial navigation uses the exact returned HTTPS URL", async () => {
  await browserTest(async ({ defer, requests, navigations }) => {
    const release = defer();
    const opening = client.openSafePreview("project-1", "version-1");
    assert.equal(requests.length, 1);
    assert.equal(navigations.length, 0);
    release();
    assert.deepEqual(await opening, { status: "ready", opened: true });
    assert.deepEqual(navigations, [previewUrl]);
  });
});

test("expired responses and expiry during popup fallback cannot navigate", async () => {
  await browserTest(async ({ respond, navigations }) => {
    for (const expiresAt of [undefined, Date.now() - 1]) {
      respond({ preview: { status: "ready", versionId: "version-1", previewUrl, expiresAt } });
      await assert.rejects(client.openSafePreview("project-1", "version-1"), /expired/);
    }
    assert.equal(navigations.length, 0);
  });
  await browserTest(async ({ block, respond, navigations }) => {
    const now = Date.now;
    const expiresAt = now() + 60_000;
    respond({ preview: { status: "ready", versionId: "version-1", previewUrl, expiresAt } });
    block();
    const ready = await client.openSafePreview("project-1", "version-1");
    assert.ok(ready.status === "ready" && !ready.opened);
    try {
      Date.now = () => expiresAt;
      block(false);
      assert.throws(() => ready.open(), /fresh preview session/);
      assert.equal(navigations.length, 0);
    } finally { Date.now = now; }
  });
});

test("Recipe and Task use the same generic handoff and each new request gets a fresh returned capability", async () => {
  await browserTest(async ({ respond, requests, navigations }) => {
    for (const domain of ["recipe", "task"]) {
      const versionId = `version-${domain}`;
      const url = previewUrl.replace(capability, (domain === "recipe" ? "b" : "c").repeat(64));
      respond({ preview: { status: "ready", versionId, previewUrl: url, expiresAt: Date.now() + 60_000 } });
      assert.deepEqual(await client.openSafePreview(`project-${domain}`, versionId), { status: "ready", opened: true });
      assert.equal(navigations.at(-1), url);
    }
    assert.equal(requests.length, 2);
    assert.notEqual(navigations[0], navigations[1]);
  });
});

test("the actual workspace button retries a blocked popup synchronously and discards expired or wrong-version handoffs", async () => {
  const workspaceSource = await readFile(new URL("../../src/components/ProjectWorkspace.tsx", import.meta.url), "utf8");
  const source = workspaceSource.slice(workspaceSource.indexOf("  const openRuntimePreview ="), workspaceSource.indexOf("  const files ="));
  const bind = new Function("d", `
    const { loading, workspace, projectId, safePreviewState, pendingPreview, previewExpiryTimer,
      openSafePreview, setSafePreviewState, setSafePreviewMessage, ApiRequestError } = d;
    ${source}
    return openRuntimePreview;
  `) as (dependencies: Record<string, unknown>) => () => Promise<void>;
  const before = Object.getOwnPropertyDescriptor(globalThis, "window");
  let expiry: (() => void) | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout(action: () => void) { expiry = action; return 1; },
    clearTimeout() { expiry = undefined; },
  } });
  try {
    const pendingPreview: { current: { versionId: string; open: () => void } | undefined } = { current: undefined };
    let requests = 0;
    let launches = 0;
    let state = "";
    let message = "";
    const run = bind({ loading: false, workspace: { project: { id: "project-1" }, currentVersion: { id: "version-1" } },
      projectId: "project-1", safePreviewState: "idle", pendingPreview, previewExpiryTimer: { current: undefined },
      ApiRequestError: client.ApiRequestError,
      setSafePreviewState(value: string) { state = value; }, setSafePreviewMessage(value: string) { message = value; },
      async openSafePreview(projectId: string, versionId: string) {
        requests++;
        assert.equal(projectId, "project-1"); assert.equal(versionId, "version-1");
        return { status: "ready", opened: false, expiresAt: Date.now() + 60_000, open() { launches++; } };
      },
    });
    await run();
    assert.equal(state, "ready"); assert.match(message, /blocked automatic opening/);
    assert.equal(requests, 1); assert.equal(launches, 0);
    await run();
    assert.equal(requests, 1); assert.equal(launches, 1);
    assert.equal(pendingPreview.current, undefined); assert.equal(expiry, undefined);
    assert.match(message, /opened in a new tab/);
    await run();
    assert.equal(requests, 2);
    expiry!();
    assert.equal(pendingPreview.current, undefined); assert.equal(state, "idle"); assert.match(message, /expired/);
    await run();
    assert.equal(requests, 3);
    pendingPreview.current = { versionId: "other-version", open() { throw Error("Stale handoff must not run"); } };
    await run();
    assert.equal(requests, 4);
    assert.ok(!/localStorage|sessionStorage|previewUrl/.test(source));
  } finally {
    if (before) Object.defineProperty(globalThis, "window", before);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("workspace routes safe previews out of the legacy iframe and does not store capabilities", async () => {
  const workspace = await readFile(new URL("../../src/components/ProjectWorkspace.tsx", import.meta.url), "utf8");
  const proposal = await readFile(new URL("../../src/components/BuildProposal.tsx", import.meta.url), "utf8");
  const api = await readFile(new URL("../../src/lib/forgeweb-api.ts", import.meta.url), "utf8");
  assert.match(workspace, /isSafeVersion = safeGeneration \|\| Boolean\(workspace\?\.currentVersion\?\.candidateId\)/);
  assert.match(workspace, /tab !== "preview" \|\| loading \|\| !workspace \|\| isSafeVersion/);
  assert.match(workspace, /tab === "preview" && !isSafeVersion/);
  assert.match(workspace, /Open Preview/);
  assert.match(proposal, /safeGeneration=\{build.generationMode === "safe"\}/);
  assert.ok(!/localStorage|sessionStorage/.test(api));
  assert.ok(!/set\w+\([^\n]*previewUrl/.test(workspace));
});
