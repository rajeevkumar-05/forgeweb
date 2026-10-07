import { digest } from "../../lib.ts";
import { fileManifestDigest } from "../contract.ts";
import type {
  ArchitectureDraft, ArchitectureRequest, DatabaseDesign, DatabaseRequest, EngineFailureCode,
  EngineMetadata, EngineResult, GenerationEngine, PlanningFolder, PlanningRequest, RequirementsAnalysis,
} from "../engine.ts";
import type { RequirementSemantics, RequirementSpec } from "./upstream/shared/types/requirement.ts";
import type { ArchitecturePlan as NexArchitecturePlan } from "./upstream/shared/types/architecture.ts";
import { analyzeRequirements, designDatabase, planArchitecture } from "./upstream/planning.ts";
import { databaseTargetContract, MYSQL_PLANNING_PROFILE, POSTGRESQL_APPLICATION_PROFILE, resolveDatabaseTarget } from "../targets.ts";
import { planDatabase } from "./upstream/modules/architecture/lib/database-planner.ts";
import { semanticDesign } from "./semantic-design.ts";

export const NEXARCH_PLANNING_PROFILE = MYSQL_PLANNING_PROFILE;
export const NEXARCH_POSTGRESQL_PLANNING_PROFILE = POSTGRESQL_APPLICATION_PROFILE;
const ENGINE: EngineMetadata = { name: "nexarch-planning", version: "398f4cbd9e314954eda95540411ed4d06cd50cf3", contractVersion: "forgeweb-generation-v1" };

export class PlanningProviderError extends Error {}

export type PlanningBackend = {
  analyzeRequirements: typeof analyzeRequirements;
  planArchitecture: typeof planArchitecture;
  designDatabase: typeof designDatabase;
};

const DEFAULT_BACKEND: PlanningBackend = { analyzeRequirements, planArchitecture, designDatabase };

function success<T>(value: T): EngineResult<T> { return { ok: true, value, engine: ENGINE }; }
function failure<T>(code: EngineFailureCode, stage: string, message: string, retryable = false): EngineResult<T> {
  return { ok: false, error: { code, stage, message, retryable }, engine: ENGINE };
}

function validRequest(request: PlanningRequest): string | null {
  if (!request.scope?.projectId || !request.scope.buildId || !request.scope.operationId) return "ForgeWeb operation identity is required";
  if (!request.scope.actor?.subjectId || !["local", "authenticated"].includes(request.scope.actor.kind)
    || (request.scope.actor.kind === "authenticated" && !request.scope.actor.ownerId)
    || (request.scope.actor.kind === "local" && request.scope.actor.ownerId !== null)) return "Server-derived actor context is required";
  if (request.base?.projectId !== request.scope.projectId) return "Base version belongs to another project";
  if (request.base.kind === "empty" && request.base.files.length) return "Empty base cannot contain files";
  if (request.base.kind === "version" && !request.base.versionId) return "Base version identity is required";
  if (request.base.manifestDigest !== fileManifestDigest(request.base.files)) return "Base manifest digest mismatch";
  try {
    resolveDatabaseTarget(request.databaseDialect, request.options?.targetProfile);
  } catch (error) {
    return error instanceof Error ? error.message : "An explicit supported database target is required";
  }
  if (typeof request.prompt !== "string" || request.prompt.trim().length < 12 || request.prompt.length > 20_000) return "Prompt must be 12 to 20,000 characters";
  return null;
}

function contextFor(request: PlanningRequest) {
  return { projectId: request.scope.projectId, buildId: request.scope.buildId, operationId: request.scope.operationId, subjectId: request.scope.actor.subjectId, ownerId: request.scope.actor.ownerId, promptDigest: digest(request.prompt) };
}

function hasContext(request: PlanningRequest, context: RequirementsAnalysis["context"]): boolean {
  return Boolean(context && JSON.stringify(context) === JSON.stringify(contextFor(request)));
}

