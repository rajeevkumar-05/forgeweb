import { digest } from "../lib.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import type { CandidateValidation, EngineMetadata, EngineResult } from "./engine.ts";
import type { IsolatedCandidateRunner, IsolatedRunnerEvidence } from "./validation.ts";

export const RUNNER_POLICY_VERSION = "forgeweb-isolated-runner-v1" as const;

const RUNNER_ENGINE: EngineMetadata = {
  name: "forgeweb-isolated-runner",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

export type IsolatedRunnerPolicy = {
  readonly version: typeof RUNNER_POLICY_VERSION;
  readonly boundary: "external-container";
  readonly timeoutMs: number;
  readonly network: "none";
  readonly environment: Readonly<Record<"CI" | "NODE_ENV", string>>;
  readonly mounts: readonly [{ readonly target: "/workspace"; readonly mode: "read-only-snapshot" }];
  readonly writablePaths: readonly ["/tmp"];
  readonly hostPathAccess: false;
  readonly forgeWebControlPlaneAccess: false;
  readonly userSecretAccess: false;
  readonly resources: { readonly memoryMb: number; readonly cpuMillis: number; readonly maxProcesses: number };
};

export type IsolatedExecutionRequest = {
  readonly candidateId: string;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly policyDigest: string;
  readonly policy: IsolatedRunnerPolicy;
  readonly files: readonly { readonly path: string; readonly content: string; readonly digest: string }[];
};

export type SandboxExecutionResult = {
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly policyDigest: string;
  readonly sessionId: string;
  readonly imageDigest: string;
  readonly checks: readonly CandidateValidation["checks"][number][];
  readonly findings: CandidateValidation["findings"];
};

/** Trusted adapter to an OS/container sandbox. Implementations must not run in the API process. */
export interface SandboxExecutor {
  execute(request: IsolatedExecutionRequest): Promise<SandboxExecutionResult>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function stableDigest(value: unknown): string {
  return digest(JSON.stringify(canonical(value)));
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function isolatedRunnerPolicy(timeoutMs = 120_000): IsolatedRunnerPolicy {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new TypeError("Runner timeout must be between 1 and 600 seconds");
  return freezeTree({
    version: RUNNER_POLICY_VERSION,
    boundary: "external-container",
    timeoutMs,
    network: "none",
    environment: { CI: "true", NODE_ENV: "test" },
    mounts: [{ target: "/workspace", mode: "read-only-snapshot" }],
    writablePaths: ["/tmp"],
    hostPathAccess: false,
    forgeWebControlPlaneAccess: false,
    userSecretAccess: false,
    resources: { memoryMb: 768, cpuMillis: 60_000, maxProcesses: 64 },
  });
}

export function isolatedExecutionRequest(candidate: AssembledCandidateArtifacts, policy = isolatedRunnerPolicy()): IsolatedExecutionRequest {
  const snapshot = candidate.files.map((file) => ({ path: file.path, content: file.content, digest: file.digest }));
  const snapshotDigest = candidate.manifestDigest;
  return freezeTree({
    candidateId: candidate.id,
    manifestDigest: candidate.manifestDigest,
    snapshotDigest,
    policyDigest: stableDigest(policy),
    policy,
    files: snapshot,
  });
}

function runnerFailure(code: "unsupported_capability" | "runner_failure" | "security_failure", message: string, diagnosticCode: string): EngineResult<IsolatedRunnerEvidence> {
  return {
    ok: false,
    engine: RUNNER_ENGINE,
    error: { code, stage: "isolated-validation", message, retryable: false, diagnostics: [{ code: diagnosticCode, message }] },
  };
}

export class ForgeWebIsolatedRunner implements IsolatedCandidateRunner {
  private readonly executor?: SandboxExecutor;
  private readonly policy: IsolatedRunnerPolicy;

  constructor(executor?: SandboxExecutor, policy = isolatedRunnerPolicy()) {
    this.executor = executor;
    this.policy = policy;
  }

  async validate(candidate: AssembledCandidateArtifacts): Promise<EngineResult<IsolatedRunnerEvidence>> {
    if (!this.executor) {
      return runnerFailure("unsupported_capability", "No trusted external container executor is configured; generated code was not executed", "ISOLATED_RUNNER_UNAVAILABLE");
    }
    const request = isolatedExecutionRequest(candidate, this.policy);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ISOLATED_RUNNER_TIMEOUT")), this.policy.timeoutMs);
      });
      const result = await Promise.race([this.executor.execute(request), timeout]);
      if (result.candidateId !== candidate.id || result.snapshotDigest !== request.snapshotDigest || result.policyDigest !== request.policyDigest) {
        return runnerFailure("security_failure", "Sandbox evidence does not match the immutable candidate snapshot and policy", "RUNNER_ATTESTATION_MISMATCH");
      }
      if (!result.sessionId || !result.imageDigest) {
        return runnerFailure("security_failure", "Sandbox evidence is missing its session or immutable image identity", "RUNNER_ATTESTATION_INVALID");
      }
      return {
        ok: true,
        engine: RUNNER_ENGINE,
        value: {
          candidateId: candidate.id,
          manifestDigest: candidate.manifestDigest,
          execution: {
            kind: "isolated",
            sessionId: result.sessionId,
            imageDigest: result.imageDigest,
            snapshotDigest: request.snapshotDigest,
            policyDigest: request.policyDigest,
          },
          checks: structuredClone(result.checks),
          findings: structuredClone(result.findings),
        },
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.message === "ISOLATED_RUNNER_TIMEOUT";
      return runnerFailure("runner_failure", timedOut ? `Isolated execution exceeded ${this.policy.timeoutMs}ms` : "External isolated execution failed", timedOut ? "ISOLATED_RUNNER_TIMEOUT" : "ISOLATED_RUNNER_FAILED");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
