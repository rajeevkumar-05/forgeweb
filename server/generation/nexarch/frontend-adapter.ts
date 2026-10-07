import { digest, safePath } from "../../lib.ts";
import type { BackendSlice } from "../backend.ts";
import { prepareBackendSlice } from "../backend.ts";
import { prepareGenerationRequest } from "../contract.ts";
import type { EngineFailureCode, EngineMetadata, EngineResult, GenerationRequest } from "../engine.ts";
import type { FrontendGenerationService, FrontendSlice, FrontendSliceFile } from "../frontend.ts";
import { FRONTEND_SLICE_CONTRACT_VERSION, FRONTEND_TARGET_PROFILE, FrontendSliceValidationError, frontendInputDigest, frontendOutputDigest, prepareFrontendSlice } from "../frontend.ts";
import { APPLICATION_TARGET } from "../targets.ts";
import { upstreamArchitecture, upstreamDatabase, upstreamRequirements } from "./backend-adapter.ts";
import { generateEntityMetadata } from "./upstream/modules/database-designer/lib/entity-metadata-generator.ts";
import { generateOpenApi } from "./upstream/modules/database-designer/lib/openapi-generator.ts";
import { generateFrontend as upstreamGenerateFrontend } from "./upstream/modules/frontend-generator/frontend-generator.service.ts";
import type { BackendManifest, GeneratedFrontend } from "./upstream/modules/frontend-generator/frontend-generator.types.ts";
import { crudOperations, operationForMethod } from "./upstream/shared/utils/operations.ts";

export const NEXARCH_FRONTEND_REVISION = "398f4cbd9e314954eda95540411ed4d06cd50cf3";
const ENGINE: EngineMetadata = { name: "forgeweb-nexarch-frontend", version: "1", contractVersion: "forgeweb-generation-v1" };
const PROTECTED_ROOTS = new Set([".git", ".github", "backend", "docs", "node_modules", "server", "dist", "dist-server"]);

export type FrontendEmitter = typeof upstreamGenerateFrontend;

function success(value: FrontendSlice): EngineResult<FrontendSlice> {
  return { ok: true, value, engine: ENGINE };
}

function failure(code: EngineFailureCode, message: string, diagnosticCode: string, diagnosticMessage = message, path?: string): EngineResult<FrontendSlice> {
  return { ok: false, engine: ENGINE, error: { code, stage: "frontend-generation", message, retryable: false, diagnostics: [{ code: diagnosticCode, message: diagnosticMessage, ...(path ? { path } : {}) }] } };
}

function checkedRawPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes(":") || /^[/\\]/.test(path) || /^[a-zA-Z]:/.test(path)) {
    throw new FrontendSliceValidationError("INVALID_PATH", "Generated path must be relative and normalized", typeof path === "string" ? path : undefined);
  }
  if (path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new FrontendSliceValidationError("INVALID_PATH", "Generated path contains traversal or invalid segments", path);
  }
  try {
    if (path !== safePath(path)) throw new Error("not normalized");
  } catch {
    throw new FrontendSliceValidationError("INVALID_PATH", "Generated path contains traversal or invalid segments", path);
  }
  const root = path.split("/")[0]?.toLowerCase();
  if (!root || root === "frontend" || PROTECTED_ROOTS.has(root)) throw new FrontendSliceValidationError("PROTECTED_PATH", "Generated path targets a protected ForgeWeb root", path);
  return path;
}