function specFromAnalysis(analysis: RequirementsAnalysis): RequirementSpec | null {
  const f = analysis.facets;
  if (!f || analysis.questions.length || !f.productName || !f.projectType || !f.modules.length || !f.entities.length) return null;
  return {
    projectName: f.productName, projectType: f.projectType, roles: [...f.roles], modules: [...f.modules],
    frontend: [...f.frontend], backend: [...f.backend], database: [...f.entities],
    authentication: [...f.authentication], integrations: [...f.integrations], missingRequirements: [...f.missingRequirements],
    functionalRequirements: f.functionalRequirements && [...f.functionalRequirements],
    constraints: f.constraints && [...f.constraints],
    semantics: f.semantics && structuredClone(f.semantics) as RequirementSemantics | undefined,
  };
}

function adaptArchitecture(plan: NexArchitecturePlan, markdown: string, analysis: RequirementsAnalysis): ArchitectureDraft {
  const adaptFolder = (folder: NexArchitecturePlan["folderStructure"][number]): PlanningFolder => ({ name: folder.name, type: folder.type, children: folder.children?.map(adaptFolder) });
  const requirementIds = new Map(analysis.proposedRequirements.map((requirement, index) => [requirement.title.replace(/^Manage /, ""), `REQ-${String(index + 1).padStart(3, "0")}`]));
  const apiEndpoints = plan.apiModules.flatMap((module) => module.endpoints.map((endpoint) => ({
    method: endpoint.method, path: endpoint.path, description: endpoint.description, auth: endpoint.auth,
    module: module.module, ...(module.entity ? { entity: module.entity } : {}),
    roles: endpoint.roles ? [...endpoint.roles] : [],
    requirementIds: [requirementIds.get(module.module === "Auth" ? "Authentication" : module.module)].filter((id): id is string => Boolean(id)),
  })));
  return {
    ...(plan.semantics ? { semantics: structuredClone(plan.semantics) } : {}),
    context: analysis.context,
    projection: {
      systemShape: plan.decisions.architecture.choice,
      frontend: { framework: plan.decisions.frontendArchitecture.choice, pages: plan.frontend.pages.map((page) => page.name), components: [...plan.frontend.reusableComponents], motion: [] },
      backend: { runtime: plan.decisions.backendArchitecture.choice, modules: plan.services.map((service) => service.module), apiStyle: "REST", jobs: [] },
      data: { database: plan.database.engine, entities: plan.database.entities.map((entity) => entity.name), rules: [...plan.database.normalization] },
      security: [...plan.security.authentication, plan.security.authorization, ...plan.security.rateLimiting],
      delivery: plan.futureScalability.map((item) => `${item.concern}: ${item.recommendation}`),
      diagram: "", markdown, capabilities: [],
    },
    endpoints: apiEndpoints,
    structure: {
      folders: plan.folderStructure.map(adaptFolder),
      pages: plan.frontend.pages.map((page) => ({ name: page.name, route: page.route, access: [...page.access] })),
      services: plan.services.map((service) => ({ module: service.module, controller: service.controller, service: service.service, repository: service.repository, dtos: [...service.dtos], validators: [...service.validators] })),
      middleware: plan.middleware.map((item) => ({ name: item.name, purpose: item.purpose })),
      entities: plan.database.entities.map((entity) => ({ name: entity.name, tableName: entity.tableName, primaryKey: entity.primaryKey, fields: [...entity.keyFields], relations: entity.relations.map((relation) => ({ target: relation.target, foreignKey: relation.foreignKey, kind: relation.type })), indexes: [...entity.indexes] })),
      dependencies: plan.dependencyGraph.edges.map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason })),
      decisions: Object.entries(plan.decisions).map(([area, decision]) => ({ area, choice: decision.choice, reasoning: decision.reasoning })),
    },
  };
}

function adaptDatabase(design: ReturnType<PlanningBackend["designDatabase"]>): DatabaseDesign {
  return {
    ...(design.semantics ? { semantics: structuredClone(design.semantics) } : {}),
    dialect: design.meta.engine,
    target: databaseTargetContract(design.target),
    entities: design.tables.map((table) => ({
      name: table.entity, tableName: table.tableName, primaryKey: table.primaryKey,
      ...(table.semantic ? { semantic: structuredClone(table.semantic) } : {}),
      fields: table.columns.map((column) => ({ name: column.name, type: column.sqlType, prismaType: column.prismaType, prismaNativeType: column.prismaNativeType, nullable: column.nullable, primaryKey: column.primaryKey, unique: column.unique, defaultExpression: column.defaultExpression, onUpdateNow: column.onUpdateNow, references: column.references && { ...column.references }, enumValues: column.enumValues && [...column.enumValues], enumDatabaseType: column.enumDatabaseType, nonNegative: column.nonNegative, format: column.format, description: column.description })),
      indexes: table.indexes.map((index) => ({ name: index.name, columns: [...index.columns], unique: index.unique })),
      softDelete: table.softDelete,
    })),
    relationships: design.relationships.map((relation) => ({ from: relation.child, to: relation.parent, kind: relation.cardinality, foreignKey: relation.foreignKey, onDelete: relation.onDelete, onUpdate: relation.onUpdate })),
    metadata: { version: design.meta.databaseVersion, normalForm: design.meta.normalForm, enums: design.enums.map((item) => ({ name: item.name, values: [...item.values], databaseName: item.databaseName })) },
  };
}

