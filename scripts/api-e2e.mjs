#!/usr/bin/env node
/**
 * ForgeWeb end-to-end acceptance run against the real HTTP control plane.
 *
 * This script does not import ForgeWeb modules. It boots the actual API as a
 * child process, in an isolated temporary data directory, and then drives the
 * complete product workflow over HTTP exactly as the browser does:
 *
 *   prompt -> requirements + architecture -> (no source yet) -> confirmation
 *   -> generation -> review -> validation -> graph -> workspace -> preview
 *   -> scoped edit -> new version -> restore -> export validation -> ZIP
 *
 * It also asserts the trust boundaries that must hold at the HTTP edge:
 * no source files before confirmation, no credential ever returned by the API,
 * no script execution in the sandboxed preview, and no ForgeWeb state or
 * secret inside an export.
 *
 * Usage:
 *   node scripts/api-e2e.mjs
 *
 * Environment:
 *   FORGEWEB_E2E_PORT   Port for the temporary API           (default 8799)
 *   FORGEWEB_E2E_LLM    "true" to exercise the configured    (default false)
 *                       provider and the local .env instead
 *                       of deterministic template generation
 *   FORGEWEB_E2E_PROMPT Application idea to drive the run    (default below)
 *
 * Exit code 0 means every assertion passed.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ACCEPTANCE_PROMPT = process.env.FORGEWEB_E2E_PROMPT
  ?? "Build a task management application with authentication, projects, tasks, due dates, and status tracking.";
const EDIT_PROMPT = "Make the dashboard cards smaller and modern. Keep everything else unchanged.";
/** Canary value: proves the API never echoes a configured credential. */
const CANARY_API_KEY = "forgeweb-e2e-canary-key-must-never-be-served";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const port = Number.parseInt(process.env.FORGEWEB_E2E_PORT ?? "8799", 10);
const baseUrl = `http://127.0.0.1:${port}`;
const useModel = (process.env.FORGEWEB_E2E_LLM ?? "false").toLowerCase() === "true";

let passed = 0;
const failures = [];

/** Record an assertion. Failures are collected so teardown always runs. */
function expect(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
    return true;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Read the file names out of a real ZIP archive by walking local headers. */
function zipEntryNames(buffer) {
  const names = [];
  for (let offset = 0; offset + 30 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 26);
    names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
  }
  return names;
}

const dataDirectory = await mkdtemp(join(tmpdir(), "forgeweb-e2e-"));
const childEnvironment = {
  ...process.env,
  FORGEWEB_API_PORT: String(port),
  FORGEWEB_DATA_DIR: dataDirectory,
  FORGEWEB_LLM_API_KEY: CANARY_API_KEY,
};
if (useModel) {
  delete childEnvironment.FORGEWEB_LLM_ENABLED;
} else {
  // Deterministic run: ignore any local .env so the result cannot drift.
  childEnvironment.FORGEWEB_LLM_ENABLED = "false";
  childEnvironment.FORGEWEB_ENV_FILE = join(dataDirectory, "absent.env");
}

console.log(`ForgeWeb end-to-end acceptance run`);
console.log(`  API          ${baseUrl}`);
console.log(`  data         ${dataDirectory}`);
console.log(`  generation   ${useModel ? "configured provider (with template fallback)" : "deterministic template (LLM disabled)"}`);

