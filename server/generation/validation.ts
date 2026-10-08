import { digest, safePath } from "../lib.ts";
import type { AssembledCandidateArtifacts } from "./candidate.ts";
import { CANDIDATE_ASSEMBLY_CONTRACT_VERSION, candidateAssemblyInputDigest, candidateOutputDigest } from "./candidate.ts";
import { baseReference, candidateManifestDigest, prepareGenerationRequest, prepareValidation } from "./contract.ts";
import type { CandidateArtifacts, CandidateValidation, EngineMetadata, EngineResult, GenerationRequest } from "./engine.ts";
import { FRONTEND_TARGET_PROFILE } from "./frontend.ts";
import { APPLICATION_TARGET, databaseTargetContract } from "./targets.ts";
import { crudOperations, operationForMethod } from "./nexarch/upstream/shared/utils/operations.ts";
import { snakeCase } from "./nexarch/upstream/shared/utils/strings.ts";
import { safeExecutionDiagnostics } from "./runner.ts";

export const REQUIRED_CHECKS = ["typecheck", "build", "tests", "dependencies", "security", "startup-health", "postgresql-runtime"] as const;
export const ISOLATED_CHECKS = ["typecheck", "build", "tests", "startup-health", "postgresql-runtime"] as const;

const VALIDATOR_ENGINE: EngineMetadata = {
  name: "forgeweb-candidate-validator",
  version: "1",
  contractVersion: "forgeweb-generation-v1",
};

type ValidationCheck = CandidateValidation["checks"][number];

export type IsolatedExecutionAttestation = {
  readonly kind: "isolated";
  readonly sessionId: string;
  readonly imageDigest: string;
  readonly snapshotDigest: string;
  readonly policyDigest: string;
};

export type IsolatedValidationResult = CandidateValidation & {
  readonly manifestDigest: string;
  readonly execution: IsolatedExecutionAttestation;
};

export type CandidateValidationReport = CandidateValidation & {
  readonly manifestDigest: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly execution:
    | IsolatedExecutionAttestation
    | { readonly kind: "not-run"; readonly reason: string };
  readonly postgres:
    | DisposablePostgresAttestation
    | { readonly kind: "not-run"; readonly reason: string };
};

export type DisposablePostgresAttestation = {
  readonly kind: "disposable-postgresql";
  readonly policyVersion: string;
  readonly snapshotDigest: string;
  readonly instanceDigest: string;
};

export type IsolatedRunnerEvidence = {
  readonly candidateId: string;
  readonly manifestDigest: string;
  readonly execution: IsolatedExecutionAttestation;
  readonly checks: readonly ValidationCheck[];
  readonly findings: CandidateValidation["findings"];
  readonly postgres?: DisposablePostgresAttestation;
  readonly executionDiagnostics?: CandidateValidation["executionDiagnostics"];
};

export interface IsolatedValidator {
  validate(candidate: CandidateArtifacts): Promise<EngineResult<IsolatedValidationResult>>;
}

/** Implementations must run outside the ForgeWeb host and use disposable data only. */
export interface IsolatedCandidateRunner {
  validate(candidate: AssembledCandidateArtifacts): Promise<EngineResult<IsolatedRunnerEvidence>>;
}

export interface CandidateValidationService {
  validate(request: GenerationRequest, candidate: CandidateArtifacts, runner?: IsolatedCandidateRunner): Promise<EngineResult<CandidateValidationReport>>;
}

