import { digest } from "../lib.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import type { CandidateValidation, EngineMetadata, EngineResult } from "./engine.ts";
import type { IsolatedCandidateRunner, IsolatedRunnerEvidence } from "./validation.ts";

export const DISPOSABLE_POSTGRES_POLICY_VERSION = "forgeweb-disposable-postgresql-v1" as const;

const POSTGRES_ENGINE: EngineMetadata = {
  name: "forgeweb-postgresql-validator",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

type ValidationCheck = CandidateValidation["checks"][number];

export type DisposablePostgresRequest = {
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly target: {
    readonly kind: "disposable-postgresql";
    readonly policyVersion: typeof DISPOSABLE_POSTGRES_POLICY_VERSION;
    readonly network: "isolated";
    readonly userDatabaseAccess: false;
    readonly forgeWebControlPlaneAccess: false;
    readonly destroyAfterValidation: true;
  };
  readonly schema: { readonly path: "backend/prisma/schema.prisma"; readonly content: string; readonly digest: string };
  readonly migrations: readonly { readonly path: string; readonly content: string; readonly digest: string }[];
};

export type DisposablePostgresExecution = {
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly instanceDigest: string;
  readonly schema: { readonly status: "passed" | "failed"; readonly evidence: string };
  readonly migrations: { readonly status: "passed" | "failed"; readonly evidence: string };
};

/** Trusted provider for a disposable PostgreSQL instance. It receives no URL or credential. */
export interface DisposablePostgresProvider {
  validate(request: DisposablePostgresRequest): Promise<DisposablePostgresExecution>;
}

export type PostgresValidationReport = {
  readonly candidateId: string;
  readonly snapshotDigest: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly target: DisposablePostgresRequest["target"];
  readonly instanceDigest?: string;
  readonly checks: readonly ValidationCheck[];
  readonly findings: CandidateValidation["findings"];
};

function target(): DisposablePostgresRequest["target"] {
  return {
    kind: "disposable-postgresql",
    policyVersion: DISPOSABLE_POSTGRES_POLICY_VERSION,
    network: "isolated",
    userDatabaseAccess: false,
    forgeWebControlPlaneAccess: false,
    destroyAfterValidation: true,
  };
}

export function disposablePostgresRequest(candidate: AssembledCandidateArtifacts): DisposablePostgresRequest {
  const schema = candidate.files.find((file) => file.path === "backend/prisma/schema.prisma");
  if (!schema) throw new TypeError("Generated Prisma schema is missing");
  const migrations = candidate.files
    .filter((file) => file.path.startsWith("backend/prisma/migrations/"))
    .map((file) => ({ path: file.path, content: file.content, digest: file.digest }));
  return Object.freeze({
    candidateId: candidate.id,
    snapshotDigest: candidate.manifestDigest,
    target: Object.freeze(target()),
    schema: Object.freeze({ path: "backend/prisma/schema.prisma" as const, content: schema.content, digest: schema.digest }),
    migrations: Object.freeze(migrations.map((migration) => Object.freeze(migration))),
  });
}

function check(id: string, status: ValidationCheck["status"], evidence: string, subjectPaths: readonly string[]): ValidationCheck {
  return { id, status, required: true, evidence, subjectPaths };
}

function staticSchemaFailure(request: DisposablePostgresRequest): string | undefined {
  if (request.schema.digest !== digest(request.schema.content)) return "Prisma schema digest mismatch";
  if (!/provider\s*=\s*"postgresql"/.test(request.schema.content)) return "Prisma datasource provider is not PostgreSQL";
  if (!/url\s*=\s*env\("DATABASE_URL"\)/.test(request.schema.content)) return "Prisma datasource must use the DATABASE_URL environment placeholder";
  if (/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i.test(request.schema.content)) return "Prisma schema contains an embedded database credential";
  if (/provider\s*=\s*"mysql"|InnoDB|SET\s+FOREIGN_KEY_CHECKS/i.test(request.schema.content)) return "Prisma schema contains a MySQL-only construct";
  return undefined;
}

export class ForgeWebPostgresValidator {
  private readonly provider?: DisposablePostgresProvider;

  constructor(provider?: DisposablePostgresProvider) {
    this.provider = provider;
  }

  async validate(candidate: AssembledCandidateArtifacts): Promise<PostgresValidationReport> {
    let request: DisposablePostgresRequest;
    try {
      request = disposablePostgresRequest(candidate);
    } catch (error) {
      const evidence = error instanceof Error ? error.message : "PostgreSQL validation request is malformed";
      return {
        candidateId: candidate.id,
        snapshotDigest: candidate.manifestDigest,
        status: "failed",
        target: target(),
        checks: [check("postgresql-schema", "failed", evidence, ["backend/prisma/schema.prisma"]), check("postgresql-migrations", "skipped", "Schema validation failed", []), check("postgresql-runtime", "skipped", "Schema validation failed", [])],
        findings: [{ code: "POSTGRESQL_SCHEMA_INVALID", severity: "error", message: evidence, paths: ["backend/prisma/schema.prisma"], requirementIds: [] }],
      };
    }

    const staticFailure = staticSchemaFailure(request);
    if (staticFailure) {
      return {
        candidateId: candidate.id,
        snapshotDigest: candidate.manifestDigest,
        status: "failed",
        target: request.target,
        checks: [check("postgresql-schema", "failed", staticFailure, [request.schema.path]), check("postgresql-migrations", "skipped", "Schema validation failed", request.migrations.map((entry) => entry.path)), check("postgresql-runtime", "skipped", "Schema validation failed", [])],
        findings: [{ code: "POSTGRESQL_SCHEMA_INVALID", severity: "error", message: staticFailure, paths: [request.schema.path], requirementIds: [] }],
      };
    }

    if (!this.provider) {
      const reason = "No trusted disposable PostgreSQL provider is configured; no database was accessed";
      return {
        candidateId: candidate.id,
        snapshotDigest: candidate.manifestDigest,
        status: "unavailable",
        target: request.target,
        checks: [check("postgresql-schema", "passed", "PostgreSQL datasource and schema metadata passed static validation", [request.schema.path]), check("postgresql-migrations", "unavailable", reason, request.migrations.map((entry) => entry.path)), check("postgresql-runtime", "unavailable", reason, [])],
        findings: [],
      };
    }

    try {
      const result = await this.provider.validate(request);
      if (result.candidateId !== candidate.id || result.snapshotDigest !== candidate.manifestDigest || !result.instanceDigest) {
        throw new TypeError("Disposable PostgreSQL evidence does not match the candidate snapshot");
      }
      const checks = [
        check("postgresql-schema", result.schema.status, result.schema.evidence, [request.schema.path]),
        check("postgresql-migrations", result.migrations.status, result.migrations.evidence, request.migrations.map((entry) => entry.path)),
        check("postgresql-runtime", result.schema.status === "passed" && result.migrations.status === "passed" ? "passed" : "failed", `Disposable instance ${result.instanceDigest}; ${result.schema.evidence}; ${result.migrations.evidence}`, []),
      ];
      const failed = checks.some((entry) => entry.status === "failed");
      return {
        candidateId: candidate.id,
        snapshotDigest: candidate.manifestDigest,
        status: failed ? "failed" : "passed",
        target: request.target,
        instanceDigest: result.instanceDigest,
        checks,
        findings: failed ? [{ code: "POSTGRESQL_VALIDATION_FAILED", severity: "error", message: "Disposable PostgreSQL validation failed", paths: [request.schema.path, ...request.migrations.map((entry) => entry.path)], requirementIds: [] }] : [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Disposable PostgreSQL validation is unavailable";
      return {
        candidateId: candidate.id,
        snapshotDigest: candidate.manifestDigest,
        status: "unavailable",
        target: request.target,
        checks: [check("postgresql-schema", "passed", "PostgreSQL datasource and schema metadata passed static validation", [request.schema.path]), check("postgresql-migrations", "unavailable", reason, request.migrations.map((entry) => entry.path)), check("postgresql-runtime", "unavailable", reason, [])],
        findings: [{ code: "POSTGRESQL_PROVIDER_UNAVAILABLE", severity: "error", message: reason, paths: [], requirementIds: [] }],
      };
    }
  }
}

export class CombinedValidationRunner implements IsolatedCandidateRunner {
  private readonly runner: IsolatedCandidateRunner;
  private readonly postgres: ForgeWebPostgresValidator;

  constructor(runner: IsolatedCandidateRunner, postgres: ForgeWebPostgresValidator) {
    this.runner = runner;
    this.postgres = postgres;
  }

  async validate(candidate: AssembledCandidateArtifacts): Promise<EngineResult<IsolatedRunnerEvidence>> {
    const execution = await this.runner.validate(candidate);
    if (!execution.ok) return execution;
    const postgres = await this.postgres.validate(candidate);
    const postgresRuntime = postgres.checks.find((entry) => entry.id === "postgresql-runtime")!;
    return {
      ok: true,
      engine: POSTGRES_ENGINE,
      value: {
        ...execution.value,
        checks: [...execution.value.checks.filter((entry) => entry.id !== "postgresql-runtime"), postgresRuntime],
        findings: [...execution.value.findings, ...postgres.findings],
        ...(postgres.status === "passed" && postgres.instanceDigest ? { postgres: {
          kind: "disposable-postgresql" as const,
          policyVersion: DISPOSABLE_POSTGRES_POLICY_VERSION,
          snapshotDigest: postgres.snapshotDigest,
          instanceDigest: postgres.instanceDigest,
        } } : {}),
      },
    };
  }
}
