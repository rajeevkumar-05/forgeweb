import { digest, safePath } from "../../lib.ts";
import type { BackendGenerationService, BackendRouteManifestEntry, BackendSlice, BackendSliceFile } from "../backend.ts";
import { BACKEND_SLICE_CONTRACT_VERSION, BackendSliceValidationError, backendInputDigest, backendOutputDigest, prepareBackendSlice } from "../backend.ts";
import { prepareGenerationRequest } from "../contract.ts";
import type { DatabaseDesign as ForgeDatabaseDesign, DatabaseReferentialAction, EngineFailureCode, EngineMetadata, EngineResult, GenerationRequest } from "../engine.ts";
import { APPLICATION_TARGET, databaseTargetContract, resolveDatabaseTarget } from "../targets.ts";
import { generateBackend as upstreamGenerateBackend } from "./upstream/modules/backend-generator/backend-generator.service.ts";
import type { GeneratedProject } from "./upstream/modules/backend-generator/backend-generator.types.ts";
import { generateEntityMetadata } from "./upstream/modules/database-designer/lib/entity-metadata-generator.ts";
import { generateOpenApi } from "./upstream/modules/database-designer/lib/openapi-generator.ts";
import { generatePrismaSchema } from "./upstream/modules/database-designer/lib/prisma-generator.ts";
import { generateValidationRules } from "./upstream/modules/database-designer/lib/validation-generator.ts";
import type { ArchitectureDecision, ArchitecturePlan, ApiModulePlan } from "./upstream/shared/types/architecture.ts";
import type { DatabaseDesign } from "./upstream/shared/types/design.ts";
import type { RequirementSemantics, RequirementSpec } from "./upstream/shared/types/requirement.ts";
import { camelCase, kebabCase, pascalCase } from "./upstream/shared/utils/strings.ts";

export const NEXARCH_BACKEND_REVISION = "398f4cbd9e314954eda95540411ed4d06cd50cf3";
const ENGINE: EngineMetadata = { name: "forgeweb-nexarch-backend", version: "1", contractVersion: "forgeweb-generation-v1" };
const REFERENTIAL_ACTIONS = new Set<DatabaseReferentialAction>(["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"]);
const PROTECTED_ROOTS = new Set([".git", ".github", "docs", "node_modules", "server", "dist", "dist-server"]);

export type BackendEmitter = typeof upstreamGenerateBackend;

function success(value: BackendSlice): EngineResult<BackendSlice> {
  return { ok: true, value, engine: ENGINE };
}

function failure(code: EngineFailureCode, message: string, diagnosticCode: string, diagnosticMessage = message, path?: string): EngineResult<BackendSlice> {
  return { ok: false, engine: ENGINE, error: { code, stage: "backend-generation", message, retryable: false, diagnostics: [{ code: diagnosticCode, message: diagnosticMessage, ...(path ? { path } : {}) }] } };
}

function asReferentialAction(value: string | undefined, fallback: DatabaseReferentialAction): DatabaseReferentialAction {
  const result = value ?? fallback;
  if (!REFERENTIAL_ACTIONS.has(result as DatabaseReferentialAction)) throw new TypeError(`Unsupported referential action: ${result}`);
  return result as DatabaseReferentialAction;
}

