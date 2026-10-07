import type { ArchitecturePlan, MasterSpecification, Requirement } from "../domain.ts";
import type { RequirementSemantics, SemanticEntity } from "./nexarch/upstream/shared/types/requirement.ts";

export type DeepReadonly<T> = T extends (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type EngineActor =
  | { readonly kind: "local"; readonly subjectId: string; readonly ownerId: null }
  | { readonly kind: "authenticated"; readonly subjectId: string; readonly ownerId: string; readonly tenantId?: string };

export type EngineScope = {
  readonly projectId: string;
  readonly buildId: string;
  readonly operationId: string;
  readonly actor: EngineActor;
};

export type EngineFile = {
  readonly path: string;
  readonly content: string;
  readonly digest: string;
  readonly requirementIds: readonly string[];
};

export type BaseSnapshot =
  | { readonly kind: "empty"; readonly projectId: string; readonly manifestDigest: string; readonly files: readonly [] }
  | { readonly kind: "version"; readonly projectId: string; readonly versionId: string; readonly manifestDigest: string; readonly files: readonly EngineFile[] };

export type BaseReference =
  | { readonly kind: "empty"; readonly manifestDigest: string }
  | { readonly kind: "version"; readonly versionId: string; readonly manifestDigest: string };

export type ApprovedSpecification = DeepReadonly<MasterSpecification> & {
  readonly status: "approved";
  readonly confirmedAt: string;
};

export type GenerationOptions = {
  readonly targetProfile: string;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
};

export type EngineMetadata = {
  readonly name: string;
  readonly version: string;
  readonly contractVersion: "forgeweb-generation-v1";
};

export type EngineFailureCode =
  | "validation_failure"
  | "generation_failure"
  | "provider_failure"
  | "unsupported_capability"
  | "security_failure"
  | "dependency_failure"
  | "runner_failure"
  | "internal_engine_error";

export type EngineFailure = {
  readonly code: EngineFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly stage: string;
  readonly diagnostics?: readonly { readonly code: string; readonly message: string; readonly path?: string }[];
};

export type EngineResult<Value> =
  | { readonly ok: true; readonly value: Value; readonly engine: EngineMetadata }
  | { readonly ok: false; readonly error: EngineFailure; readonly engine: EngineMetadata };

export type AnalyzedRequirement = Pick<Requirement, "title" | "description" | "acceptanceCriteria" | "priority">;

export type RequirementsAnalysis = {
  readonly proposedRequirements: readonly DeepReadonly<AnalyzedRequirement>[];
  readonly questions: readonly string[];
  readonly context?: { readonly projectId: string; readonly buildId: string; readonly operationId: string; readonly subjectId: string; readonly ownerId: string | null; readonly promptDigest: string };
  /** ForgeWeb-owned planning facets; present only for a complete analysis. */
  readonly facets?: {
    readonly productName: string;
    readonly projectType: string;
    readonly roles: readonly string[];
    readonly modules: readonly string[];
    readonly frontend: readonly string[];
    readonly backend: readonly string[];
    readonly entities: readonly string[];
    readonly authentication: readonly string[];
    readonly integrations: readonly string[];
    readonly missingRequirements: readonly string[];
    readonly functionalRequirements?: readonly string[];
    readonly constraints?: readonly string[];
    readonly semantics?: DeepReadonly<RequirementSemantics>;
  };
};

export type PlanningFolder = { readonly name: string; readonly type: "directory" | "file"; readonly children?: readonly PlanningFolder[] };

export type ArchitectureDraft = {
  readonly semantics?: DeepReadonly<RequirementSemantics>;
  readonly context?: { readonly projectId: string; readonly buildId: string; readonly operationId: string; readonly subjectId: string; readonly ownerId: string | null; readonly promptDigest: string };
  readonly projection: DeepReadonly<ArchitecturePlan>;
  readonly endpoints: readonly {
    readonly method: string;
    readonly path: string;
    readonly module?: string;
    readonly entity?: string;
    readonly description?: string;
    readonly auth?: boolean;
    readonly roles?: readonly string[];
    readonly requirementIds: readonly string[];
  }[];
  readonly structure?: {
    readonly folders: readonly PlanningFolder[];
    readonly pages: readonly { readonly name: string; readonly route: string; readonly access: readonly string[] }[];
    readonly services: readonly { readonly module: string; readonly controller: string; readonly service: string; readonly repository: string; readonly dtos: readonly string[]; readonly validators: readonly string[] }[];
    readonly middleware: readonly { readonly name: string; readonly purpose: string }[];
    readonly entities: readonly { readonly name: string; readonly tableName: string; readonly primaryKey: string; readonly fields: readonly string[]; readonly relations: readonly { readonly target: string; readonly foreignKey: string; readonly kind: string }[]; readonly indexes: readonly string[] }[];
    readonly dependencies: readonly { readonly from: string; readonly to: string; readonly reason: string }[];
    readonly decisions: readonly { readonly area: string; readonly choice: string; readonly reasoning: string }[];
  };
};

export type DatabaseReferentialAction = "CASCADE" | "RESTRICT" | "SET NULL" | "NO ACTION";

export type DatabaseTargetContract = {
  readonly dialect: "mysql8" | "postgresql";
  readonly profile: string;
  readonly provider: "mysql" | "postgresql";
  readonly connection: { readonly envVar: "DATABASE_URL"; readonly placeholder: string };
  readonly supportedScalarTypes: readonly string[];
  readonly enum: { readonly representation: "inline-native" | "named-native"; readonly identifierStyle: "inline" | "snake_case" };
  readonly uuid: { readonly sqlType: string; readonly sqlDefaultExpression: string; readonly prismaDefaultExpression: string };
  readonly timestamps: { readonly sqlType: string; readonly createdDefaultExpression: string; readonly updatedDefaultExpression?: string; readonly updateBehavior: "prisma-updated-at" };
  readonly defaults: { readonly currentTimestamp: string; readonly booleanTrue: string; readonly booleanFalse: string };
  readonly foreignKeys: { readonly supportedDeleteActions: readonly DatabaseReferentialAction[]; readonly supportedUpdateActions: readonly DatabaseReferentialAction[]; readonly defaultUpdateAction: DatabaseReferentialAction };
  readonly indexes: { readonly foreignKeys: "explicit"; readonly uniqueness: "unique-index"; readonly partialIndexes: boolean };
  readonly identifiers: { readonly quote: "`" | "\""; readonly maxLength: number; readonly unquotedCase: "preserve" | "lowercase"; readonly overflow: "reject" };
  readonly migration: { readonly tool: "prisma-migrate"; readonly strategy: "versioned"; readonly destructiveReset: false };
  readonly prisma: { readonly provider: "mysql" | "postgresql"; readonly datasourceName: "db"; readonly urlExpression: 'env("DATABASE_URL")'; readonly datasource: string };
};

export type DatabaseDesign = {
  readonly semantics?: DeepReadonly<RequirementSemantics>;
  readonly dialect: "MySQL 8" | "PostgreSQL";
  readonly target: DatabaseTargetContract;
  readonly entities: readonly {
    readonly name: string;
    readonly tableName?: string;
    readonly semantic?: DeepReadonly<SemanticEntity>;
    readonly primaryKey?: string;
    readonly fields: readonly { readonly name: string; readonly type: string; readonly prismaType?: string; readonly prismaNativeType?: string; readonly nullable: boolean; readonly primaryKey?: boolean; readonly unique?: boolean; readonly defaultExpression?: string; readonly onUpdateNow?: boolean; readonly references?: { readonly table: string; readonly column: string; readonly onDelete: string; readonly onUpdate: string }; readonly enumValues?: readonly string[]; readonly enumDatabaseType?: string; readonly nonNegative?: boolean; readonly format?: string; readonly description?: string }[];
    readonly indexes?: readonly { readonly name: string; readonly columns: readonly string[]; readonly unique: boolean }[];
    readonly softDelete?: boolean;
  }[];
  readonly relationships: readonly { readonly from: string; readonly to: string; readonly kind: string; readonly foreignKey?: string; readonly onDelete?: string; readonly onUpdate?: string }[];
  readonly metadata?: { readonly version: string; readonly normalForm: string; readonly enums: readonly { readonly name: string; readonly values: readonly string[]; readonly databaseName?: string }[] };
};

export type PlanningRequest = {
  readonly scope: EngineScope;
  readonly base: BaseSnapshot;
  readonly prompt: string;
  readonly databaseDialect: "mysql8" | "postgresql";
  readonly options: GenerationOptions;
};

export type ArchitectureRequest = PlanningRequest & {
  readonly analysis: RequirementsAnalysis;
};

export type DatabaseRequest = ArchitectureRequest & {
  readonly architecture: ArchitectureDraft;
};

export type GenerationRequest = {
  readonly scope: EngineScope;
  readonly base: BaseSnapshot;
  readonly approved: {
    readonly planId: string;
    readonly bindingDigest: string;
    readonly specification: ApprovedSpecification;
    readonly digest: string;
    readonly planDigest: string;
  };
  readonly design: {
    readonly architecture: ArchitectureDraft;
    readonly database?: DatabaseDesign;
  };
  readonly options: GenerationOptions;
};

export type CandidateArtifact = {
  readonly kind: "requirements" | "architecture" | "database-design" | "openapi" | "backend" | "frontend" | "security" | "dependency-graph" | "engineering-graph" | "test-plan";
  readonly format: "json" | "text";
  readonly content: string;
  readonly digest: string;
};

export type CandidateArtifacts = {
  readonly actor: EngineActor;
  readonly approvedPlanId: string;
  readonly bindingDigest: string;
  readonly engine: EngineMetadata;
  readonly generatedAt: string;
  readonly validationState: "pending";
  readonly acceptanceState: "unaccepted";
  readonly state: "candidate";
  readonly id: string;
  readonly projectId: string;
  readonly specificationId: string;
  readonly specificationDigest: string;
  readonly planDigest: string;
  readonly base: BaseReference;
  readonly files: readonly EngineFile[];
  readonly artifacts: readonly CandidateArtifact[];
  readonly manifestDigest: string;
};

export type CandidateRequest = {
  readonly generation: GenerationRequest;
  readonly candidate: CandidateArtifacts;
};

export type Finding = {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly paths: readonly string[];
  readonly requirementIds: readonly string[];
};

export type SecurityReview = { readonly candidateId: string; readonly findings: readonly Finding[] };

export type EngineeringGraphDraft = {
  readonly candidateId: string;
  readonly nodes: readonly { readonly key: string; readonly kind: string; readonly label: string }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
};

export type CandidateValidation = {
  readonly candidateId: string;
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed" | "failed" | "unavailable" | "skipped" | "blocked";
    readonly required: boolean;
    readonly evidence: string;
    readonly subjectPaths: readonly string[];
  }[];
  readonly findings: readonly Finding[];
};