export class UnavailableValidator implements IsolatedValidator {
  async validate(_candidate: CandidateArtifacts): Promise<EngineResult<IsolatedValidationResult>> {
    return { ok: false, engine: VALIDATOR_ENGINE, error: { code: "unsupported_capability", stage: "validation", message: "Isolated generated-code execution is unavailable", retryable: false } };
  }
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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function check(id: string, required: boolean, subjectPaths: readonly string[], assertion: () => void): ValidationCheck {
  try {
    assertion();
    return { id, status: "passed", required, evidence: `${id} verified by ForgeWeb static validation`, subjectPaths };
  } catch (error) {
    return { id, status: "failed", required, evidence: error instanceof Error ? error.message : `${id} failed`, subjectPaths };
  }
}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function assemblyOf(candidate: CandidateArtifacts): AssembledCandidateArtifacts["assembly"] {
  const assembly = (candidate as Partial<AssembledCandidateArtifacts>).assembly;
  requireCheck(assembly?.contractVersion === CANDIDATE_ASSEMBLY_CONTRACT_VERSION, "Candidate assembly metadata is missing or unsupported");
  return assembly;
}

function packageMetadata(candidate: CandidateArtifacts, path: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  const file = candidate.files.find((entry) => entry.path === path);
  requireCheck(file, `Missing ${path}`);
  return JSON.parse(file.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
}

function staticChecks(request: GenerationRequest, candidate: CandidateArtifacts): ValidationCheck[] {
  const paths = candidate.files.map((file) => file.path);
  return [
    check("approved-context", true, [], () => {
      const expectedBase = baseReference(request);
      requireCheck(candidate.projectId === request.scope.projectId && equal(candidate.actor, request.scope.actor), "Candidate owner or project context is stale");
      requireCheck(candidate.approvedPlanId === request.approved.planId && candidate.bindingDigest === request.approved.bindingDigest, "Candidate approval binding is stale");
      requireCheck(candidate.specificationId === request.approved.specification.id && candidate.specificationDigest === request.approved.digest && candidate.planDigest === request.approved.planDigest, "Candidate approved design is stale");
      requireCheck(equal(candidate.base, expectedBase), "Candidate base snapshot is stale");
      requireCheck(candidate.state === "candidate" && candidate.validationState === "pending" && candidate.acceptanceState === "unaccepted", "Candidate state is not isolated from acceptance");
    }),
    check("security", true, paths, () => {
      const seen = new Set<string>();
      for (const file of candidate.files) {
        requireCheck(typeof file.path === "string" && !file.path.includes("\\") && !file.path.includes(":") && !/^[/\\]/.test(file.path), `Unsafe candidate path: ${file.path}`);
        requireCheck(file.path === safePath(file.path) && /^(backend|frontend)\//.test(file.path), `Candidate file escaped its generated root: ${file.path}`);
        const key = file.path.toLowerCase();
        requireCheck(!seen.has(key), `Duplicate or case-colliding candidate path: ${file.path}`);
        seen.add(key);
      }
    }),
    check("manifest-consistency", true, paths, () => {
      const artifactKinds = new Set<string>();
      for (const file of candidate.files) requireCheck(file.digest === digest(file.content), `File digest mismatch: ${file.path}`);
      for (const entry of candidate.artifacts) {
        requireCheck(entry.digest === digest(entry.content), `Artifact digest mismatch: ${entry.kind}`);
        requireCheck(!artifactKinds.has(entry.kind), `Duplicate candidate artifact: ${entry.kind}`);
        artifactKinds.add(entry.kind);
      }
      requireCheck(candidate.manifestDigest === candidateManifestDigest(candidate), "Candidate manifest digest mismatch");
    }),
    check("requirement-traceability", true, paths, () => {
      const assembly = assemblyOf(candidate);
      const approved = new Set(request.approved.specification.requirements.map((requirement) => requirement.id));
      const mapped = new Map(assembly.traceability.files.map((entry) => [entry.path.toLowerCase(), entry.requirementIds]));
      const untraced = new Set(assembly.traceability.untracedFiles.filter((entry) => entry.reason === "shared-infrastructure").map((entry) => entry.path.toLowerCase()));
      for (const file of candidate.files) {
        const ids = mapped.get(file.path.toLowerCase());
        requireCheck(ids && equal([...ids].sort(), [...file.requirementIds].sort()), `Traceability metadata mismatch: ${file.path}`);
        requireCheck((ids.length > 0 || untraced.has(file.path.toLowerCase())) && ids.every((id) => approved.has(id)), `Unknown or unexplained requirement mapping: ${file.path}`);
      }
      const mappedFeatures = [
        ...assembly.traceability.backendRoutes,
        ...assembly.traceability.frontendPages,
        ...assembly.traceability.frontendComponents,
      ];
      requireCheck(mappedFeatures.every((entry) => entry.requirementIds.every((id) => approved.has(id))), "Feature traceability references an unknown requirement");
    }),
    check("dependencies", true, ["backend/package.json", "frontend/package.json"], () => {
      const assembly = assemblyOf(candidate);
      const backendPackage = packageMetadata(candidate, "backend/package.json");
      const frontendPackage = packageMetadata(candidate, "frontend/package.json");
      requireCheck(equal(backendPackage.dependencies ?? {}, assembly.dependencies.backend.runtime), "Backend dependency manifest differs from generated package metadata");
      requireCheck(equal(backendPackage.devDependencies ?? {}, assembly.dependencies.backend.development), "Backend development dependencies differ from generated package metadata");
      requireCheck(equal(frontendPackage.dependencies ?? {}, assembly.dependencies.frontend.runtime), "Frontend dependency manifest differs from generated package metadata");
      requireCheck(equal(frontendPackage.devDependencies ?? {}, assembly.dependencies.frontend.development), "Frontend development dependencies differ from generated package metadata");
    }),
    check("postgresql-prisma-consistency", true, ["backend/prisma/schema.prisma"], () => {
      const assembly = assemblyOf(candidate);
      requireCheck(equal(assembly.target.database.target, databaseTargetContract(APPLICATION_TARGET)), "Candidate database target is not the canonical PostgreSQL contract");
      requireCheck(assembly.target.database.dialect === "postgresql" && assembly.target.database.provider === "postgresql", "Candidate database metadata is not PostgreSQL");
      requireCheck(assembly.target.profile === request.options.targetProfile && assembly.target.frontendProfile === FRONTEND_TARGET_PROFILE, "Candidate generation profiles do not match the approved target");
      const schema = candidate.files.find((file) => file.path === "backend/prisma/schema.prisma")?.content;
      requireCheck(schema, "Generated Prisma schema is missing");
      requireCheck(/provider\s*=\s*"postgresql"/.test(schema) && /url\s*=\s*env\("DATABASE_URL"\)/.test(schema), "Prisma datasource is not PostgreSQL with an environment URL");
      const executableSchema = schema.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
      const mysqlOnly = executableSchema.match(/provider\s*=\s*"mysql"|InnoDB|SET\s+FOREIGN_KEY_CHECKS|@db\.(?:UnsignedInt|TinyInt|LongText|DateTime)\b/i)?.[0];
      requireCheck(!mysqlOnly, `Prisma schema contains a MySQL-only construct${mysqlOnly ? `: ${mysqlOnly}` : ""}`);
    }),
    check("generated-project-structure", true, paths, () => {
      const required = ["backend/package.json", "backend/prisma/schema.prisma", "frontend/package.json", "frontend/src/main.tsx"];
      for (const path of required) requireCheck(candidate.files.some((file) => file.path === path), `Generated project is missing ${path}`);
      requireCheck(candidate.files.some((file) => file.path.startsWith("backend/src/")), "Generated backend source is missing");
      requireCheck(candidate.files.some((file) => file.path.startsWith("frontend/src/")), "Generated frontend source is missing");
    }),
    check("frontend-backend-capabilities", true, [], () => {
      const assembly = assemblyOf(candidate);
      const implemented = new Set(assembly.capabilities.backendRoutes.filter((route) => route.status === "implemented").map((route) => `${route.method.toUpperCase()} ${route.path}`));
      const stubbed = new Set(assembly.capabilities.backendRoutes.filter((route) => route.status === "stub").map((route) => `${route.method.toUpperCase()} ${route.path}`));
      for (const call of assembly.capabilities.frontendApi.generatedCalls) {
        const key = `${call.method.toUpperCase()} ${call.path}`;
        requireCheck(implemented.has(key) && !stubbed.has(key), `Frontend calls unavailable backend capability: ${key}`);
      }
      for (const route of assembly.capabilities.frontendApi.availableRoutes) requireCheck(implemented.has(`${route.method.toUpperCase()} ${route.path}`), `Frontend marks an unavailable backend route as available: ${route.method} ${route.path}`);
      for (const route of assembly.capabilities.frontendApi.unavailableRoutes) requireCheck(stubbed.has(`${route.method.toUpperCase()} ${route.path}`), `Frontend unavailable route is not an explicit backend stub: ${route.method} ${route.path}`);
      requireCheck(assembly.capabilities.frontendApi.backendSliceDigest === assembly.slices.backendDigest, "Frontend capability manifest targets a different backend slice");
      requireCheck(assembly.capabilities.backend.totalRoutes === assembly.capabilities.backendRoutes.length
        && assembly.capabilities.backend.implementedRoutes === assembly.capabilities.backendRoutes.filter((route) => route.status === "implemented").length
        && assembly.capabilities.backend.stubRoutes === assembly.capabilities.backendRoutes.filter((route) => route.status === "stub").length,
      "Backend capability totals are inconsistent");
    }),
    check("semantic-coverage", true, paths, () => {
      const design = request.approved.specification.semantics?.design;
      if (!design) return;
      const assembly = assemblyOf(candidate);
      const requirements = JSON.parse(candidate.artifacts.find(artifact => artifact.kind === "requirements")?.content ?? "null");
      requireCheck(equal(requirements?.semantics?.design, design), "Candidate semantic design differs from the approved contract");
      const schema = candidate.files.find(file => file.path === "backend/prisma/schema.prisma")?.content ?? "";
      for (const entity of design.entities) {
        const backend = assembly.evidence.backendEntities.find(item => item.name === entity.name);
        requireCheck(backend, `Semantic entity is missing: ${entity.name}`);
        const model = new RegExp(`\\bmodel\\s+${regexLiteral(entity.name)}\\s*\\{([^}]+)\\}`).exec(schema)?.[1] ?? "";
        for (const field of entity.fields) {
          requireCheck(backend.fields.includes(snakeCase(field.name)) && new RegExp(`^\\s*${regexLiteral(field.name)}\\s+\\w+`, "m").test(model), `Semantic field is missing: ${entity.name}.${field.name}`);
        }
        const routes = assembly.capabilities.backendRoutes.filter(route => route.entity === entity.name);
        if (entity.operationPolicy !== "explicit") continue;
        const supported = crudOperations(entity);
        for (const route of routes) requireCheck(supported.includes(operationForMethod(route.method)), `Unrequested operation emitted: ${entity.name}.${operationForMethod(route.method)}`);
        for (const action of supported) {
          requireCheck(routes.some(route => route.status === "implemented" && operationForMethod(route.method) === action), `Supported semantic operation is missing: ${entity.name}.${action}`);
        }
        const page = assembly.evidence.frontendPages.find(page => page.entity === entity.name);
        if (supported.includes("read")) requireCheck(page?.status === "implemented", `Supported entity page is missing: ${entity.name}`);
        for (const operation of entity.operations.filter(operation => operation.intent === "requested" && operation.action === "domain")) {
          requireCheck(operation.support === "unsupported", `Domain operation lacks truthful support metadata: ${entity.name}.${operation.name}`);
          requireCheck(!routes.some(route => route.path.split("/").includes(operation.name) && route.status === "implemented"), `Unsupported domain operation is reported implemented: ${entity.name}.${operation.name}`);
        }
      }
    }),
    check("deterministic-integrity", true, [], () => {
      const assembled = candidate as AssembledCandidateArtifacts;
      const assembly = assemblyOf(candidate);
      requireCheck(assembly.determinism.normalized === true, "Candidate determinism is not normalized");
      requireCheck(assembly.determinism.inputDigest === candidateAssemblyInputDigest(request, assembly.slices.backendDigest, assembly.slices.frontendDigest), "Candidate input digest mismatch");
      requireCheck(assembly.determinism.outputDigest === candidateOutputDigest(assembled), "Candidate output digest mismatch");
      requireCheck(candidate.id === `candidate_${assembly.determinism.outputDigest.slice(0, 24)}`, "Candidate identity does not match its deterministic digest");
    }),
  ];
}

function unavailableRunnerChecks(reason: string): ValidationCheck[] {
  return ISOLATED_CHECKS.map((id) => ({ id, status: "unavailable", required: true, evidence: reason, subjectPaths: [] }));
}

function reportStatus(checks: readonly ValidationCheck[]): CandidateValidationReport["status"] {
  if (checks.some((entry) => entry.required && entry.status === "failed")) return "failed";
  if (checks.some((entry) => entry.required && ["unavailable", "blocked", "skipped"].includes(entry.status))) return "unavailable";
  return "passed";
}

export class ForgeWebCandidateValidator implements CandidateValidationService {
  async validate(requestInput: GenerationRequest, candidate: CandidateArtifacts, runner?: IsolatedCandidateRunner): Promise<EngineResult<CandidateValidationReport>> {
    let request: GenerationRequest;
    try {
      request = prepareGenerationRequest(requestInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Validation request is invalid";
      return { ok: false, engine: VALIDATOR_ENGINE, error: { code: "validation_failure", stage: "candidate-validation", message, retryable: false } };
    }

    const checks = staticChecks(request, candidate);
    const findings: CandidateValidation["findings"][number][] = checks
      .filter((entry) => entry.status === "failed")
      .map((entry) => ({ code: entry.id.toUpperCase().replaceAll("-", "_"), severity: "error", message: entry.evidence, paths: entry.subjectPaths, requirementIds: [] }));
    let execution: CandidateValidationReport["execution"] = { kind: "not-run", reason: "No isolated candidate runner was provided" };
    let postgres: CandidateValidationReport["postgres"] = { kind: "not-run", reason: "No disposable PostgreSQL evidence was provided" };
    let executionDiagnostics: CandidateValidation["executionDiagnostics"];

    if (!runner) {
      checks.push(...unavailableRunnerChecks(execution.reason));
    } else if (checks.some((entry) => entry.required && entry.status === "failed")) {
      execution = { kind: "not-run", reason: "Static validation failed before isolated execution" };
      checks.push(...ISOLATED_CHECKS.map((id) => ({ id, status: "skipped" as const, required: true, evidence: "Static validation failed before isolated execution", subjectPaths: [] })));
    } else {
      const isolated = await runner.validate(candidate as AssembledCandidateArtifacts);
      executionDiagnostics = safeExecutionDiagnostics(isolated.ok ? isolated.value.executionDiagnostics : isolated.error.executionDiagnostics);
      if (!isolated.ok) {
        checks.push(...unavailableRunnerChecks(isolated.error.message));
        findings.push({ code: "ISOLATED_RUNNER_UNAVAILABLE", severity: "error", message: isolated.error.message, paths: [], requirementIds: [] });
      } else if (isolated.value.candidateId !== candidate.id || isolated.value.manifestDigest !== candidate.manifestDigest
        || !isolated.value.execution.sessionId || !isolated.value.execution.imageDigest
        || !isolated.value.execution.snapshotDigest || !isolated.value.execution.policyDigest) {
        checks.push(...ISOLATED_CHECKS.map((id) => ({ id, status: "failed" as const, required: true, evidence: "Isolated evidence targets another candidate", subjectPaths: [] })));
        findings.push({ code: "STALE_ISOLATED_EVIDENCE", severity: "error", message: "Isolated evidence targets another candidate", paths: [], requirementIds: [] });
      } else {
        const evidenceById = new Map(isolated.value.checks.map((entry) => [entry.id, entry]));
        for (const id of ISOLATED_CHECKS) {
          const evidence = evidenceById.get(id);
          if (id === "postgresql-runtime") {
            const attestation = isolated.value.postgres;
            const validAttestation = attestation?.kind === "disposable-postgresql"
              && attestation.snapshotDigest === candidate.manifestDigest
              && Boolean(attestation.instanceDigest && attestation.policyVersion);
            checks.push(validAttestation && evidence
              ? { ...evidence, id, required: true }
              : { id, status: "unavailable", required: true, evidence: "Disposable PostgreSQL attestation is unavailable", subjectPaths: [] });
            if (validAttestation) postgres = attestation;
            else findings.push({ code: "POSTGRESQL_ATTESTATION_UNAVAILABLE", severity: "error", message: "Disposable PostgreSQL attestation is unavailable", paths: [], requirementIds: [] });
          } else {
            checks.push(evidence ? { ...evidence, id, required: true } : { id, status: "unavailable", required: true, evidence: `Isolated runner did not report ${id}`, subjectPaths: [] });
          }
        }
        findings.push(...isolated.value.findings);
        execution = isolated.value.execution;
      }
    }

    checks.push({ id: "live-production-preview", status: "skipped", required: false, evidence: "Runtime preview is evaluated only after acceptance and requires a trusted external executor", subjectPaths: [] });
    const report: CandidateValidationReport = {
      candidateId: candidate.id,
      manifestDigest: candidate.manifestDigest,
      status: reportStatus(checks),
      execution,
      postgres,
      checks,
      findings,
      ...(executionDiagnostics?.length ? { executionDiagnostics } : {}),
    };
    return { ok: true, engine: VALIDATOR_ENGINE, value: prepareValidation(report, candidate) as CandidateValidationReport };
  }
}

/** Evidence supplied by ForgeWeb's trusted validator/reviewer, never by generation success. No acceptance writes. */
export function candidateReadyForAcceptance(candidate: CandidateArtifacts, validation: IsolatedValidationResult, review: { candidateId: string; manifestDigest: string; passed: boolean }): boolean {
  return candidate.state === "candidate" && candidate.acceptanceState === "unaccepted"
    && candidate.manifestDigest === candidateManifestDigest(candidate)
    && validation.candidateId === candidate.id && validation.manifestDigest === candidate.manifestDigest
    && validation.execution?.kind === "isolated" && Boolean(validation.execution.sessionId && validation.execution.imageDigest && validation.execution.snapshotDigest && validation.execution.policyDigest)
    && validation.execution.snapshotDigest === candidate.manifestDigest
    && new Set(validation.checks.map((entry) => entry.id)).size === validation.checks.length
    && REQUIRED_CHECKS.every((id) => validation.checks.some((entry) => entry.id === id && entry.required && entry.status === "passed" && Boolean(entry.evidence)))
    && validation.checks.every((entry) => !entry.required || entry.status === "passed")
    && !validation.findings.some((finding) => finding.severity === "error")
    && review.candidateId === candidate.id && review.manifestDigest === candidate.manifestDigest && review.passed;
}