export function upstreamDatabase(request: GenerationRequest): DatabaseDesign {
  const source = request.design.database;
  if (!source) throw new TypeError("Approved PostgreSQL database design is required");
  const target = resolveDatabaseTarget(source.target.dialect, source.target.profile);
  if (target.dialect !== "postgresql" || JSON.stringify(source.target) !== JSON.stringify(databaseTargetContract(target))) {
    throw new TypeError("Database design does not match the verified PostgreSQL target");
  }
  const tables = source.entities.map((entity) => ({
    ...(entity.semantic ? { semantic: structuredClone(entity.semantic) as DatabaseDesign["tables"][number]["semantic"] } : {}),
    entity: entity.name,
    tableName: entity.tableName ?? "",
    primaryKey: entity.primaryKey ?? "",
    softDelete: Boolean(entity.softDelete),
    description: `${entity.name} persistence model.`,
    columns: entity.fields.map((field) => {
      if (!field.prismaType) throw new TypeError(`Missing Prisma type for ${entity.name}.${field.name}`);
      return {
        name: field.name,
        field: camelCase(field.name),
        sqlType: field.type,
        prismaType: field.prismaType,
        ...(field.prismaNativeType ? { prismaNativeType: field.prismaNativeType } : {}),
        nullable: field.nullable,
        primaryKey: Boolean(field.primaryKey),
        unique: Boolean(field.unique),
        ...(field.references ? { references: {
          table: field.references.table,
          column: field.references.column,
          onDelete: asReferentialAction(field.references.onDelete, "RESTRICT"),
          onUpdate: asReferentialAction(field.references.onUpdate, target.foreignKeys.defaultUpdateAction),
        } } : {}),
        ...(field.defaultExpression ? { defaultExpression: field.defaultExpression } : {}),
        ...(field.onUpdateNow ? { onUpdateNow: true } : {}),
        ...(field.enumValues ? { enumValues: [...field.enumValues] } : {}),
        ...(field.enumDatabaseType ? { enumDatabaseType: field.enumDatabaseType } : {}),
        ...(field.format ? { format: field.format } : {}),
        ...(field.nonNegative ? { nonNegative: true } : {}),
        description: field.description ?? `${field.name} field.`,
      };
    }),
    indexes: (entity.indexes ?? []).map((index) => ({ ...index, columns: [...index.columns], rationale: `Approved index ${index.name}.` })),
  }));
  return {
    ...(source.semantics ? { semantics: structuredClone(source.semantics) as RequirementSemantics } : {}),
    meta: {
      projectName: request.approved.specification.productName,
      projectType: request.approved.specification.projectType ?? source.semantics?.design?.projectType ?? "ForgeWeb application",
      engine: target.engine,
      databaseVersion: source.metadata?.version ?? target.version,
      normalForm: source.metadata?.normalForm ?? "3NF",
      generatedAt: request.approved.specification.confirmedAt,
      generator: `forgeweb-nexarch-adapter/${ENGINE.version}`,
    },
    target,
    enums: (source.metadata?.enums ?? []).map((item) => ({ name: item.name, values: [...item.values], ...(item.databaseName ? { databaseName: item.databaseName } : {}) })),
    tables,
    relationships: source.relationships.map((relation, index) => ({
      name: `${relation.from}_${relation.foreignKey ?? index}_${relation.to}`,
      cardinality: (relation.kind === "one-to-one" ? "one-to-one" : "many-to-one") as "one-to-one" | "many-to-one",
      parent: relation.to,
      child: relation.from,
      foreignKey: relation.foreignKey ?? "",
      onDelete: asReferentialAction(relation.onDelete, "RESTRICT"),
      onUpdate: asReferentialAction(relation.onUpdate, target.foreignKeys.defaultUpdateAction),
      description: `${relation.from} references ${relation.to}.`,
    })),
    optimization: { indexes: [], cachingCandidates: [], partitioningCandidates: [], queryGuidelines: [] },
  };
}

function endpointModule(path: string, candidates: readonly string[]): string {
  const segment = path.split("/").filter(Boolean)[0] ?? "api";
  if (segment === "auth") return "Authentication";
  const normalized = segment.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const matched = candidates.find((candidate) => {
    const name = kebabCase(candidate).replace(/-/g, "");
    return name === normalized || name.replace(/s$/, "") === normalized.replace(/s$/, "");
  });
  return matched ?? pascalCase(segment);
}

