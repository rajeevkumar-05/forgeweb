/**
 * Security and state-machine guarantees.
 *
 * These are pure unit tests over the two invariants that must hold no matter
 * which code path (template, AI, edit, import) produced the input:
 *
 *   1. No generated path may escape the project or target a protected location.
 *   2. No build may skip a lifecycle stage — in particular the confirmation gate.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { BuildStatus } from "../domain.ts";
import { assertBuildTransition, canTransition } from "../build-state.ts";
import { safePath } from "../lib.ts";
import { validateGeneratedProject } from "../workflow.ts";
import { resetLlmConfig, resetLlmProvider } from "../llm/index.ts";

process.env.FORGEWEB_LLM_ENABLED = "false";
resetLlmConfig();
resetLlmProvider();

test("safePath rejects traversal, secrets, and control-plane locations", () => {
  const rejected = [
    "../etc/passwd",
    "frontend/../../etc/passwd",
    "..",
    "frontend/..",
    ".env",
    "/.env",
    ".env.local",
    ".env.production",
    "backend/.env",
    "frontend/.env.development",
    ".git/config",
    "backend/.git/HEAD",
    "node_modules/left-pad/index.js",
    "frontend/node_modules/pkg/index.js",
    "",
    "frontend/src/a\0b.tsx",
  ];
  for (const path of rejected) {
    assert.throws(() => safePath(path), { code: "UNSAFE_PATH" }, `expected rejection: ${JSON.stringify(path)}`);
  }
  // Non-string input is rejected rather than coerced.
  assert.throws(() => safePath(undefined as unknown as string), { code: "UNSAFE_PATH" });
  assert.throws(() => safePath(42 as unknown as string), { code: "UNSAFE_PATH" });
});

test("safePath normalizes legitimate paths without over-blocking", () => {
  assert.equal(safePath("frontend/src/App.tsx"), "frontend/src/App.tsx");
  assert.equal(safePath("/frontend/src/App.tsx"), "frontend/src/App.tsx");
  assert.equal(safePath("///frontend/src/App.tsx"), "frontend/src/App.tsx");
  assert.equal(safePath("frontend\\src\\App.tsx"), "frontend/src/App.tsx");
  // Segment-based matching: these only *look* like protected names.
  assert.equal(safePath(".gitignore"), ".gitignore");
  assert.equal(safePath("backend/src/environment.ts"), "backend/src/environment.ts");
  assert.equal(safePath("frontend/src/env.ts"), "frontend/src/env.ts");
  assert.equal(safePath("docs/.env-format.md"), "docs/.env-format.md");
});

test("the build state machine rejects skipping the confirmation gate or any stage", () => {
  // The two illegal edges that would defeat the architecture-first contract.
  assert.equal(canTransition("awaiting_confirmation", "completed"), false);
  assert.equal(canTransition("specifying", "generating"), false);
  assert.throws(() => assertBuildTransition("awaiting_confirmation", "completed"), { code: "INVALID_TRANSITION", status: 409 });
  assert.throws(() => assertBuildTransition("specifying", "generating"), { code: "INVALID_TRANSITION", status: 409 });

  // Every other stage-skipping edge is rejected too.
  const skips: Array<[BuildStatus, BuildStatus]> = [
    ["queued", "generating"],
    ["queued", "awaiting_confirmation"],
    ["queued", "completed"],
    ["specifying", "awaiting_confirmation"],
    ["specifying", "completed"],
    ["planning", "generating"],
    ["planning", "validating"],
    ["awaiting_confirmation", "reviewing"],
    ["awaiting_confirmation", "validating"],
    ["generating", "validating"],
    ["generating", "completed"],
    ["reviewing", "completed"],
    ["needs_context", "generating"],
    ["needs_context", "completed"],
  ];
  for (const [from, to] of skips) {
    assert.equal(canTransition(from, to), false, `expected ${from} → ${to} to be rejected`);
  }

  // Terminal states are terminal: no resurrection, in either direction.
  const terminals: BuildStatus[] = ["completed", "failed"];
  const others: BuildStatus[] = ["queued", "specifying", "planning", "awaiting_confirmation", "generating", "reviewing", "validating", "needs_context", "completed", "failed"];
  for (const terminal of terminals) {
    for (const target of others) {
      if (target === terminal) continue;
      assert.equal(canTransition(terminal, target), false, `expected ${terminal} → ${target} to be rejected`);
    }
  }
});

test("the build state machine allows the full approved lifecycle", () => {
  const lifecycle: BuildStatus[] = ["queued", "specifying", "planning", "awaiting_confirmation", "generating", "reviewing", "validating", "completed"];
  for (let index = 0; index < lifecycle.length - 1; index += 1) {
    assert.equal(canTransition(lifecycle[index], lifecycle[index + 1]), true, `expected ${lifecycle[index]} → ${lifecycle[index + 1]} to be allowed`);
    assert.doesNotThrow(() => assertBuildTransition(lifecycle[index], lifecycle[index + 1]));
  }
  // Failure is reachable from every active stage, and self-transitions are no-ops.
  for (const status of lifecycle.slice(0, -1)) {
    assert.equal(canTransition(status, "failed"), true, `expected ${status} → failed to be allowed`);
    assert.equal(canTransition(status, status), true, `expected ${status} → ${status} to be an idempotent no-op`);
  }
  assert.equal(canTransition("specifying", "needs_context"), true);
  assert.equal(canTransition("needs_context", "specifying"), true);
  // Revision: the user may send the build back to specifying from the approval gate.
  assert.equal(canTransition("awaiting_confirmation", "specifying"), true);
});

test("validation fails — never skips — when a P0 requirement has no implementation mapping", () => {
  const specification = {
    id: "spec_test",
    projectId: "project_test",
    version: 1,
    status: "approved" as const,
    prompt: "Build a task management application with authentication and tasks.",
    productName: "Task Manager",
    summary: "Test specification.",
    roles: ["Owner"],
    entities: ["Task"],
    requirements: [
      { id: "REQ-001", title: "Covered", description: "Covered requirement.", acceptanceCriteria: ["Covered."], priority: "P0" as const },
      { id: "REQ-002", title: "Uncovered", description: "Uncovered P0 requirement.", acceptanceCriteria: ["Uncovered."], priority: "P0" as const },
    ],
    assumptions: [],
    architecture: { systemShape: "Monolith", frontend: { framework: "React", pages: [], components: [], motion: [] }, backend: { runtime: "Node", modules: [], apiStyle: "REST", jobs: [] }, data: { database: "PostgreSQL", entities: ["Task"], rules: [] }, security: [], delivery: [], diagram: "", markdown: "# Architecture", capabilities: [] },
    createdAt: new Date().toISOString(),
  };
  const files = [
    { path: "ARCHITECTURE.md", content: "# Architecture", requirementIds: ["REQ-001"], digest: "sha256:a" },
  ];
  const checks = validateGeneratedProject(specification, files, []);
  const p0Check = checks.find((check) => check.name === "P0 requirement coverage");
  assert.ok(p0Check, "the P0 coverage gate must always be reported");
  assert.equal(p0Check.status, "failed");
  assert.match(p0Check.evidence, /REQ-002/);
  assert.notEqual(p0Check.status, "skipped");
});

test("validation reports an unrunnable check as skipped with a reason, never as passed", () => {
  const specification = {
    id: "spec_test",
    projectId: "project_test",
    version: 1,
    status: "approved" as const,
    prompt: "Build a task management application with authentication and tasks.",
    productName: "Task Manager",
    summary: "Test specification.",
    roles: ["Owner"],
    entities: ["Task"],
    requirements: [
      { id: "REQ-001", title: "Covered", description: "Covered requirement.", acceptanceCriteria: ["Covered."], priority: "P0" as const },
    ],
    assumptions: [],
    architecture: { systemShape: "Monolith", frontend: { framework: "React", pages: [], components: [], motion: [] }, backend: { runtime: "Node", modules: [], apiStyle: "REST", jobs: [] }, data: { database: "PostgreSQL", entities: ["Task"], rules: [] }, security: [], delivery: [], diagram: "", markdown: "# Architecture", capabilities: [] },
    createdAt: new Date().toISOString(),
  };
  const checks = validateGeneratedProject(specification, [{ path: "ARCHITECTURE.md", content: "# Architecture", requirementIds: ["REQ-001"], digest: "sha256:a" }], []);
  const skipped = checks.filter((check) => check.status === "skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "Generated application type-check");
  assert.match(skipped[0].evidence, /^Skipped: /);
  assert.match(skipped[0].evidence, /typecheck|TypeScript/i);
});
