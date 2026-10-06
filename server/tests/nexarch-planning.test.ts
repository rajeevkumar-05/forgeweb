import assert from "node:assert/strict";
import test from "node:test";
import { fileManifestDigest } from "../generation/contract.ts";
import type { PlanningRequest } from "../generation/engine.ts";
import { NexArchPlanningAdapter, NEXARCH_PLANNING_PROFILE, NEXARCH_POSTGRESQL_PLANNING_PROFILE, PlanningProviderError } from "../generation/nexarch/adapter.ts";
import * as upstream from "../generation/nexarch/upstream/planning.ts";
import { planPrompt } from "../generation/planning.ts";
import { DATABASE_TARGETS } from "../generation/targets.ts";

const PROMPT = "Build a task management web application where users can create, edit, delete, assign, and track tasks with authentication.";

function request(prompt = PROMPT, databaseDialect: PlanningRequest["databaseDialect"] = "mysql8"): PlanningRequest {
  return {
    scope: { projectId: "forge-project-1", buildId: "build-1", operationId: "operation-1", actor: { kind: "authenticated", subjectId: "user-1", ownerId: "user-1" } },
    base: { kind: "empty", projectId: "forge-project-1", manifestDigest: fileManifestDigest([]), files: [] },
    prompt,
    databaseDialect,
    options: { targetProfile: databaseDialect === "postgresql" ? NEXARCH_POSTGRESQL_PLANNING_PROFILE : NEXARCH_PLANNING_PROFILE, maxFiles: 100, maxTotalBytes: 1_000_000 },
  };
}

