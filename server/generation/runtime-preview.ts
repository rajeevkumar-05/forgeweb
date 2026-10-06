import type { Project } from "../domain.ts";
import { digest } from "../lib.ts";
import { JsonStore } from "../store.ts";
import type { OwnerVerifier } from "./approval.ts";
import { fileManifestDigest } from "./contract.ts";
import type { EngineActor, EngineMetadata, EngineResult } from "./engine.ts";
import { isolatedRunnerPolicy } from "./runner.ts";
import type { IsolatedRunnerPolicy } from "./runner.ts";

export const RUNTIME_PREVIEW_CONTRACT_VERSION = "forgeweb-runtime-preview-v1" as const;

const PREVIEW_ENGINE: EngineMetadata = {
  name: "forgeweb-runtime-preview",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

export type AcceptedRuntimePreviewRequest = {
  readonly contractVersion: typeof RUNTIME_PREVIEW_CONTRACT_VERSION;
  readonly projectId: string;
  readonly versionId: string;
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly policyDigest: string;
  readonly policy: IsolatedRunnerPolicy;
  readonly files: readonly { readonly path: string; readonly content: string; readonly digest: string }[];
};

export type RuntimePreviewExecution = {
  readonly projectId: string;
  readonly versionId: string;
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly policyDigest: string;
  readonly sessionId: string;
  readonly imageDigest: string;
  readonly previewUrl: string;
};

/** Trusted adapter to an external runtime. Implementations must never execute inside the API process. */
export interface RuntimePreviewExecutor {
  start(request: AcceptedRuntimePreviewRequest): Promise<RuntimePreviewExecution>;
}

export type RuntimePreviewResult =
  | { readonly status: "ready"; readonly versionId: string; readonly candidateId: string; readonly snapshotDigest: string; readonly execution: RuntimePreviewExecution }
  | { readonly status: "unavailable"; readonly versionId: string; readonly candidateId: string; readonly snapshotDigest: string; readonly code: "TRUSTED_RUNTIME_UNAVAILABLE"; readonly reason: string };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function stableDigest(value: unknown): string {
  return digest(JSON.stringify(canonical(value)));
}

function failure(message: string, diagnosticCode: string): EngineResult<RuntimePreviewResult> {
  return {
    ok: false,
    engine: PREVIEW_ENGINE,
    error: { code: "security_failure", stage: "runtime-preview", message, retryable: false, diagnostics: [{ code: diagnosticCode, message }] },
  };
}

const denyUnverifiedOwner: OwnerVerifier = () => false;

export class AcceptedRuntimePreviewService {
  private readonly store: JsonStore;
  private readonly verifyOwner: OwnerVerifier;
  private readonly executor?: RuntimePreviewExecutor;
  private readonly policy: IsolatedRunnerPolicy;

  constructor(store: JsonStore, verifyOwner: OwnerVerifier = denyUnverifiedOwner, executor?: RuntimePreviewExecutor, policy = isolatedRunnerPolicy()) {
    this.store = store;
    this.verifyOwner = verifyOwner;
    this.executor = executor;
    this.policy = policy;
  }

  private async authorized(project: Project | undefined, actor: EngineActor): Promise<boolean> {
    return Boolean(project && actor.kind === "authenticated" && actor.ownerId && actor.subjectId
      && await this.verifyOwner(structuredClone(project), structuredClone(actor)));
  }

  async preview(projectId: string, versionId: string, actorInput: EngineActor): Promise<EngineResult<RuntimePreviewResult>> {
    const actor = structuredClone(actorInput);
    const database = this.store.read();
    const project = database.projects[projectId];
    if (!await this.authorized(project, actor)) return failure("Verified ForgeWeb owner authorization is required", "OWNER_AUTHORIZATION_FAILED");
    const version = database.versions[versionId];
    if (!version || version.projectId !== projectId || !version.candidateId || version.validationStatus !== "passed" || version.layout?.profile !== "forgeweb-generated-v1") {
      return failure("Runtime preview requires an accepted generated ProjectVersion", "ACCEPTED_GENERATED_VERSION_REQUIRED");
    }
    const record = database.generationCandidates[version.candidateId];
    const files = database.versionFiles[versionId];
    if (!record || record.status !== "accepted" || record.acceptedVersionId !== versionId || !files) {
      return failure("Accepted candidate/version linkage is missing or stale", "ACCEPTED_VERSION_LINK_INVALID");
    }
    const candidateFiles = new Map(record.candidate.files.map((file) => [file.path, file]));
    const immutableFiles = files.length === candidateFiles.size && files.every((file) => {
      const source = candidateFiles.get(file.path);
      if (!source) return false;
      return file.digest === digest(file.content) && source.digest === digest(source.content)
        && source.content === file.content && source.digest === file.digest;
    });
    if (record.ownerId !== actor.ownerId || record.subjectId !== actor.subjectId
      || version.candidateDigest !== record.candidateDigest || version.candidateManifestDigest !== record.manifestDigest
      || !immutableFiles || fileManifestDigest(files) !== fileManifestDigest(record.candidate.files)) {
      return failure("Accepted runtime snapshot failed its immutable linkage check", "ACCEPTED_SNAPSHOT_MISMATCH");
    }

    const snapshotDigest = fileManifestDigest(files);
    const policyDigest = stableDigest(this.policy);
    if (!this.executor) {
      return {
        ok: true,
        engine: PREVIEW_ENGINE,
        value: {
          status: "unavailable",
          versionId,
          candidateId: record.id,
          snapshotDigest,
          code: "TRUSTED_RUNTIME_UNAVAILABLE",
          reason: "No trusted external runtime executor is configured; accepted code was not executed",
        },
      };
    }

    const request: AcceptedRuntimePreviewRequest = Object.freeze({
      contractVersion: RUNTIME_PREVIEW_CONTRACT_VERSION,
      projectId,
      versionId,
      candidateId: record.id,
      snapshotDigest,
      policyDigest,
      policy: this.policy,
      files: Object.freeze(files.map((file) => Object.freeze({ path: file.path, content: file.content, digest: file.digest }))),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("RUNTIME_PREVIEW_TIMEOUT")), this.policy.timeoutMs);
      });
      const execution = await Promise.race([this.executor.start(request), timeout]);
      if (execution.projectId !== projectId || execution.versionId !== versionId || execution.candidateId !== record.id
        || execution.snapshotDigest !== snapshotDigest || execution.policyDigest !== policyDigest
        || !execution.sessionId || !execution.imageDigest) {
        return failure("Runtime preview evidence does not match the accepted snapshot and isolation policy", "RUNTIME_ATTESTATION_MISMATCH");
      }
      let previewUrl: URL;
      try { previewUrl = new URL(execution.previewUrl); } catch { return failure("Runtime preview returned an invalid URL", "RUNTIME_URL_INVALID"); }
      if (previewUrl.protocol !== "https:") return failure("Runtime preview URL must use HTTPS", "RUNTIME_URL_INSECURE");
      return { ok: true, engine: PREVIEW_ENGINE, value: { status: "ready", versionId, candidateId: record.id, snapshotDigest, execution: structuredClone(execution) } };
    } catch (error) {
      return failure(error instanceof Error && error.message === "RUNTIME_PREVIEW_TIMEOUT" ? "External runtime preview timed out" : "External runtime preview failed", "RUNTIME_PREVIEW_FAILED");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