function apiModules(request: GenerationRequest): ApiModulePlan[] {
  const architecture = request.design.architecture;
  const candidates = [...new Set([...(architecture.structure?.services.map((service) => service.module) ?? []), ...architecture.projection.backend.modules])];
  const modules = new Map<string, ApiModulePlan>();
  for (const endpoint of architecture.endpoints) {
    const module = endpoint.module ?? endpointModule(endpoint.path, candidates);
    const basePath = `/${endpoint.path.split("/").filter(Boolean)[0] ?? kebabCase(module)}`;
    const entry = modules.get(module) ?? { module, basePath, ...(endpoint.entity ? { entity: endpoint.entity } : {}), endpoints: [] };
    entry.endpoints.push({
      method: endpoint.method.toUpperCase() as ApiModulePlan["endpoints"][number]["method"],
      path: endpoint.path,
      description: endpoint.description ?? `${endpoint.method.toUpperCase()} ${endpoint.path}`,
      auth: endpoint.auth === true,
      ...(endpoint.roles?.length ? { roles: [...endpoint.roles] } : {}),
    });
    modules.set(module, entry);
  }
  return [...modules.values()].map((module) => ({ ...module, endpoints: [...module.endpoints].sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`)) }))
    .sort((left, right) => left.module.localeCompare(right.module));
}

function decision(choice: string): ArchitectureDecision {
  return { choice, reasoning: "Approved by the ForgeWeb planning boundary.", alternatives: [] };
}

export function upstreamArchitecture(request: GenerationRequest, database: DatabaseDesign): ArchitecturePlan {
  const source = request.design.architecture;
  const modules = apiModules(request);
  return {
    ...(source.semantics ? { semantics: structuredClone(source.semantics) as RequirementSemantics } : {}),
    meta: { projectName: request.approved.specification.productName, projectType: request.approved.specification.projectType ?? source.semantics?.design?.projectType ?? "ForgeWeb application", generatedAt: request.approved.specification.confirmedAt, planner: "forgeweb-nexarch-adapter" },
    decisions: {
      architecture: decision(source.projection.systemShape), frontendArchitecture: decision(source.projection.frontend.framework),
      backendArchitecture: decision(source.projection.backend.runtime), database: decision(database.target.engine),
      authentication: decision(source.projection.security.join("; ") || "No authentication capability approved"),
    },
    folderStructure: [], apiModules: modules,
    frontend: { pages: [], layouts: [], navigation: [], dashboardWidgets: [], reusableComponents: [] },
    database: { engine: database.target.engine, entities: database.tables.map((table) => ({ name: table.entity, tableName: table.tableName, primaryKey: table.primaryKey, keyFields: table.columns.map((column) => column.name), relations: [], indexes: table.indexes.map((index) => index.name) })), normalization: [database.meta.normalForm] },
    services: (source.structure?.services ?? []).map((service) => ({ ...service, dtos: [...service.dtos], validators: [...service.validators] })),
    middleware: (source.structure?.middleware ?? []).map((item) => ({ ...item })),
    security: { authentication: [], sessionStrategy: "Not asserted by backend generation", authorization: "Preserve approved route metadata", passwordPolicy: [], rateLimiting: [], validation: "Generated from database design", headers: [], cors: "Runtime configuration required" },
    dependencyGraph: { nodes: [], edges: [] }, futureScalability: [],
    nonFunctional: { performance: { score: 1, notes: "Not evaluated" }, maintainability: { score: 1, notes: "Not evaluated" }, security: { score: 1, notes: "Not evaluated" }, scalability: { score: 1, notes: "Not evaluated" }, availability: { score: 1, notes: "Not evaluated" }, reliability: { score: 1, notes: "Not evaluated" } },
  };
}

export function upstreamRequirements(request: GenerationRequest): RequirementSpec {
  const specification = request.approved.specification;
  const semantics = specification.semantics ?? request.design.architecture.semantics;
  return {
    ...(semantics ? { semantics: structuredClone(semantics) as RequirementSemantics } : {}),
    ...(specification.constraints ? { constraints: [...specification.constraints] } : {}),
    projectName: specification.productName, projectType: specification.projectType ?? semantics?.design?.projectType ?? "ForgeWeb application", roles: [...specification.roles],
    modules: [...request.design.architecture.projection.backend.modules], frontend: [], backend: [request.design.architecture.projection.backend.runtime],
    database: [...specification.entities], authentication: [...(specification.authentication ?? [])], integrations: [...(specification.integrations ?? [])], missingRequirements: [...specification.assumptions],
    goal: specification.summary, functionalRequirements: specification.requirements.map((requirement) => requirement.description),
    acceptanceCriteria: specification.requirements.flatMap((requirement) => requirement.acceptanceCriteria), assumptions: [...specification.assumptions],
  };
}

function checkedRawPath(path: unknown): string {
  if (typeof path !== "string" || !path || path.includes("\\") || path.includes(":") || /^[/\\]/.test(path) || /^[a-zA-Z]:/.test(path)) {
    throw new BackendSliceValidationError("INVALID_PATH", "Generated path must be relative and normalized", typeof path === "string" ? path : undefined);
  }
  if (path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BackendSliceValidationError("INVALID_PATH", "Generated path contains traversal or invalid segments", path);
  }
  try {
    if (path !== safePath(path)) throw new Error("not normalized");
  } catch {
    throw new BackendSliceValidationError("INVALID_PATH", "Generated path contains traversal or invalid segments", path);
  }
  const root = path.split("/")[0]?.toLowerCase();
  if (!root || root === "backend" || PROTECTED_ROOTS.has(root)) throw new BackendSliceValidationError("PROTECTED_PATH", "Generated path targets a protected ForgeWeb root", path);
  return path;
}

function requirementMap(request: GenerationRequest, project: GeneratedProject): Map<string, readonly string[]> {
  const endpointByKey = new Map(request.design.architecture.endpoints.map((endpoint) => [`${endpoint.method.toUpperCase()} ${endpoint.path.replace(/\{([^}]+)\}/g, ":$1")}`, endpoint.requirementIds]));
  return new Map(project.routes.map((route) => {
    const sourcePath = route.path.replace(/^\/api\/v1/, "") || "/";
    return [`${route.method.toUpperCase()} ${route.path}`, endpointByKey.get(`${route.method.toUpperCase()} ${sourcePath}`) ?? []];
  }));
}

function dependencyMap(value: unknown, name: string): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Generated package.json has invalid ${name}`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, version]) => typeof version !== "string")) throw new TypeError(`Generated package.json has invalid ${name}`);
  return Object.fromEntries(entries.map(([dependency, version]) => [dependency, version as string]).sort(([left], [right]) => left.localeCompare(right)));
}

