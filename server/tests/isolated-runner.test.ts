import assert from "node:assert/strict";
import test from "node:test";
import type { AssembledCandidateArtifacts } from "../generation/candidate.ts";
import { ForgeWebIsolatedRunner, SandboxExecutionError, isolatedExecutionRequest, isolatedRunnerPolicy } from "../generation/runner.ts";
import type { IsolatedExecutionRequest, SandboxExecutor } from "../generation/runner.ts";
import { digest } from "../lib.ts";

function candidate(): AssembledCandidateArtifacts {
  const content = "export const value = 1;\n";
  return {
    id: "candidate-runner",
    manifestDigest: digest("runner-manifest"),
    files: [{ path: "backend/src/index.ts", content, digest: digest(content), requirementIds: ["REQ-001"] }],
  } as unknown as AssembledCandidateArtifacts;
}

test("runner fails closed when no trusted external executor is configured", async () => {
  const result = await new ForgeWebIsolatedRunner().validate(candidate());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "unsupported_capability");
    assert.equal(result.error.diagnostics?.[0]?.code, "ISOLATED_RUNNER_UNAVAILABLE");
  }
});

test("supported executor receives only an immutable restricted snapshot and returns attested evidence", async () => {
  let received: IsolatedExecutionRequest | undefined;
  const executor: SandboxExecutor = {
    async execute(request) {
      received = request;
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.files[0]), true);
      return {
        candidateId: request.candidateId,
        snapshotDigest: request.snapshotDigest,
        policyDigest: request.policyDigest,
        sessionId: "sandbox-session",
        imageDigest: "sha256:immutable-runner-image",
        checks: ["typecheck", "build", "tests", "startup-health"].map((id) => ({ id, status: "passed" as const, required: true, evidence: `${id} passed in sandbox`, subjectPaths: [] })),
        findings: [],
      };
    },
  };
  const result = await new ForgeWebIsolatedRunner(executor).validate(candidate());
  assert.equal(result.ok, true);
  if (!result.ok || !received) return;
  assert.equal(result.value.execution.snapshotDigest, candidate().manifestDigest);
  assert.equal(received.policy.network, "none");
  assert.equal(received.policy.hostPathAccess, false);
  assert.equal(received.policy.forgeWebControlPlaneAccess, false);
  assert.equal(received.policy.userSecretAccess, false);
  assert.deepEqual(received.policy.environment, { CI: "true", NODE_ENV: "test" });
  assert.equal(JSON.stringify(received).includes("FORGEWEB"), false);
  assert.equal("DATABASE_URL" in received.policy.environment, false);
});

test("runner timeout is explicit and never reported as successful execution", async () => {
  const executor: SandboxExecutor = { execute: () => new Promise(() => undefined) };
  const result = await new ForgeWebIsolatedRunner(executor, isolatedRunnerPolicy(1_000)).validate(candidate());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "runner_failure");
    assert.equal(result.error.diagnostics?.[0]?.code, "ISOLATED_RUNNER_TIMEOUT");
  }
});

test("runner rejects evidence for another snapshot or policy", async () => {
  const executor: SandboxExecutor = {
    async execute(request) {
      return { candidateId: request.candidateId, snapshotDigest: "other", policyDigest: request.policyDigest, sessionId: "session", imageDigest: "image", checks: [], findings: [] };
    },
  };
  const result = await new ForgeWebIsolatedRunner(executor).validate(candidate());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "security_failure");
});

test("execution request contains no arbitrary host mounts or caller environment", () => {
  const request = isolatedExecutionRequest(candidate());
  assert.deepEqual(request.policy.mounts, [{ target: "/workspace", mode: "read-only-snapshot" }]);
  assert.deepEqual(request.policy.writablePaths, ["/tmp"]);
  assert.equal(JSON.stringify(request).includes(process.cwd()), false);
});

test("runner retains structured executor failure without exposing an arbitrary exception message", async () => {
  const executor: SandboxExecutor = { async execute() {
    throw new SandboxExecutionError("test-only-sensitive-token", [{ operation: "health", startedAt: new Date(0).toISOString(),
      elapsedMs: 59_000, remainingMs: 59_000, timedOut: true, completed: false, classification: "timeout",
      reason: "aggregate_execution_deadline", subprocessCode: "ETIMEDOUT", message: "test-only-sensitive-token" }]);
  } };
  const result = await new ForgeWebIsolatedRunner(executor).validate(candidate());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.executionDiagnostics?.[0].reason, "aggregate_execution_deadline");
    assert.equal(result.error.executionDiagnostics?.[0].operation, "health");
    assert.equal(result.error.executionDiagnostics?.[0].subprocessCode, "ETIMEDOUT");
    assert.ok(!JSON.stringify(result).includes("test-only-sensitive-token"));
  }
});