const server = spawn(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
  cwd: repositoryRoot,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout.on("data", (chunk) => serverLog.push(String(chunk)));
server.stderr.on("data", (chunk) => serverLog.push(String(chunk)));
let serverExited = false;
server.on("exit", () => {
  serverExited = true;
});

try {
  section("1. Control plane boots");
  await waitFor("the API to become healthy", async () => {
    if (serverExited) throw new Error(`API exited before becoming healthy:\n${serverLog.join("")}`);
    try {
      const health = await api("GET", "/api/health");
      return health.status === 200 && health.json?.status === "ok";
    } catch {
      return false;
    }
  }, 30_000);
  expect(true, "GET /api/health reports ok");

  const status = await api("GET", "/api/llm/status");
  expect(status.status === 200 && typeof status.json?.llm?.mode === "string", "GET /api/llm/status reports a mode", status.text.slice(0, 160));
  expect(!status.text.includes(CANARY_API_KEY), "provider status never returns the configured API key");
  expect(!/"api[_-]?key"/i.test(status.text), "provider status has no api key field");

  section("2. Prompt produces requirements and architecture, and no source code");
  const created = await api("POST", "/api/builds", { prompt: ACCEPTANCE_PROMPT });
  expect(created.status === 202 && typeof created.json?.build?.id === "string", "POST /api/builds accepts the acceptance prompt", created.text.slice(0, 200));
  const buildId = created.json.build.id;
  const projectId = created.json.build.projectId;

  // Stream real server-sent events from confirmation onward: progress must come
  // from backend state, not from a frontend timer. The endpoint replays the
  // events recorded so far and then streams live until a terminal state.
  const events = [];
  const collectEvents = async () => {
    const response = await fetch(`${baseUrl}/api/builds/${buildId}/events`);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("event: ")) events.push(line.slice(7).trim());
    }
  };

  const proposal = await waitFor("the proposal", async () => {
    const read = await api("GET", `/api/builds/${buildId}`);
    return read.json?.build?.status === "awaiting_confirmation" ? read.json.build : null;
  });
  expect(proposal.status === "awaiting_confirmation", "the build stops at awaiting_confirmation");
  expect(proposal.filePaths.length === 0, "no source file exists before confirmation", `saw ${proposal.filePaths.length}`);

  const requirements = proposal.specification?.requirements ?? [];
  expect(requirements.length >= 5, "requirements were compiled", `saw ${requirements.length}`);
  expect(requirements.every((requirement) => /^REQ-\d+$/.test(requirement.id)), "every requirement has a stable REQ id");
  expect(new Set(requirements.map((r) => r.id)).size === requirements.length, "requirement ids are unique");
  expect(requirements.every((r) => r.title && r.description && r.acceptanceCriteria.length > 0 && ["P0", "P1"].includes(r.priority)), "every requirement is fully specified with a priority");
  expect(requirements.some((r) => r.priority === "P0"), "at least one requirement is P0");

  const architecture = proposal.specification?.architecture;
  const markdown = architecture?.markdown ?? "";
  expect(markdown.includes("# ") && markdown.length > 800, "ARCHITECTURE.md content was produced", `${markdown.length} characters`);
  for (const heading of ["Frontend", "Backend", "Data", "Security", "Delivery"]) {
    expect(markdown.includes(heading), `architecture covers ${heading}`);
  }
  // Prompt fidelity, derived from the prompt itself rather than a fixed list:
  // the specification must mention the distinctive words the user actually used.
  const filler = new Set(["build", "create", "make", "generate", "design", "simple", "basic", "application", "where", "with", "that", "this", "users", "user", "and", "can", "the", "for", "their", "them", "also", "should", "able"]);
  const promptTerms = [...new Set(ACCEPTANCE_PROMPT.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter((word) => !filler.has(word));
  const specificationText = JSON.stringify(proposal.specification).toLowerCase();
  const covered = promptTerms.filter((term) => specificationText.includes(term.replace(/s$/, "")));
  expect(promptTerms.length > 0 && covered.length >= Math.ceil(promptTerms.length * 0.6), "the specification reflects the specific prompt", `${covered.length}/${promptTerms.length} prompt terms present; missing ${promptTerms.filter((term) => !covered.includes(term)).join(", ")}`);
  expect(/^[A-Z]/.test(proposal.specification.productName) && !/\b(where|which|that|can|users)\b/i.test(proposal.specification.productName), "the product name is a clean noun phrase", proposal.specification.productName);

  const projectBeforeConfirmation = await api("GET", `/api/projects/${projectId}`);
  expect((projectBeforeConfirmation.json?.files ?? []).length === 0, "the project has no stored files before confirmation");

  section("3. The confirmation gate is enforced by the backend");
  const prematureEdit = await api("POST", `/api/projects/${projectId}/edits`, { prompt: EDIT_PROMPT });
  expect(prematureEdit.status === 409, "an edit before generation is refused with 409", `status ${prematureEdit.status}`);
  const prematureExport = await api("POST", `/api/projects/${projectId}/export/validate`);
  expect(prematureExport.status === 409, "an export before generation is refused with 409", `status ${prematureExport.status}`);

  section("4. Confirmation starts generation");
  const confirmed = await api("POST", `/api/builds/${buildId}/confirm`);
  expect(confirmed.status === 202, "POST /api/builds/:id/confirm is accepted", `status ${confirmed.status}`);
  // Subscribe while generation is genuinely in flight.
  const eventStream = collectEvents().catch((error) => {
    failures.push(`event stream failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const reconfirmed = await api("POST", `/api/builds/${buildId}/confirm`);
  expect(reconfirmed.status === 409, "confirming twice is rejected by the state machine", `status ${reconfirmed.status}`);

  const completed = await waitFor("generation to complete", async () => {
    const read = await api("GET", `/api/builds/${buildId}`);
    const build = read.json?.build;
    if (build?.status === "failed") throw new Error(`Build failed: ${JSON.stringify(build.error)}`);
    return build?.status === "completed" ? build : null;
  }, 300_000);
  expect(completed.status === "completed", "the build reaches completed");
  expect(completed.filePaths.length >= 12, "a full-stack project was generated", `${completed.filePaths.length} files`);
  for (const required of ["ARCHITECTURE.md", "frontend/src/App.tsx", "frontend/preview.html", "backend/src/index.ts", "backend/src/security/access-control.ts"]) {
    expect(completed.filePaths.includes(required), `generated ${required}`);
  }
  expect(typeof completed.graphSnapshotId === "string" && completed.graphSnapshotId.length > 0, "a requirement graph snapshot was recorded");
  expect(completed.validationChecks.length > 0 && !completed.validationChecks.some((check) => check.status === "failed"), "validation passed with no failed check");
  expect(completed.validationChecks.every((check) => check.status !== "skipped" || /^Skipped: /.test(check.evidence)), "any skipped check states its reason and is not reported as passed");
  expect(completed.llmMetadata !== undefined && typeof completed.llmMetadata.fallbackUsed === "boolean", "the generation mode is recorded honestly");
  expect(!completed.filePaths.some((path) => path.includes("..") || path.includes(".env") || path.startsWith("/")), "no generated path escapes the project or targets a secret");

  await eventStream;
  expect(events.includes("build.confirmed"), "the event stream reported the confirmation", events.join(","));
  expect(events.includes("build.completed"), "the event stream reported completion");
  expect(events.filter((event) => event === "build.stage.completed").length >= 4, "real per-stage progress was streamed", `${events.filter((e) => e === "build.stage.completed").length} stage completions`);

  section("5. Requirement traceability");
  const project = await api("GET", `/api/projects/${projectId}`);
  const graph = project.json?.graph;
  const files = project.json?.files ?? [];
  expect(graph?.nodes?.length > 0 && graph?.edges?.length > 0, "the graph has nodes and edges");
  const satisfied = new Set((graph?.edges ?? []).filter((edge) => edge.type === "SATISFIED_BY").map((edge) => edge.from));
  const validated = new Set((graph?.edges ?? []).filter((edge) => edge.type === "VALIDATED_BY").map((edge) => edge.from));
  const p0 = requirements.filter((requirement) => requirement.priority === "P0");
  expect(p0.every((requirement) => satisfied.has(requirement.id)), "every P0 requirement maps to implementation files");
  expect(p0.every((requirement) => validated.has(requirement.id)), "every P0 requirement maps to a validation check");
  expect(files.every((file) => Array.isArray(file.requirementIds)), "every generated file carries requirement ids");

  section("6. Workspace, preview isolation, and generated database information");
  const workspace = await api("GET", `/api/projects/${projectId}/workspace`);
  const initialVersion = workspace.json?.workspace?.currentVersion;
  expect(initialVersion?.versionNumber === 1, "the first immutable version exists", `saw ${initialVersion?.versionNumber}`);
  expect(workspace.json.workspace.versions.length === 1, "version history has exactly one entry");
  expect(workspace.json.workspace.files.length === completed.filePaths.length, "the workspace serves every generated file");
  expect((workspace.json.workspace.database?.tables ?? []).length > 0, "generated-application database information is present");
  expect(/separate|separat/i.test(workspace.json.workspace.database?.separationNote ?? ""), "the database view states its separation from ForgeWeb state");
  expect(!workspace.text.includes(CANARY_API_KEY), "the workspace never contains the configured API key");
  expect(!workspace.text.includes(dataDirectory), "the workspace never leaks an internal filesystem path");

  const preview = await api("GET", `/api/projects/${projectId}/preview`);
  expect(preview.status === 200 && (preview.headers.get("content-type") ?? "").includes("text/html"), "the preview renders real HTML");
  expect((preview.headers.get("content-security-policy") ?? "").includes("script-src 'none'"), "the preview is served with script execution disabled");
  expect(!/<script/i.test(preview.text), "the preview contains no script tag");
  expect(/aria-label="Primary navigation"/.test(preview.text), "the preview is a real application surface, not a placeholder");

  section("7. Scoped AI edit produces a new immutable version");
  const versionOneStyles = files.find((file) => file.path === "frontend/src/styles.css")?.content ?? "";
  const edit = await api("POST", `/api/projects/${projectId}/edits`, { prompt: EDIT_PROMPT });
  expect(edit.status === 201, "POST /api/projects/:id/edits is accepted", `status ${edit.status} ${edit.text.slice(0, 160)}`);
  expect((edit.json?.modifiedFiles ?? []).length > 0, "the edit reports the files it changed", JSON.stringify(edit.json?.modifiedFiles));
  const editedVersion = edit.json?.workspace?.currentVersion;
  expect(editedVersion?.versionNumber === 2, "the edit created version 2 instead of mutating version 1", `saw ${editedVersion?.versionNumber}`);
  expect(editedVersion?.validationStatus === "passed", "the new version validated before being published");
  expect(edit.json.workspace.versions.length === 2, "both versions are retained");
  const editedStyles = edit.json.workspace.files.find((file) => file.path === "frontend/src/styles.css")?.content ?? "";
  expect(editedStyles !== versionOneStyles && editedStyles.includes(versionOneStyles.trimEnd().slice(0, 200)), "the edit was surgical: existing source was preserved and extended");
  expect(!(edit.json.modifiedFiles ?? []).some((path) => path.includes("..") || path.includes(".env")), "the edit touched no protected path");

  const brokenEdit = await api("POST", `/api/projects/${projectId}/edits`, { prompt: "Make invalid broken code by removing the closing brace from frontend styles." });
  expect(brokenEdit.status === 422, "an edit that would break validation is refused", `status ${brokenEdit.status}`);
  const afterBrokenEdit = await api("GET", `/api/projects/${projectId}/workspace`);
  expect(afterBrokenEdit.json?.workspace?.currentVersion?.versionNumber === 2, "the last working version survived the refused edit");

  section("8. Restore returns to an earlier validated version");
  const restored = await api("POST", `/api/projects/${projectId}/versions/${initialVersion.id}/restore`);
  expect(restored.status === 200, "restore is accepted", `status ${restored.status}`);
  expect(restored.json?.workspace?.currentVersion?.versionNumber === 1, "version 1 is current again");
  expect(restored.json.workspace.versions.length === 2, "restoring did not delete the later version");
  const restoredStyles = restored.json.workspace.files.find((file) => file.path === "frontend/src/styles.css")?.content ?? "";
  expect(restoredStyles === versionOneStyles, "restored source matches version 1 exactly");

  const forwardAgain = await api("POST", `/api/projects/${projectId}/versions/${editedVersion.id}/restore`);
  expect(forwardAgain.json?.workspace?.currentVersion?.versionNumber === 2, "the edited version can be selected again");
  const missingVersion = await api("POST", `/api/projects/${projectId}/versions/version_does_not_exist/restore`);
  expect(missingVersion.status === 404, "restoring an unknown version is refused", `status ${missingVersion.status}`);

  section("9. Validation-gated export");
  const exportSummary = await api("POST", `/api/projects/${projectId}/export/validate`);
  expect(exportSummary.status === 200 && exportSummary.json?.summary?.validation === "passed", "export validation passes", exportSummary.text.slice(0, 200));
  expect(exportSummary.json.summary.frontend === "generated" && exportSummary.json.summary.backend === "generated", "the export summary reports both tiers");

  const archiveResponse = await fetch(`${baseUrl}/api/projects/${projectId}/export`, { method: "POST" });
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  expect(archiveResponse.status === 200 && (archiveResponse.headers.get("content-type") ?? "").includes("application/zip"), "the export returns a ZIP");
  expect(archive.subarray(0, 4).toString("hex") === "504b0304", "the archive has a real ZIP signature");
  const names = zipEntryNames(archive);
  expect(names.length >= 12, "the archive contains the project files", `${names.length} entries`);
  expect(names.includes("frontend/src/App.tsx") && names.includes("backend/src/index.ts"), "the archive contains real application source");
  expect(!names.some((name) => name.includes("..") || name.includes(".env") || name.includes(".git") || name.includes("node_modules") || name.includes("forgeweb.json")), "the archive excludes secrets and ForgeWeb state", names.join(","));
  const archiveText = archive.toString("utf8");
  expect(!archiveText.includes(CANARY_API_KEY), "the archive contains no credential");
  expect(!archiveText.includes(dataDirectory), "the archive contains no internal path");

  section("10. Errors stay opaque");
  for (const path of ["/api/builds/does-not-exist", "/api/projects/does-not-exist/workspace", "/api/nope"]) {
    const missing = await api("GET", path);
    expect(missing.status === 404, `GET ${path} returns 404`, `status ${missing.status}`);
    expect(!missing.text.includes(dataDirectory) && !missing.text.includes(tmpdir()) && !/\bat \S+:\d+:\d+/.test(missing.text), `GET ${path} leaks no path or stack trace`);
  }
} catch (error) {
  failures.push(`Run aborted: ${error instanceof Error ? error.message : String(error)}`);
  console.log(`\nRun aborted: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (!serverExited) server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 250));
  if (!serverExited) server.kill("SIGKILL");
  await rm(dataDirectory, { recursive: true, force: true });
}

console.log(`\n${passed} assertions passed, ${failures.length} failed.`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("End-to-end acceptance run succeeded.");
}