function buildSlice(request: GenerationRequest, project: GeneratedProject, database: DatabaseDesign): BackendSlice {
  if (!project || !Array.isArray(project.files) || !Array.isArray(project.routes) || !Array.isArray(project.modules) || typeof project.meta?.generator !== "string") {
    throw new TypeError("Backend emitter returned a malformed project");
  }
  const rawPaths = new Set<string>();
  const routeRequirements = requirementMap(request, project);
  const moduleRequirements = new Map(project.modules.map((module) => [module.name, [...new Set(project.routes.filter((route) => route.handler.startsWith(`${module.name}Controller.`)).flatMap((route) => routeRequirements.get(`${route.method.toUpperCase()} ${route.path}`) ?? []))].sort()]));
  const files: BackendSliceFile[] = project.files.map((file) => {
    if (!file || typeof file.content !== "string" || typeof file.language !== "string") throw new TypeError("Backend emitter returned a malformed file");
    const rawPath = checkedRawPath(file.path);
    const key = rawPath.toLowerCase();
    if (rawPaths.has(key)) throw new BackendSliceValidationError("DUPLICATE_PATH", "Generated project contains duplicate or case-colliding paths", rawPath);
    rawPaths.add(key);
    const module = project.modules.find((candidate) => candidate.files.includes(rawPath));
    const requirementIds = module ? (moduleRequirements.get(module.name) ?? []) : [];
    return { path: `backend/${rawPath}`, content: file.content, bytes: Buffer.byteLength(file.content), digest: digest(file.content), language: file.language, requirementIds };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const packageFile = files.find((file) => file.path === "backend/package.json");
  if (!packageFile) throw new TypeError("Backend emitter did not return package.json");
  const packageJson = JSON.parse(packageFile.content) as Record<string, unknown>;
  const routes: BackendRouteManifestEntry[] = project.routes.map((route) => {
    const module = project.modules.find((candidate) => route.handler.startsWith(`${candidate.name}Controller.`));
    const sourcePath = route.path.replace(/^\/api\/v1/, "") || "/";
    const source = request.design.architecture.endpoints.find((endpoint) => endpoint.method.toUpperCase() === route.method.toUpperCase() && endpoint.path.replace(/\{([^}]+)\}/g, ":$1") === sourcePath);
    return {
      method: route.method.toUpperCase(), path: route.path, handler: route.handler, status: route.implemented ? "implemented" as const : "stub" as const,
      auth: route.auth, roles: source?.roles ? [...source.roles].sort() : [], feature: module?.name ?? "Unknown", entity: module?.entity ?? null,
      requirementIds: [...(source?.requirementIds ?? [])].sort(),
    };
  }).sort((left, right) => `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));

  const traceFiles = files.filter((file) => file.requirementIds.length).map((file) => ({ path: file.path, requirementIds: file.requirementIds }));
  const sliceWithoutOutput: BackendSlice = {
    contractVersion: BACKEND_SLICE_CONTRACT_VERSION,
    projectId: request.scope.projectId, buildId: request.scope.buildId, approvedPlanId: request.approved.planId, bindingDigest: request.approved.bindingDigest,
    files,
    modules: project.modules.map((module) => ({ ...module, files: module.files.map((path) => `backend/${path}`).sort() })).sort((left, right) => left.name.localeCompare(right.name)),
    routes,
    entities: database.tables.map((table) => ({ name: table.entity, tableName: table.tableName, fields: table.columns.map((column) => column.name), softDelete: table.softDelete })).sort((left, right) => left.name.localeCompare(right.name)),
    capabilities: { api: "rest", totalRoutes: routes.length, implementedRoutes: routes.filter((route) => route.status === "implemented").length, stubRoutes: routes.filter((route) => route.status === "stub").length, authenticatedRoutes: routes.filter((route) => route.auth).length },
    dependencies: { runtime: dependencyMap(packageJson.dependencies, "dependencies"), development: dependencyMap(packageJson.devDependencies, "devDependencies") },
    traceability: {
      files: traceFiles,
      routes: routes.map((route) => ({ method: route.method, path: route.path, requirementIds: route.requirementIds, status: route.status })),
      untracedFiles: files.filter((file) => !file.requirementIds.length).map((file) => ({ path: file.path, reason: "shared-infrastructure" as const })),
    },
    provenance: { engine: ENGINE, upstream: { project: "NexArch", revision: NEXARCH_BACKEND_REVISION, generator: project.meta.generator }, approvedSpecificationId: request.approved.specification.id, approvedSpecificationDigest: request.approved.digest, planDigest: request.approved.planDigest, baseManifestDigest: request.base.manifestDigest },
    database: { dialect: "postgresql", provider: "postgresql", profile: APPLICATION_TARGET.profile, target: databaseTargetContract(APPLICATION_TARGET) },
    determinism: { inputDigest: backendInputDigest(request), outputDigest: "", normalized: true },
  };
  return { ...sliceWithoutOutput, determinism: { ...sliceWithoutOutput.determinism, outputDigest: backendOutputDigest(sliceWithoutOutput) } };
}

export class NexArchBackendAdapter implements BackendGenerationService {
  private readonly emitter: BackendEmitter;
  constructor(emitter: BackendEmitter = upstreamGenerateBackend) { this.emitter = emitter; }

  async generate(input: GenerationRequest): Promise<EngineResult<BackendSlice>> {
    let request: GenerationRequest;
    try {
      request = prepareGenerationRequest(input);
    } catch (error) {
      return failure("validation_failure", error instanceof Error ? error.message : "Invalid generation request", "INVALID_GENERATION_REQUEST");
    }
    try {
      const database = upstreamDatabase(request);
      const requirements = upstreamRequirements(request);
      const architecture = upstreamArchitecture(request, database);
      const prisma = generatePrismaSchema(database);
      const openapi = generateOpenApi(architecture, database);
      const validation = generateValidationRules(database);
      const metadata = generateEntityMetadata(database, requirements);
      const generated = this.emitter(architecture, requirements, database, prisma, openapi, validation.entities, metadata);
      return success(prepareBackendSlice(buildSlice(request, generated, database), request));
    } catch (error) {
      if (error instanceof BackendSliceValidationError) {
        const code: EngineFailureCode = error.diagnosticCode.includes("PATH") ? "security_failure" : "generation_failure";
        return failure(code, error.message, error.diagnosticCode, error.message, error.path);
      }
      return failure("generation_failure", "Backend generator failed", error instanceof SyntaxError ? "MALFORMED_GENERATED_PACKAGE" : "UPSTREAM_GENERATION_FAILED", error instanceof Error ? error.message : "Unknown upstream failure");
    }
  }
}