function dependencyMap(value: unknown, name: string): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Generated package.json has invalid ${name}`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, version]) => typeof version !== "string")) throw new TypeError(`Generated package.json has invalid ${name}`);
  return Object.fromEntries(entries.map(([dependency, version]) => [dependency, version as string]).sort(([left], [right]) => left.localeCompare(right)));
}

function backendManifest(backend: BackendSlice): BackendManifest {
  return {
    modules: backend.modules.map((module) => ({ name: module.name, entity: module.entity, crud: module.crud, endpoints: module.endpoints })),
    routes: backend.routes.map((route) => ({ method: route.method, path: route.path, implemented: route.status === "implemented", auth: route.auth })),
  };
}

function requirementsForFeature(backend: BackendSlice, feature: string, entity: string | null): readonly string[] {
  return [...new Set(backend.routes.filter((route) => route.feature === feature || (entity !== null && route.entity === entity)).flatMap((route) => route.requirementIds))].sort();
}

function canonicalCalls(request: GenerationRequest, backend: BackendSlice, project: GeneratedFrontend): FrontendSlice["api"]["generatedCalls"] {
  const calls: { method: string; path: string; feature: string; requirementIds: readonly string[] }[] = [];
  for (const page of project.pages.filter((page) => page.kind === "entity-list" && page.implemented && page.entity)) {
    const routes = backend.routes.filter((route) => route.status === "implemented" && (route.feature === page.name || route.entity === page.entity));
    const root = routes.find((route) => route.method === "GET" && !route.path.includes(":id"))?.path;
    if (!root) throw new TypeError(`Implemented frontend page has no backend collection route: ${page.name}`);
    const expected = [["GET", root], ["GET", `${root}/:id`], ["POST", root], ["PUT", `${root}/:id`], ["DELETE", `${root}/:id`]] as const;
    const semantic = upstreamRequirements(request).semantics?.design?.entities.find(entity => entity.name === page.entity);
    const operations = crudOperations(semantic);
    for (const [method, path] of expected) {
      if (!operations.includes(operationForMethod(method))) continue;
      const route = routes.find((candidate) => candidate.method === method && candidate.path === path);
      if (!route) throw new TypeError(`Implemented frontend page lacks backend capability: ${method} ${path}`);
      calls.push({ method, path, feature: route.feature, requirementIds: [...route.requirementIds] });
    }
  }
  if (project.pages.some((page) => page.kind === "auth")) {
    for (const path of ["/api/v1/auth/login", "/api/v1/auth/register"]) {
      const route = backend.routes.find((candidate) => candidate.status === "implemented" && candidate.method === "POST" && candidate.path === path);
      if (!route) throw new TypeError(`Authentication page lacks backend capability: POST ${path}`);
      calls.push({ method: "POST", path, feature: route.feature, requirementIds: [...route.requirementIds] });
    }
  }
  return calls.sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
}

function buildSlice(request: GenerationRequest, backend: BackendSlice, project: GeneratedFrontend): FrontendSlice {
  if (!project || !Array.isArray(project.files) || !Array.isArray(project.pages) || !Array.isArray(project.routes)
    || !Array.isArray(project.components) || !Array.isArray(project.stores) || typeof project.meta?.generator !== "string") {
    throw new TypeError("Frontend emitter returned a malformed project");
  }
  const rawPaths = new Set<string>();
  const pageRequirements = new Map(project.pages.map((page) => [page.name, requirementsForFeature(backend, page.name, page.entity)]));
  const requirementIdsForPath = (path: string): readonly string[] => {
    const page = project.pages.find((candidate) => candidate.files.includes(path)
      || (candidate.entity !== null && path.startsWith(`src/features/${candidate.route.replace(/^\//, "")}/`)));
    return page ? (pageRequirements.get(page.name) ?? []) : [];
  };
  const files: FrontendSliceFile[] = project.files.map((file) => {
    if (!file || typeof file.content !== "string" || typeof file.language !== "string") throw new TypeError("Frontend emitter returned a malformed file");
    const rawPath = checkedRawPath(file.path);
    const key = rawPath.toLowerCase();
    if (rawPaths.has(key)) throw new FrontendSliceValidationError("DUPLICATE_PATH", "Generated project contains duplicate or case-colliding paths", rawPath);
    rawPaths.add(key);
    const requirementIds = requirementIdsForPath(rawPath);
    return { path: `frontend/${rawPath}`, content: file.content, bytes: Buffer.byteLength(file.content), digest: digest(file.content), language: file.language, requirementIds };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const packageFile = files.find((file) => file.path === "frontend/package.json");
  if (!packageFile) throw new TypeError("Frontend emitter did not return package.json");
  const packageJson = JSON.parse(packageFile.content) as Record<string, unknown>;
  const pages = project.pages.map((page) => ({
    name: page.name, route: page.route, kind: page.kind, entity: page.entity,
    status: page.implemented ? "implemented" as const : "unavailable" as const,
    ...(!page.implemented && page.kind === "entity-list" ? { unavailableReason: "backend-capability-unavailable" as const } : {}),
    files: page.files.map((path) => `frontend/${path}`).sort(), requirementIds: [...(pageRequirements.get(page.name) ?? [])],
  })).sort((left, right) => `${left.route}:${left.name}`.localeCompare(`${right.route}:${right.name}`));
  const components = project.components.map((component) => {
    const page = project.pages.find((candidate) => component.file.includes(`/features/${candidate.route.replace(/^\//, "")}/`) || candidate.files.includes(component.file));
    return { ...component, file: `frontend/${component.file}`, requirementIds: page ? [...(pageRequirements.get(page.name) ?? [])] : [] };
  }).sort((left, right) => left.file.localeCompare(right.file));
  const routes = project.routes.map((route) => ({ ...route, requirementIds: [...(pageRequirements.get(route.page) ?? [])] }))
    .sort((left, right) => `${left.path}:${left.page}`.localeCompare(`${right.path}:${right.page}`));
  const stores = project.stores.map((store) => ({ ...store, file: `frontend/${store.file}`, sensitive: store.name === "auth", requirementIds: store.name === "auth" ? requirementsForFeature(backend, "Authentication", null) : [] }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const generatedCalls = canonicalCalls(request, backend, project);
  const availableRoutes = backend.routes.filter((route) => route.status === "implemented").map((route) => ({ method: route.method, path: route.path, feature: route.feature, requirementIds: [...route.requirementIds] }));
  const unavailableRoutes = backend.routes.filter((route) => route.status === "stub").map((route) => ({ method: route.method, path: route.path, feature: route.feature, requirementIds: [...route.requirementIds] }));
  const tracedFiles = files.filter((file) => file.requirementIds.length).map((file) => ({ path: file.path, requirementIds: file.requirementIds }));
  const sliceWithoutOutput: FrontendSlice = {
    contractVersion: FRONTEND_SLICE_CONTRACT_VERSION,
    projectId: request.scope.projectId, buildId: request.scope.buildId, approvedPlanId: request.approved.planId, bindingDigest: request.approved.bindingDigest,
    files, pages, routes, components, stores,
    api: {
      backendSliceDigest: backend.determinism.outputDigest,
      availableRoutes: availableRoutes.sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`)),
      unavailableRoutes: unavailableRoutes.sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`)),
      generatedCalls,
    },
    dependencies: { runtime: dependencyMap(packageJson.dependencies, "dependencies"), development: dependencyMap(packageJson.devDependencies, "devDependencies") },
    traceability: {
      files: tracedFiles,
      pages: pages.map((page) => ({ name: page.name, route: page.route, requirementIds: page.requirementIds })),
      components: components.map((component) => ({ name: component.name, file: component.file, requirementIds: component.requirementIds })),
      untracedFiles: files.filter((file) => !file.requirementIds.length).map((file) => ({ path: file.path, reason: "shared-infrastructure" as const })),
    },
    provenance: { engine: ENGINE, upstream: { project: "NexArch", revision: NEXARCH_FRONTEND_REVISION, generator: project.meta.generator }, approvedSpecificationId: request.approved.specification.id, approvedSpecificationDigest: request.approved.digest, planDigest: request.approved.planDigest, baseManifestDigest: request.base.manifestDigest },
    target: { frontendProfile: FRONTEND_TARGET_PROFILE, databaseDialect: "postgresql", databaseProvider: "postgresql", databaseProfile: APPLICATION_TARGET.profile },
    determinism: { inputDigest: frontendInputDigest(request, backend), outputDigest: "", normalized: true },
  };
  return { ...sliceWithoutOutput, determinism: { ...sliceWithoutOutput.determinism, outputDigest: frontendOutputDigest(sliceWithoutOutput) } };
}

export class NexArchFrontendAdapter implements FrontendGenerationService {
  private readonly emitter: FrontendEmitter;
  constructor(emitter: FrontendEmitter = upstreamGenerateFrontend) { this.emitter = emitter; }

  async generate(input: GenerationRequest, backendInput: BackendSlice): Promise<EngineResult<FrontendSlice>> {
    let request: GenerationRequest;
    let backend: BackendSlice;
    try {
      request = prepareGenerationRequest(input);
      backend = prepareBackendSlice(backendInput, request);
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Invalid frontend generation input", "INVALID_GENERATION_INPUT");
    }
    try {
      const database = upstreamDatabase(request);
      const requirements = upstreamRequirements(request);
      const architecture = upstreamArchitecture(request, database);
      const openapi = generateOpenApi(architecture, database);
      const metadata = generateEntityMetadata(database, requirements);
      const generated = this.emitter(architecture, requirements, database, openapi, backendManifest(backend), metadata);
      return success(prepareFrontendSlice(buildSlice(request, backend, generated), request, backend));
    } catch (error) {
      if (error instanceof FrontendSliceValidationError) {
        const code: EngineFailureCode = error.diagnosticCode.includes("PATH") || error.diagnosticCode === "INSECURE_STATE" ? "security_failure" : "generation_failure";
        return failure(code, error.message, error.diagnosticCode, error.message, error.path);
      }
      return failure("generation_failure", "Frontend generator failed", error instanceof SyntaxError ? "MALFORMED_GENERATED_PACKAGE" : "UPSTREAM_GENERATION_FAILED", error instanceof Error ? error.message : "Unknown upstream failure");
    }
  }
}