function validateDatabaseDesign(design: DatabaseDesign): string | null {
  const names = new Set<string>();
  const tableNames = new Set<string>();
  const maxIdentifierLength = design.target.identifiers.maxLength;
  for (const entity of design.entities) {
    if (!entity.tableName || names.has(entity.name) || tableNames.has(entity.tableName)) return "Database entities must have unique names and table names";
    if (entity.tableName.length > maxIdentifierLength) return `Table identifier exceeds ${maxIdentifierLength} characters in ${entity.name}`;
    names.add(entity.name);
    tableNames.add(entity.tableName);
    const fields = new Set(entity.fields.map((field) => field.name));
    if (entity.fields.some((field) => field.name.length > maxIdentifierLength || (field.enumDatabaseType?.length ?? 0) > maxIdentifierLength)) return `Column identifier exceeds ${maxIdentifierLength} characters in ${entity.name}`;
    if (!entity.primaryKey || !fields.has(entity.primaryKey)) return `Missing primary key in ${entity.name}`;
    for (const index of entity.indexes ?? []) {
      if (!index.columns.length || index.columns.some((column) => !fields.has(column))) return `Invalid index in ${entity.name}`;
      if (index.name.length > maxIdentifierLength) return `Index identifier exceeds ${maxIdentifierLength} characters in ${entity.name}`;
    }
  }
  for (const entity of design.entities) {
    for (const field of entity.fields) {
      if (field.references && !design.entities.some((candidate) => candidate.name === field.references?.table && candidate.fields.some((column) => column.name === field.references?.column))) return `Unknown foreign key target in ${entity.name}`;
    }
  }
  for (const relation of design.relationships) {
    const child = design.entities.find((entity) => entity.name === relation.from);
    if (!child || !names.has(relation.to) || !child.fields.some((field) => field.name === relation.foreignKey)) return "Relationship has no matching foreign key";
  }
  return null;
}

function catchFailure<T>(error: unknown, stage: string): EngineResult<T> {
  if (error instanceof PlanningProviderError) return failure("provider_failure", stage, "Planning provider failed", true);
  return failure("internal_engine_error", stage, "Planning engine failed");
}

export class NexArchPlanningAdapter implements Pick<GenerationEngine, "analyzeRequirements" | "planArchitecture" | "designDatabase"> {
  private readonly backend: PlanningBackend;

  constructor(backend: PlanningBackend = DEFAULT_BACKEND) { this.backend = backend; }

