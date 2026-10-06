import type { ArchitectureDraft, DatabaseDesign, EngineResult, EngineScope, GenerationEngine, PlanningRequest, RequirementsAnalysis } from "./engine.ts";

export type PlanningSpecification = {
  readonly state: "needs_context" | "proposed";
  readonly scope: EngineScope;
  readonly prompt: string;
  readonly databaseDialect: PlanningRequest["databaseDialect"];
  readonly analysis: RequirementsAnalysis;
  readonly architecture?: ArchitectureDraft;
  readonly database?: DatabaseDesign;
  readonly files: readonly [];
};

export type PlanningEngine = Pick<GenerationEngine, "analyzeRequirements" | "planArchitecture" | "designDatabase">;

/** Planning does not approve, persist, provision, or generate an application. */
export async function planPrompt(engine: PlanningEngine, request: PlanningRequest): Promise<EngineResult<PlanningSpecification>> {
  if (!["mysql8", "postgresql"].includes(request.databaseDialect)) {
    return { ok: false, engine: { name: "forgeweb-planning", version: "1", contractVersion: "forgeweb-generation-v1" }, error: { code: "validation_failure", stage: "planning", message: "An explicit supported database dialect is required", retryable: false } };
  }
  const analysis = await engine.analyzeRequirements(request);
  if (!analysis.ok) return analysis;
  if (analysis.value.questions.length) {
    return { ok: true, engine: analysis.engine, value: { state: "needs_context", scope: request.scope, prompt: request.prompt, databaseDialect: request.databaseDialect, analysis: analysis.value, files: [] } };
  }
  const architecture = await engine.planArchitecture({ ...request, analysis: analysis.value });
  if (!architecture.ok) return architecture;
  const database = await engine.designDatabase({ ...request, analysis: analysis.value, architecture: architecture.value });
  if (!database.ok) return database;
  const expectedDialect = request.databaseDialect === "mysql8" ? "MySQL 8" : "PostgreSQL";
  if (database.value.dialect !== expectedDialect || architecture.value.projection.data.database !== expectedDialect) {
    return { ok: false, engine: database.engine, error: { code: "validation_failure", stage: "planning", message: "Architecture and database dialect must match the explicit planning request", retryable: false } };
  }
  return {
    ok: true,
    engine: database.engine,
    value: { state: "proposed", scope: request.scope, prompt: request.prompt, databaseDialect: request.databaseDialect, analysis: analysis.value, architecture: architecture.value, database: database.value, files: [] },
  };
}
