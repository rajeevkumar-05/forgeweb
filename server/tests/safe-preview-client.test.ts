import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Load the browser client without adding DOM dependencies to the server typecheck.
const client = await import(new URL("../../src/lib/forgeweb-api.ts", import.meta.url).href);
const previewUrl = "https://localhost:9443/session/test-only-capability";

async function browserTest(action: (state: { tab: { opener: unknown; closed: boolean; close: () => void; location: { replace: (url: string) => void } }; requests: Array<{ path: string; init?: RequestInit }>; navigations: string[]; respond: (body: unknown, status?: number) => void; block: () => void }) => Promise<void>) {
  const fetchBefore = globalThis.fetch;
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const navigations: string[] = [];
  let body: unknown = { preview: { status: "ready", versionId: "version-1", previewUrl } };
  let status = 200;
  let blocked = false;
  const tab = { opener: {} as unknown, closed: false, close() { this.closed = true; }, location: { replace(url: string) { navigations.push(url); } } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    open(url: string, target: string) { assert.equal(url, "about:blank"); assert.equal(target, "_blank"); return blocked ? null : tab; },
  } });
  globalThis.fetch = async (path, init) => {
    assert.equal(tab.opener, null, "opener must be detached before the asynchronous request");
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  try { await action({ tab, requests, navigations, respond(value, code = 200) { body = value; status = code; }, block() { blocked = true; } }); }
  finally {
    globalThis.fetch = fetchBefore;
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("preview handoff uses authenticated safe activation, a detached new tab and transient capability only", async () => {
  await browserTest(async ({ tab, requests, navigations }) => {
    const result = await client.openSafePreview("project/1", "version-1");
    assert.deepEqual(result, { status: "ready" });
    assert.equal(tab.opener, null);
    assert.equal(tab.closed, false);
    assert.deepEqual(navigations, [previewUrl]);
    assert.equal(requests[0].path, "/api/safe/projects/project%2F1/versions/version-1/preview");
    assert.equal(requests[0].init?.method, "POST");
    assert.equal(requests[0].init?.credentials, "same-origin");
    assert.ok(!JSON.stringify(result).includes("test-only-capability"));
    assert.ok(!JSON.stringify(requests).includes("test-only-capability"));
  });
});

test("blocked tabs do not start a runtime, and unavailable previews close the reserved tab", async () => {
  await browserTest(async ({ block, requests }) => {
    block();
    await assert.rejects(client.openSafePreview("project-1", "version-1"), /Allow a new preview tab/);
    assert.equal(requests.length, 0);
  });
  await browserTest(async ({ tab, navigations, respond }) => {
    respond({ preview: { status: "unavailable", versionId: "version-1", message: "Trusted runtime unavailable." } });
    assert.deepEqual(await client.openSafePreview("project-1", "version-1"), { status: "unavailable", message: "Trusted runtime unavailable." });
    assert.equal(tab.closed, true);
    assert.equal(navigations.length, 0);
  });
});

test("unauthorized/expired sessions and runtime failures close the tab without navigation", async () => {
  for (const status of [401, 403, 503]) {
    await browserTest(async ({ tab, navigations, respond }) => {
      respond({ error: { message: "Preview denied." } }, status);
      await assert.rejects(client.openSafePreview("project-1", "version-1"), error => error instanceof Error && error instanceof client.ApiRequestError && "status" in error && error.status === status);
      assert.equal(tab.closed, true);
      assert.equal(navigations.length, 0);
    });
  }
});

test("insecure or wrong-version responses never navigate or leak the rejected capability", async () => {
  for (const preview of [
    { status: "ready", versionId: "version-1", previewUrl: "http://localhost/session/test-only-capability" },
    { status: "ready", versionId: "version-1", previewUrl: "javascript:alert('test-only-capability')" },
    { status: "ready", versionId: "wrong-version", previewUrl },
    { status: "ready", versionId: "version-1", previewUrl: "https://user:password@localhost/session/test-only-capability" },
  ]) {
    await browserTest(async ({ tab, navigations, respond }) => {
      respond({ preview });
      await assert.rejects(client.openSafePreview("project-1", "version-1"), error => error instanceof Error && !error.message.includes("test-only-capability"));
      assert.equal(tab.closed, true);
      assert.equal(navigations.length, 0);
    });
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