  async analyzeRequirements(request: PlanningRequest): Promise<EngineResult<RequirementsAnalysis>> {
    const invalid = validRequest(request);
    if (invalid) return failure("validation_failure", "analysis", invalid);
    try {
      const result = this.backend.analyzeRequirements(request.prompt);
      if (result.status === "INCOMPLETE") return success({ proposedRequirements: [], questions: [...result.questions], context: contextFor(request) });
      const spec = result.spec;
      const target = resolveDatabaseTarget(request.databaseDialect, request.options.targetProfile);
      const semantics = spec.semantics && { ...structuredClone(spec.semantics), design: semanticDesign(spec, planDatabase(spec, target).entities) };
      const modules = spec.modules.filter(module => !["Dashboard", "Settings"].includes(module));
      return success({
        proposedRequirements: modules.map((module, index) => {
          const actions = spec.semantics?.operations.filter(item => item.modules.includes(module)).map(item => item.action) ?? [];
          const fields = spec.semantics?.fields.filter(item => item.modules.includes(module)).map(item => item.name) ?? [];
          const details = [
            ...actions.map(action => `Users can ${action} ${module.toLowerCase()}.`),
            ...fields.map(field => `${module} includes the requested ${field} field.`),
            // Keep existing module IDs/endpoint traceability; global facts accompany
            // the first requirement rather than inventing unmapped implementation IDs.
            ...(index === 0 ? [
              `Roles: ${spec.roles.join(", ")}.`,
              ...(spec.constraints ?? []),
              ...(spec.functionalRequirements ?? []).filter(item => /^(Integration|Backend capability|Frontend capability):/.test(item)),
            ] : []),
          ];
          return {
            title: `Manage ${module}`,
            description: [`${module} capability for ${spec.projectName}.`, ...details].join(" "),
            acceptanceCriteria: [`Users can manage ${module.toLowerCase()}.`, ...details],
            priority: "P0" as const,
          };
        }),
        questions: [],
        context: contextFor(request),
        facets: { productName: spec.projectName, projectType: spec.projectType, roles: [...spec.roles], modules: [...spec.modules], frontend: [...spec.frontend], backend: [...spec.backend], entities: [...spec.database], authentication: [...spec.authentication], integrations: [...spec.integrations], missingRequirements: [...spec.missingRequirements], functionalRequirements: [...(spec.functionalRequirements ?? [])], constraints: [...(spec.constraints ?? [])], semantics },
      });
    } catch (error) { return catchFailure(error, "analysis"); }
  }

  async planArchitecture(request: ArchitectureRequest): Promise<EngineResult<ArchitectureDraft>> {
    const invalid = validRequest(request);
    if (invalid) return failure("validation_failure", "architecture", invalid);
    if (!hasContext(request, request.analysis.context)) return failure("security_failure", "architecture", "Analysis belongs to another ForgeWeb context");
    const spec = specFromAnalysis(request.analysis);
    if (!spec) return failure("validation_failure", "architecture", "Complete requirement facets are required");
    try {
      const target = resolveDatabaseTarget(request.databaseDialect, request.options.targetProfile);
      const { plan, markdown } = this.backend.planArchitecture(spec, target);
      if (plan.database.engine !== target.engine) return failure("unsupported_capability", "architecture", "Planner database dialect does not match the selected target");
      return success(adaptArchitecture(plan, markdown, request.analysis));
    } catch (error) { return catchFailure(error, "architecture"); }
  }

  async designDatabase(request: DatabaseRequest): Promise<EngineResult<DatabaseDesign>> {
    const invalid = validRequest(request);
    if (invalid) return failure("validation_failure", "database-design", invalid);
    if (!hasContext(request, request.analysis.context) || !hasContext(request, request.architecture.context)) return failure("security_failure", "database-design", "Planning result belongs to another ForgeWeb context");
    const spec = specFromAnalysis(request.analysis);
    if (!spec || !request.architecture.structure) return failure("validation_failure", "database-design", "Complete analysis and architecture are required");
    try {
      const target = resolveDatabaseTarget(request.databaseDialect, request.options.targetProfile);
      const { plan, markdown } = this.backend.planArchitecture(spec, target);
      const expected = adaptArchitecture(plan, markdown, request.analysis);
      if (digest(JSON.stringify(request.architecture.structure)) !== digest(JSON.stringify(expected.structure))
        || digest(JSON.stringify(request.architecture.endpoints)) !== digest(JSON.stringify(expected.endpoints))
        || digest(JSON.stringify(request.architecture.semantics ?? null)) !== digest(JSON.stringify(expected.semantics ?? null))) {
        return failure("validation_failure", "database-design", "Architecture does not match the analyzed requirements");
      }
      if (plan.database.engine !== target.engine) return failure("unsupported_capability", "database-design", "Planner database dialect does not match the selected target");
      const design = this.backend.designDatabase(plan, spec, target);
      if (design.meta.engine !== target.engine || digest(JSON.stringify(design.target)) !== digest(JSON.stringify(target))) {
        return failure("unsupported_capability", "database-design", "Database design does not match the selected target");
      }
      const adapted = adaptDatabase(design);
      const designError = validateDatabaseDesign(adapted);
      if (designError) return failure("validation_failure", "database-design", designError);
      return success(adapted);
    } catch (error) { return catchFailure(error, "database-design"); }
  }
}