export type RepairRequest = CandidateRequest & {
  readonly attempt: number;
  readonly findings: readonly Finding[];
};

export type RepairProposal = {
  readonly baseCandidateId: string;
  readonly attempt: number;
  readonly addressedFindingCodes: readonly string[];
  readonly candidate: CandidateArtifacts;
};

export interface GenerationEngine {
  analyzeRequirements(request: PlanningRequest): Promise<EngineResult<RequirementsAnalysis>>;
  planArchitecture(request: ArchitectureRequest): Promise<EngineResult<ArchitectureDraft>>;
  designDatabase(request: DatabaseRequest): Promise<EngineResult<DatabaseDesign>>;
  generateBackend(request: GenerationRequest): Promise<EngineResult<CandidateArtifacts>>;
  generateFrontend(request: GenerationRequest & { readonly backend: CandidateArtifacts }): Promise<EngineResult<CandidateArtifacts>>;
  reviewSecurity(request: CandidateRequest): Promise<EngineResult<SecurityReview>>;
  buildEngineeringGraph(request: CandidateRequest): Promise<EngineResult<EngineeringGraphDraft>>;
  validateCandidate(request: CandidateRequest): Promise<EngineResult<CandidateValidation>>;
  repairCandidate(request: RepairRequest): Promise<EngineResult<RepairProposal>>;
}
