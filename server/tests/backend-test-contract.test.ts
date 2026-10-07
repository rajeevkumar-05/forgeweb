import assert from "node:assert/strict";
import test from "node:test";
import { emitTests } from "../generation/nexarch/upstream/modules/backend-generator/lib/emit-tests.ts";
import { emitModule } from "../generation/nexarch/upstream/modules/backend-generator/lib/emit-module.ts";
import type { EndpointModel, ModuleModel, ProjectModel } from "../generation/nexarch/upstream/modules/backend-generator/lib/project-model.ts";
import type { ColumnDesign, TableDesign } from "../generation/nexarch/upstream/shared/types/design.ts";

function column(name: string, field = name, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return { name, field, sqlType: "TEXT", prismaType: "String", nullable: false, primaryKey: false, unique: false, description: name, ...overrides };
}

function table(entity: string, columns: ColumnDesign[]): TableDesign {
  return { entity, tableName: entity.toLowerCase(), columns, primaryKey: "id", indexes: [], softDelete: true, description: entity };
}

function endpoint(method: EndpointModel["method"], routePath: string, auth: boolean): EndpointModel {
  return { method, routePath, auth, fullPath: routePath, operationId: method + routePath, handlerName: "listRecords", kind: method === "get" ? "list" : "custom", roles: [], summary: "Test contract", pathParams: [] };
}

function module(name: string, entity: TableDesign | null, endpoints: EndpointModel[]): ModuleModel {
  return { name, className: name, basePath: "/" + name, entity, inputColumns: [], validation: null, metadata: null, endpoints, crud: entity !== null, deleteRoles: null };
}

function project(protectedRoute = true, credentials = true): ProjectModel {
  const warehouse = table("Warehouses", [
    column("id", "id", { format: "uuid", primaryKey: true }),
    column("state", "state", { prismaType: "WarehouseState", enumValues: ["OPEN", "CLOSED"] }),
    column("count", "count", { prismaType: "Int" }),
    column("enabled", "enabled", { prismaType: "Boolean" }),
    column("created_at", "createdAt", { prismaType: "DateTime" }),
    column("deleted_at", "deletedAt", { prismaType: "DateTime", nullable: true }),
  ]);
  const accounts = table("Accounts", [
    column("id", "id", { format: "uuid", primaryKey: true }),
    column("login_email", "loginEmail", { unique: true, format: "email" }),
    column("password_hash", "passwordHash"),
    column("full_name", "displayName"),
    column("organization_code", "organizationCode"),
  ]);
  return {
    projectName: "Warehouse", projectType: "internal-tool", apiPrefix: "/api/custom", roles: ["Admin", "User"], authMethods: ["email-password"],
    tables: credentials ? [warehouse, accounts] : [warehouse],
    modules: [module("warehouses", warehouse, [endpoint("get", "/", protectedRoute)]), module("sessions", null, [endpoint("post", "/register", false), endpoint("post", "/login", false)])],
  };
}

function content(model: ProjectModel, path: string): string {
  const result = emitTests(model).find(file => file.path === path);
  assert.ok(result, path);
  return result.content;
}

test("generated unit fixtures are checked against entity and create DTO types without widening enums", () => {
  const source = content(project(), "src/modules/warehouses/services/warehouses.service.test.ts");
  assert.match(source, /import type \{ CreateWarehouseDto, WarehousesEntity \}/);
  assert.match(source, /const fixture: WarehousesEntity =/);
  assert.match(source, /const createFixture: CreateWarehouseDto =/);
  assert.match(source, /state: 'OPEN'/);
  assert.match(source, /createdAt: new Date\(\)/);
  assert.match(source, /deletedAt: null/);
  assert.doesNotMatch(source, /updatedAt:/);
  const create = source.slice(source.indexOf("const createFixture:"), source.indexOf("describe("));
  assert.doesNotMatch(create, /id:|createdAt:|deletedAt:/);
  assert.match(create, /count: 1/);
  assert.match(create, /enabled: true/);
  assert.match(source, /service.create\(createFixture\)/);
  assert.match(source, /toHaveBeenCalledWith\(createFixture\)/);
  assert.doesNotMatch(source, /as any|\.skip\(/);
});

test("protected list tests keep unauthorized checks and sign in through real generated authentication routes", () => {
  const model = project();
  const source = content(model, "test/integration/warehouses.integration.test.ts");
  assert.equal((source.match(/toBe\(401\)/g) ?? []).length, 2);
  assert.match(source, /Bearer invalid-test-token/);
  assert.match(source, /post\('\/api\/custom\/sessions\/register'\)/);
  assert.match(source, /post\('\/api\/custom\/sessions\/login'\)/);
  assert.match(source, /loginEmail: 'integration-warehouses@example.test'/);
  assert.match(source, /displayName: 'Integration User'/);
  assert.match(source, /organizationCode:/);
  assert.match(source, /toBe\(201\)/);
  assert.match(source, /get\('\/api\/custom\/warehouses'\).set\('Authorization', 'Bearer ' \+ accessToken\)/);
  assert.match(source, /expect.any\(Array\)/);
  assert.match(source, /await disconnectDatabase\(\)/);
  assert.doesNotMatch(source, /jwt.sign|jest.mock|\.skip\(/);
  const routes = emitModule(model.modules[0]).find(file => file.path.endsWith(".routes.ts"))!.content;
  assert.match(routes, /requireAuth, validate/);
});

test("public list tests do not invent an authentication requirement", () => {
  const source = content(project(false), "test/integration/warehouses.integration.test.ts");
  assert.match(source, /get\('\/api\/custom\/warehouses'\);/);
  assert.match(source, /expect\(response.status\).toBe\(200\)/);
  assert.doesNotMatch(source, /Authorization|accessToken|beforeAll|toBe\(401\)/);
});

test("protected routes without an implemented credential capability fail explicitly rather than skipping access coverage", () => {
  const source = content(project(true, false), "test/integration/warehouses.integration.test.ts");
  assert.match(source, /toBe\(401\)/);
  assert.match(source, /throw new Error\('Protected list route has no implemented register\/login capability'\)/);
  assert.doesNotMatch(source, /\.skip\(|jwt.sign|Bearer ' \+ accessToken/);
});

test("test generation remains deterministic for identical design contracts", () => {
  const model = project();
  assert.deepEqual(emitTests(model), emitTests(structuredClone(model)));
});
