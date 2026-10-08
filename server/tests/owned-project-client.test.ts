import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const client = await import(new URL("../../src/lib/forgeweb-api.ts", import.meta.url).href);
const sidebar = await readFile(new URL("../../src/components/ProjectLibrary.tsx", import.meta.url), "utf8");
const ownerAccess = await readFile(new URL("../../src/components/OwnerAccess.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../../src/App.tsx", import.meta.url), "utf8");

test("normal login, session, claim and delete use one same-origin API without browser credential persistence", async () => {
  const original = globalThis.fetch;
  const calls: { path: string; init?: RequestInit }[] = [];
  const user = { id: "owner-user", username: "test-owner", canClaimLocalProjects: true };
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), init });
    return Response.json({ user, migration: { standard: 1, verified: 1 }, claimed: 2, deleted: true });
  };
  try {
    assert.deepEqual(await client.signIn("test-owner", "test-only-password"), user);
    assert.deepEqual((await client.getOwnerSession()).user, user);
    await client.claimExistingProjects(true); await client.deleteProject("project/A"); await client.signOut();
    assert.deepEqual(calls.map(call => call.path), ["/api/auth/login", "/api/auth/session", "/api/projects/claim", "/api/projects/project%2FA", "/api/auth/logout"]);
    assert.ok(calls.every(call => call.init?.credentials === "same-origin"));
    assert.equal(calls[3].init?.method, "DELETE"); assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { confirmed: true });
    assert.ok(!/localStorage|sessionStorage|console\./.test(ownerAccess));
    assert.ok(!/localStorage|sessionStorage/.test(await readFile(new URL("../../src/lib/forgeweb-api.ts", import.meta.url), "utf8")));
  } finally { globalThis.fetch = original; }
});

test("actual login form awaits authentication and refresh, clears the password and sanitizes failures", async () => {
  const source = ownerAccess.slice(ownerAccess.indexOf("  const submit ="), ownerAccess.indexOf("  const logout ="));
  const bind = new Function("d", `const { username, password, register, signIn, onChanged, setPending, setError, setPassword } = d; ${stripTypeScriptTypes(source)}; return submit;`);
  for (const fail of [false, true]) {
    const events: string[] = []; let password = "test-only-password"; let error = "";
    const handler = bind({ username: "test-owner", password, register: false,
      async signIn() { events.push("login"); if (fail) throw Error(password); },
      async onChanged() { events.push("refresh"); },
      setPending() {}, setError(value: string) { error = value; }, setPassword(value: string) { password = value; },
    });
    await handler({ preventDefault() {} });
    assert.equal(password, ""); assert.ok(!error.includes("test-only-password"));
    assert.deepEqual(events, fail ? ["login"] : ["login", "refresh"]);
  }
});

test("delete handler waits for confirmed server cleanup, refreshes once and retains failed projects", async () => {
  const source = sidebar.slice(sidebar.indexOf("  const remove ="), sidebar.indexOf("  const claim ="));
  const bind = new Function("d", `const { deleting, pending, deleteProject, onDeleted, setDeleting, load, setPending, setError } = d; ${source}; return remove;`);
  for (const fail of [false, true]) {
    const events: string[] = []; let selected: unknown = { id: "project-a" }; let error = "";
    await bind({ deleting: selected, pending: false, setPending() {}, setError(value: string) { error = value; },
      async deleteProject(id: string) { assert.equal(id, "project-a"); events.push("delete"); if (fail) throw Error("Cleanup failed"); },
      onDeleted() { events.push("notify"); }, setDeleting(value: unknown) { selected = value; }, async load() { events.push("refresh"); },
    })();
    assert.deepEqual(events, fail ? ["delete"] : ["delete", "notify", "refresh"]);
    assert.equal(selected === null, !fail); assert.equal(error, fail ? "Cleanup failed" : "");
  }
  assert.match(sidebar, /<dialog[\s\S]*Delete Project/);
  assert.match(sidebar, /onClick=\{\(\) => \{ setError\(""\); setDeleting\(project\); \}\}/);
});

test("both creation modes refresh the canonical sidebar immediately, without a Verified-dependent loader", () => {
  const submit = app.slice(app.indexOf("  const launchDemo ="), app.indexOf("  const confirmProposal ="));
  assert.match(submit, /const created = workflowMode === "safe" \? await createSafeBuild\(prompt\) : await createBuild\(prompt\);\s+setProjectRefreshToken/);
  const loader = sidebar.slice(sidebar.indexOf("  const load ="), sidebar.indexOf("  const openProject ="));
  assert.ok(!loader.includes("safeAuthenticated"));
  assert.match(loader, /new Map\(result.map/); assert.match(loader, /updatedAt.localeCompare/);
  assert.match(sidebar, /getProjectWorkspace\(project.id\)/); assert.match(sidebar, /getBuild\(project.currentBuildId\)/); assert.match(sidebar, /onOpen\(build\)/);
});

test("reopening an accepted snapshot does not depend on promoting its terminal Build record", async () => {
  const proposal = await readFile(new URL("../../src/components/BuildProposal.tsx", import.meta.url), "utf8");
  const condition = proposal.match(/\{\((build\.filePaths\.length[^\n]+)\) && \(/)?.[1];
  assert.ok(condition);
  const visible = new Function("build", `return (${condition});`);
  assert.equal(visible({ status: "failed", filePaths: [], project: { currentVersionId: "accepted-version" } }), true);
  assert.equal(visible({ status: "failed", filePaths: [], project: {} }), false);
  assert.ok(!/build\.status\s*=(?!=)/.test(proposal));
  assert.match(proposal, /<ProjectWorkspace projectId=\{build.projectId\}/);
});