test("real task prompt reaches all three NexArch planning stages and stays a proposal", async () => {
  const result = await planPrompt(new NexArchPlanningAdapter(), request());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const proposal = result.value;
  assert.equal(proposal.state, "proposed");
  assert.equal(proposal.scope.projectId, "forge-project-1");
  assert.equal(proposal.scope.actor.ownerId, "user-1");
  assert.equal(proposal.databaseDialect, "mysql8");
  assert.deepEqual(proposal.files, []);
  assert.ok(proposal.analysis.facets?.modules.includes("Tasks"));
  assert.ok(proposal.analysis.proposedRequirements.some((item) => item.title === "Manage Tasks"));
  assert.ok(proposal.architecture?.endpoints.some((endpoint) => endpoint.path === "/tasks" && endpoint.requirementIds.length > 0));
  assert.ok(proposal.architecture?.structure?.entities.some((entity) => entity.name === "Tasks"));
  assert.equal(proposal.database?.dialect, "MySQL 8");
  assert.equal(proposal.database?.target.dialect, "mysql8");
  assert.equal(proposal.database?.target.provider, "mysql");
  assert.equal(proposal.database?.target.prisma.provider, "mysql");
  const tasks = proposal.database?.entities.find((entity) => entity.name === "Tasks");
  assert.equal(tasks?.tableName, "tasks");
  assert.ok(tasks?.fields.some((field) => field.primaryKey && field.name === "id"));
  assert.ok(tasks?.fields.some((field) => field.name === "assignee_id" && field.references?.table === "Users"));
  assert.ok(tasks?.indexes?.some((index) => index.columns.includes("assignee_id")));
  assert.equal(tasks?.fields.find((field) => field.primaryKey)?.type, "CHAR(36)");
  assert.ok(proposal.database?.entities.flatMap((entity) => entity.fields).some((field) => field.type === "DATETIME"));
  assert.match(proposal.database?.entities.find((entity) => entity.name === "Users")?.fields.find((field) => field.name === "role")?.type ?? "", /^ENUM\(/);
  assert.ok(proposal.database?.relationships.some((relation) => relation.from === "Tasks" && relation.to === "Users"));
  assert.equal("sqlSchema" in (proposal.database ?? {}), false);
  assert.equal("prismaSchema" in (proposal.database ?? {}), false);
  assert.equal("approved" in proposal, false);
});

test("PostgreSQL target produces native PostgreSQL design semantics before emission", async () => {
  const result = await planPrompt(new NexArchPlanningAdapter(), request(PROMPT, "postgresql"));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const proposal = result.value;
  const database = proposal.database;
  assert.ok(database);
  if (!database) return;
  assert.equal(proposal.databaseDialect, "postgresql");
  assert.equal(proposal.architecture?.projection.data.database, "PostgreSQL");
  assert.equal(database.dialect, "PostgreSQL");
  assert.equal(database.target.dialect, "postgresql");
  assert.equal(database.target.provider, "postgresql");
  assert.equal(database.target.prisma.provider, "postgresql");
  assert.equal(database.target.prisma.urlExpression, 'env("DATABASE_URL")');
  assert.match(database.target.prisma.datasource, /provider = "postgresql"/);
  assert.match(database.target.prisma.datasource, /env\("DATABASE_URL"\)/);
  assert.equal(database.target.connection.envVar, "DATABASE_URL");
  assert.equal(database.target.connection.placeholder, "postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public");
  assert.equal(database.target.connection.placeholder.includes("user-1"), false);

  const fields = database.entities.flatMap((entity) => entity.fields);
  const id = fields.find((field) => field.primaryKey);
  assert.equal(id?.type, "UUID");
  assert.equal(id?.defaultExpression, "gen_random_uuid()");
  assert.equal(database.target.uuid.prismaDefaultExpression, "uuid()");
  assert.ok(fields.some((field) => field.name === "created_at" && field.type === "TIMESTAMPTZ(3)" && field.defaultExpression === "CURRENT_TIMESTAMP"));
  assert.ok(fields.some((field) => field.name === "updated_at" && field.type === "TIMESTAMPTZ(3)" && field.defaultExpression === "CURRENT_TIMESTAMP"));
  assert.equal(database.target.timestamps.updateBehavior, "prisma-updated-at");

  const role = database.entities.find((entity) => entity.name === "Users")?.fields.find((field) => field.name === "role");
  assert.ok(role?.enumValues?.length);
  assert.match(role?.type ?? "", /^[a-z][a-z0-9_]*$/);
  assert.equal(role?.enumDatabaseType, role?.type);
  assert.match(role?.defaultExpression ?? "", /^'[A-Z0-9_]+'$/);
  const assignee = database.entities.find((entity) => entity.name === "Tasks")?.fields.find((field) => field.name === "assignee_id");
  assert.equal(assignee?.references?.onDelete, "SET NULL");
  assert.equal(assignee?.references?.onUpdate, "CASCADE");
  assert.ok(database.relationships.some((relationship) => relationship.foreignKey === "assignee_id" && relationship.onDelete === "SET NULL" && relationship.onUpdate === "CASCADE"));

  const generatedColumns = JSON.stringify(database.entities.flatMap((entity) => entity.fields.map((field) => ({ type: field.type, defaultExpression: field.defaultExpression }))));
  assert.doesNotMatch(generatedColumns, /ENUM\s*\(|DATETIME|CHAR\(36\)|`|InnoDB|utf8mb4|SET FOREIGN_KEY_CHECKS|\bUUID\(\)/i);
  assert.doesNotMatch(JSON.stringify(database), /MySQL|InnoDB|utf8mb4|SET FOREIGN_KEY_CHECKS/i);
  assert.doesNotMatch(proposal.architecture?.projection.markdown ?? "", /composed with MySQL/);
});

test("PostgreSQL architecture recommendations stay target-aware for larger schemas", () => {
  const analyzed = upstream.analyzeRequirements(PROMPT);
  assert.equal(analyzed.status, "COMPLETE");
  if (analyzed.status !== "COMPLETE") return;
  const spec = {
    ...analyzed.spec,
    database: ["Users", "Tasks", "Projects", "Comments", "Attachments", "Activities", "Tickets", "Categories"],
  };
  const { plan, markdown } = upstream.planArchitecture(spec, DATABASE_TARGETS.postgresql);
  assert.ok(plan.futureScalability.some((item) => item.recommendation.includes("PostgreSQL full-text search")));
  assert.equal(plan.futureScalability.some((item) => item.recommendation.includes("MySQL FULLTEXT")), false);
  assert.match(markdown, /composed with PostgreSQL/);
  assert.doesNotMatch(markdown, /composed with MySQL/);
});

test("adapter translates complete analysis and architecture into ForgeWeb-owned values", async () => {
  const adapter = new NexArchPlanningAdapter();
  const input = request();
  const analysis = await adapter.analyzeRequirements(input);
  assert.equal(analysis.ok, true);
  if (!analysis.ok) return;
  assert.equal(analysis.value.context?.projectId, input.scope.projectId);
  assert.equal(analysis.value.context?.ownerId, input.scope.actor.ownerId);
  assert.equal("spec" in analysis.value, false);
  const architecture = await adapter.planArchitecture({ ...input, analysis: analysis.value });
  assert.equal(architecture.ok, true);
  if (!architecture.ok) return;
  assert.equal("apiModules" in architecture.value, false);
  assert.ok(architecture.value.structure?.services.length);
  assert.ok(architecture.value.structure?.decisions.length);
  const database = await adapter.designDatabase({ ...input, analysis: analysis.value, architecture: architecture.value });
  assert.equal(database.ok, true);
});

test("invalid input, mismatched profiles, and unsupported dialects fail clearly", async () => {
  const adapter = new NexArchPlanningAdapter();
  const short = await adapter.analyzeRequirements(request("build"));
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.error.code, "validation_failure");
  const wrongProfile = await adapter.analyzeRequirements({ ...request(), options: { ...request().options, targetProfile: "postgres" } });
  assert.equal(wrongProfile.ok, false);
  if (!wrongProfile.ok) assert.equal(wrongProfile.error.code, "validation_failure");
  const wrongPostgresProfile = await adapter.analyzeRequirements({ ...request(PROMPT, "postgresql"), options: { ...request().options, targetProfile: NEXARCH_PLANNING_PROFILE } });
  assert.equal(wrongPostgresProfile.ok, false);
  if (!wrongPostgresProfile.ok) assert.match(wrongPostgresProfile.error.message, /UNSUPPORTED_DATABASE_PROFILE/);
  const unsupported = await adapter.analyzeRequirements({ ...request(), databaseDialect: "sqlite" } as unknown as PlanningRequest);
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) {
    assert.equal(unsupported.error.code, "validation_failure");
    assert.match(unsupported.error.message, /UNSUPPORTED_DATABASE_DIALECT: sqlite/);
  }
});

test("ForgeWeb project and owner context cannot be crossed between planning stages", async () => {
  const adapter = new NexArchPlanningAdapter();
  const input = request();
  const analysis = await adapter.analyzeRequirements(input);
  assert.equal(analysis.ok, true);
  if (!analysis.ok) return;
  const foreign = { ...input, scope: { ...input.scope, projectId: "other-project" }, base: { ...input.base, projectId: "other-project" } };
  const plan = await adapter.planArchitecture({ ...foreign, analysis: analysis.value });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.error.code, "security_failure");
  const otherOwner = { ...input, scope: { ...input.scope, actor: { kind: "authenticated" as const, subjectId: "user-2", ownerId: "user-2" } } };
  const owned = await adapter.planArchitecture({ ...otherOwner, analysis: analysis.value });
  assert.equal(owned.ok, false);
  if (!owned.ok) assert.equal(owned.error.code, "security_failure");
});

test("database stage rejects an altered architecture instead of silently recomputing it", async () => {
  const adapter = new NexArchPlanningAdapter();
  const input = request();
  const analysis = await adapter.analyzeRequirements(input);
  assert.equal(analysis.ok, true);
  if (!analysis.ok) return;
  const architecture = await adapter.planArchitecture({ ...input, analysis: analysis.value });
  assert.equal(architecture.ok, true);
  if (!architecture.ok) return;
  const changed = { ...architecture.value, endpoints: [] };
  const database = await adapter.designDatabase({ ...input, analysis: analysis.value, architecture: changed });
  assert.equal(database.ok, false);
  if (!database.ok) assert.equal(database.error.code, "validation_failure");
});

test("an injected provider failure is explicit; the bundled deterministic planner uses no provider", async () => {
  const adapter = new NexArchPlanningAdapter({
    ...upstream,
    analyzeRequirements: () => { throw new PlanningProviderError("unavailable"); },
  });
  const result = await planPrompt(adapter, request());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "provider_failure");
    assert.equal(result.error.retryable, true);
    assert.equal(result.error.message.includes("unavailable"), false);
  }
});

test("pipeline refuses an architecture/database dialect mismatch", async () => {
  const adapter = new NexArchPlanningAdapter();
  const result = await planPrompt({
    analyzeRequirements: (input) => adapter.analyzeRequirements(input),
    planArchitecture: (input) => adapter.planArchitecture(input),
    designDatabase: async (input) => {
      const design = await adapter.designDatabase(input);
      return design.ok ? { ...design, value: { ...design.value, dialect: "PostgreSQL" } } : design;
    },
  }, request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "validation_failure");
});
