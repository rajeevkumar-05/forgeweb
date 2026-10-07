import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../store.ts';
import { fileManifestDigest } from '../generation/contract.ts';
import type { PlanningRequest } from '../generation/engine.ts';
import { PlanningApprovalService } from '../generation/approval.ts';
import { planPrompt } from '../generation/planning.ts';
import { CandidateAssembler } from '../generation/candidate.ts';
import { ForgeWebCandidateValidator } from '../generation/validation.ts';
import { dockerWorkflowFromEnvironment } from '../generation/docker-infrastructure.ts';
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from '../generation/nexarch/adapter.ts';
import { NexArchBackendAdapter, upstreamDatabase, upstreamRequirements } from '../generation/nexarch/backend-adapter.ts';
import { NexArchFrontendAdapter } from '../generation/nexarch/frontend-adapter.ts';
import { generateBackend } from '../generation/nexarch/upstream/modules/backend-generator/backend-generator.service.ts';
import { generateOpenApi } from '../generation/nexarch/upstream/modules/database-designer/lib/openapi-generator.ts';
import { generatePrismaSchema } from '../generation/nexarch/upstream/modules/database-designer/lib/prisma-generator.ts';
import { generateValidationRules } from '../generation/nexarch/upstream/modules/database-designer/lib/validation-generator.ts';
import { generateEntityMetadata } from '../generation/nexarch/upstream/modules/database-designer/lib/entity-metadata-generator.ts';
import { generateFrontend } from '../generation/nexarch/upstream/modules/frontend-generator/frontend-generator.service.ts';
import { buildProjectModel as frontendModel } from '../generation/nexarch/upstream/modules/frontend-generator/lib/project-model.ts';
import { emitEntityPages } from '../generation/nexarch/upstream/modules/frontend-generator/lib/emit-entity-pages.ts';
import { crudOperations } from '../generation/nexarch/upstream/shared/utils/operations.ts';
import * as planning from '../generation/nexarch/upstream/planning.ts';
import type { SemanticEntity } from '../generation/nexarch/upstream/shared/types/requirement.ts';

const PROMPT = 'Build a recipe management application.\n\nUsers can create, edit, and view recipes.\n\nEach recipe has title, ingredients, preparation steps, cooking time, difficulty, and category.\n\nNo payments are required.';
const FIELDS = ['title', 'ingredients', 'preparationSteps', 'cookingTime', 'difficulty', 'category'];
const SQL_FIELDS = ['title', 'ingredients', 'preparation_steps', 'cooking_time', 'difficulty', 'category'];

async function generateRecipe() {
  const input: PlanningRequest = {
    scope: { projectId: 'recipe-project', buildId: 'recipe-build', operationId: 'recipe-operation', actor: { kind: 'authenticated', ownerId: 'recipe-owner', subjectId: 'recipe-owner' } },
    base: { kind: 'empty', projectId: 'recipe-project', files: [], manifestDigest: fileManifestDigest([]) },
    prompt: PROMPT, databaseDialect: 'postgresql',
    options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 300, maxTotalBytes: 3_000_000 },
  };
  const result = await planPrompt(new NexArchPlanningAdapter(), input);
  assert.ok(result.ok && result.value.state === 'proposed');
  const proposal = result.value;
  const directory = await mkdtemp(join(tmpdir(), 'forgeweb-recipe-generation-'));
  try {
    const store = new JsonStore(directory);
    await store.initialize();
    await store.mutate(database => {
      database.projects[input.scope.projectId] = { id: input.scope.projectId, slug: 'recipe-project', name: 'Recipe', status: 'awaiting_confirmation', currentBuildId: input.scope.buildId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      database.builds[input.scope.buildId] = { id: input.scope.buildId, projectId: input.scope.projectId, status: 'awaiting_confirmation', currentStageIndex: 1, stageDetail: 'Planning', stages: [], taskIds: [], filePaths: [], reviewFindings: [], validationChecks: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    });
    const approval = new PlanningApprovalService(store, (_project, actor) => actor.kind === 'authenticated' && actor.ownerId === 'recipe-owner' && actor.subjectId === 'recipe-owner');
    const engine = { name: 'nexarch-planning', version: '1', contractVersion: 'forgeweb-generation-v1' as const };
    const record = await approval.save(proposal, { kind: 'empty', manifestDigest: fileManifestDigest([]) }, engine, input.options);
    await approval.approve(record.id, record.digest, input.scope.projectId, input.scope.actor);
    const request = await approval.generationRequest(record.id, record.digest, input.scope.projectId, input.scope.actor);
    const backend = await new NexArchBackendAdapter().generate(request);
    assert.ok(backend.ok);
    const frontend = await new NexArchFrontendAdapter().generate(request, backend.value);
    assert.ok(frontend.ok);
    const assembled = new CandidateAssembler().assemble(request, backend, frontend);
    assert.ok(assembled.ok);
    assert.equal(Object.keys(store.read().versions).length, 0);
    assert.equal(Object.keys(store.read().generationCandidates).length, 0);
    const database = upstreamDatabase(request);
    const openapi = generateOpenApi(planning.planArchitecture(upstreamRequirements(request), database.target).plan, database);
    return { proposal, request, backend, frontend, candidate: assembled.value, database, openapi };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

let fixture: ReturnType<typeof generateRecipe> | undefined;
const recipe = () => fixture ??= generateRecipe();

function source(candidate: Awaited<ReturnType<typeof generateRecipe>>['candidate'], path: string): string {
  const file = candidate.files.find(file => file.path === path);
  assert.ok(file, `Missing generated file: ${path}`);
  return file.content;
}

function interfaceFields(content: string, name: string): string[] {
  const body = new RegExp(`export interface ${name} \\{([^}]+)\\}`).exec(content)?.[1];
  assert.ok(body, `Missing interface: ${name}`);
  return [...body.matchAll(/^\s*(\w+)\??:/gm)].map(match => match[1]);
}

for (const [index, field] of FIELDS.entries()) {
  test(`Recipe emits ${field} into table, Prisma, DTOs and request schemas`, async () => {
    const { candidate, database, openapi } = await recipe();
    const table = database.tables.find(table => table.entity === 'Recipes')!;
    const column = table.columns.find(column => column.field === field)!;
    assert.ok(column);
    assert.equal(column.name, SQL_FIELDS[index]);
    assert.equal(column.prismaType, 'String');
    assert.equal(column.enumValues, undefined);
    const prisma = source(candidate, 'backend/prisma/schema.prisma');
    const block = /model Recipes \{([^}]+)\}/.exec(prisma)?.[1] ?? '';
    assert.match(block, new RegExp(`\\b${field}\\s+String`));
    const dto = source(candidate, 'backend/src/modules/recipes/dto/recipes.dto.ts');
    for (const name of ['RecipesEntity', 'CreateRecipeDto', 'UpdateRecipeDto']) assert.ok(interfaceFields(dto, name).includes(field));
    for (const name of ['Recipes', 'RecipesCreateInput', 'RecipesUpdateInput']) assert.ok(Object.hasOwn(openapi.components.schemas[name].properties!, field));
    assert.match(source(candidate, 'backend/src/modules/recipes/validators/recipes.validators.ts'), new RegExp(`\\b${field}: z\\.string\\(`));
  });
  test(`Recipe binds ${field} into the actual create/edit form and list/detail view`, async () => {
    const { candidate, frontend } = await recipe();
    assert.equal(frontend.value.pages.find(page => page.entity === 'Recipes')?.status, 'implemented');
    const form = source(candidate, 'frontend/src/features/recipes/components/RecipeForm.tsx');
    assert.match(form, new RegExp(`register\\('${field}'\\)`));
    const page = source(candidate, 'frontend/src/features/recipes/RecipesPage.tsx');
    assert.match(page, new RegExp(`key: '${field}'`));
    assert.match(page, new RegExp(`detailRecord\\.${field}\\b`));
    assert.ok(interfaceFields(source(candidate, 'frontend/src/features/recipes/types.ts'), 'RecipesRecord').includes(field));
  });
}

test('Recipe create/read/update are live handlers, requests and UI actions; DELETE is absent', async () => {
  const { candidate, backend, frontend } = await recipe();
  const routes = backend.value.routes.filter(route => route.entity === 'Recipes');
  assert.deepEqual(routes.map(route => `${route.method} ${route.path}`).sort(), ['GET /api/v1/recipes', 'GET /api/v1/recipes/:id', 'POST /api/v1/recipes', 'PUT /api/v1/recipes/:id']);
  assert.ok(routes.every(route => route.status === 'implemented' && route.auth));
  const calls = frontend.value.api.generatedCalls.filter(call => call.feature === 'Recipes');
  assert.deepEqual(calls.map(call => `${call.method} ${call.path}`).sort(), routes.map(route => `${route.method} ${route.path}`).sort());
  assert.ok(calls.every(call => call.requirementIds.length));
  const router = source(candidate, 'backend/src/modules/recipes/routes/recipes.routes.ts');
  assert.doesNotMatch(router, /router\.delete\(/);
  const controller = source(candidate, 'backend/src/modules/recipes/controllers/recipes.controller.ts');
  assert.match(controller, /this\.service\.create\(req\.body as CreateRecipeDto\)/);
  assert.match(controller, /this\.service\.update\(req\.params\.id as string, req\.body as UpdateRecipeDto\)/);
  assert.match(controller, /this\.service\.list\(/);
  assert.match(controller, /this\.service\.findById\(/);
  const service = source(candidate, 'backend/src/modules/recipes/services/recipes.service.ts');
  assert.match(service, /this\.repository\.create\(/);
  assert.match(service, /this\.repository\.update\(/);
  const page = source(candidate, 'frontend/src/features/recipes/RecipesPage.tsx');
  assert.match(page, /New Recipe/);
  assert.match(page, /Edit Recipe/);
  assert.match(page, /<RecipeForm/);
  for (const file of candidate.files.filter(file => file.path.startsWith('frontend/src/features/recipes/'))) assert.doesNotMatch(file.content, /useDelete|deleteRecipe|apiClient\.delete|ConfirmDialog|Delete Recipe/);
});

test('Recipe exclusions remove payment/invoice schemas, routes, dependencies and UI artifacts', async () => {
  const { candidate, database, backend, frontend, openapi } = await recipe();
  assert.ok(database.tables.every(table => !/payment|invoice/i.test(table.entity)));
  assert.ok(Object.keys(openapi.components.schemas).every(name => !/payment|invoice/i.test(name)));
  assert.ok(backend.value.routes.every(route => !/payment|invoice|checkout/i.test(route.path)));
  assert.ok(frontend.value.pages.every(page => !/payment|invoice|checkout/i.test(page.name)));
  assert.ok(candidate.files.every(file => !/payment|invoice|checkout/i.test(file.path)));
  for (const file of candidate.files.filter(file => /\.(tsx?|prisma)$/.test(file.path))) assert.doesNotMatch(file.content, /(?:apiClient\.(?:post|get)|router\.(?:post|get))\([^\n]*(?:payment|invoice|checkout)/i);
  for (const path of ['backend/package.json', 'frontend/package.json']) assert.doesNotMatch(source(candidate, path), /stripe|paypal|razorpay/i);
});

test('Unknown Recipe types keep existing string defaults without fabricating category enum or FK', async () => {
  const { database, request } = await recipe();
  const semantic = request.approved.specification.semantics!.design!.entities.find(entity => entity.name === 'Recipes')!;
  assert.ok(semantic.fields.every(field => field.category === undefined));
  const category = database.tables.find(table => table.entity === 'Recipes')!.columns.find(column => column.field === 'category')!;
  assert.equal(category.prismaType, 'String');
  assert.equal(category.enumValues, undefined);
  assert.equal(category.references, undefined);
});

test('Stable structured relationship intent creates a real FK without a domain-specific branch', async () => {
  const { database, request } = await recipe();
  const spec = upstreamRequirements(request);
  const entity = spec.semantics!.design!.entities.find(entity => entity.name === 'Recipes')!;
  entity.relationships.push({ target: 'Categories', field: 'category', kind: 'many-to-one', source: 'known' });
  const design = planning.designDatabase(planning.planArchitecture(spec, database.target).plan, spec, database.target);
  const category = design.tables.find(table => table.entity === 'Recipes')!.columns.find(column => column.field === 'category')!;
  assert.equal(category.format, 'uuid');
  assert.equal(category.references?.table, 'Categories');
  assert.ok(design.relationships.some(relation => relation.child === 'Recipes' && relation.parent === 'Categories'));
  const schema = generatePrismaSchema(design);
  const model = /model Recipes \{([^}]+)\}/.exec(schema)![1];
  const names = [...model.matchAll(/^\s+(\w+)\s+[A-Z]/gm)].map(match => match[1]);
  assert.equal(new Set(names).size, names.length);
  assert.match(model, /categoryRelation Categories\? @relation\(fields: \[category\]/);
  entity.relationships[0].kind = 'one-to-one';
  const oneToOne = planning.designDatabase(planning.planArchitecture(spec, database.target).plan, spec, database.target);
  assert.equal(oneToOne.tables.find(table => table.entity === 'Recipes')!.columns.find(column => column.field === 'category')!.unique, true);
});

test('Operation selection is reusable, excludes take precedence, and legacy contracts retain CRUD', () => {
  assert.deepEqual(crudOperations(), ['create', 'read', 'update', 'delete']);
  const entity: SemanticEntity = { name: 'Documents', fields: [], relationships: [], operationPolicy: 'explicit', operations: [
    { name: 'view', action: 'read', intent: 'requested', source: 'known', support: 'unverified' },
    { name: 'delete', action: 'delete', intent: 'requested', source: 'known', support: 'unverified' },
    { name: 'delete', action: 'delete', intent: 'excluded', source: 'known', support: 'unverified' },
  ] };
  assert.deepEqual(crudOperations(entity), ['read']);
  assert.deepEqual(crudOperations({ ...entity, operations: [], operationPolicy: 'explicit' }), []);
});

test('Protected Recipe page remains unavailable when a requested backend capability is a stub', async () => {
  const { request } = await recipe();
  for (const path of ['/api/v1/auth/login', '/api/v1/recipes/:id']) {
    const backend = await new NexArchBackendAdapter((...args) => {
      const generated = generateBackend(...args);
      return { ...generated, routes: generated.routes.map(route => route.path === path ? { ...route, implemented: false } : route) };
    }).generate(request);
    assert.ok(backend.ok);
    const frontend = await new NexArchFrontendAdapter().generate(request, backend.value);
    assert.ok(frontend.ok);
    assert.equal(frontend.value.pages.find(page => page.entity === 'Recipes')?.status, 'unavailable');
    assert.ok(!frontend.value.api.generatedCalls.some(call => call.feature === 'Recipes'));
  }
});

test('Read-only semantic contract generates detail/list without create/edit/delete calls or controls', async () => {
  const { database, request } = await recipe();
  const spec = upstreamRequirements(request);
  const entity = spec.semantics!.design!.entities.find(entity => entity.name === 'Recipes')!;
  entity.operations = entity.operations.filter(operation => operation.action === 'read');
  const architecture = planning.planArchitecture(spec, database.target).plan;
  const design = planning.designDatabase(architecture, spec, database.target);
  const openapi = generateOpenApi(architecture, design);
  assert.deepEqual(Object.keys(openapi.paths['/recipes']), ['get']);
  const metadata = generateEntityMetadata(design, spec);
  const backend = generateBackend(architecture, spec, design, generatePrismaSchema(design), openapi, generateValidationRules(design).entities, metadata);
  const frontend = generateFrontend(architecture, spec, design, openapi, backend, metadata);
  assert.equal(frontend.pages.find(page => page.entity === 'Recipes')!.implemented, true);
  assert.ok(!frontend.files.some(file => file.path === 'src/features/recipes/components/RecipeForm.tsx'));
  for (const file of frontend.files.filter(file => file.path.startsWith('src/features/recipes/'))) {
    assert.doesNotMatch(file.content, /apiClient\.(?:post|put|delete)|useCreate|useUpdate|useDelete|New Recipe|Edit Recipe|Delete Recipe/);
  }
  assert.match(frontend.files.find(file => file.path === 'src/features/recipes/RecipesPage.tsx')!.content, /detailRecord\.ingredients/);
});

test('Authentication capability metadata stays unavailable without an emitted credential-backed handler', async () => {
  const { database, request } = await recipe();
  const spec = upstreamRequirements(request);
  spec.database = spec.database.filter(entity => entity !== 'Users');
  const architecture = planning.planArchitecture(spec, database.target).plan;
  const design = planning.designDatabase(architecture, spec, database.target);
  const openapi = generateOpenApi(architecture, design);
  const backend = generateBackend(architecture, spec, design, generatePrismaSchema(design), openapi, generateValidationRules(design).entities, generateEntityMetadata(design, spec));
  assert.ok(backend.routes.filter(route => route.path.startsWith('/api/v1/auth/')).every(route => !route.implemented));
});

test('Generated detail views never render password fields', async () => {
  const { database, request } = await recipe();
  const spec = upstreamRequirements(request);
  const architecture = planning.planArchitecture(spec, database.target).plan;
  const openapi = generateOpenApi(architecture, database);
  const metadata = generateEntityMetadata(database, spec);
  const backend = generateBackend(architecture, spec, database, generatePrismaSchema(database), openapi, generateValidationRules(database).entities, metadata);
  const page = frontendModel(architecture, spec, database, openapi, backend, metadata).pages.find(page => page.name === 'Recipes')!;
  const password = database.tables.find(table => table.entity === 'Users')!.columns.find(column => column.name === 'password_hash')!;
  assert.ok(password);
  const emitted = emitEntityPages([{ ...page, formFields: [...page.formFields, password] }])[0].content;
  assert.doesNotMatch(emitted, /detailRecord\.password(?:Hash)?\b/);
});

test('Actual raw-prompt candidate is deterministic, traced, immutable and passes every static check', async t => {
  const { request, candidate, backend, frontend } = await recipe();
  const repeated = new CandidateAssembler().assemble(request, backend, frontend);
  assert.ok(repeated.ok);
  assert.deepEqual(repeated.value, candidate);
  assert.ok(Object.isFrozen(candidate));
  const validation = await new ForgeWebCandidateValidator().validate(request, candidate);
  assert.ok(validation.ok);
  assert.equal(validation.value.status, 'unavailable', JSON.stringify(validation.value.checks.filter(check => check.status === 'failed')));
  assert.ok(validation.value.checks.filter(check => !['typecheck', 'build', 'tests', 'startup-health', 'postgresql-runtime', 'live-production-preview'].includes(check.id)).every(check => check.status === 'passed'));
  t.diagnostic(`Actual Recipe candidate: ${backend.value.files.length} backend files; ${frontend.value.files.length} frontend files; ${candidate.files.length} candidate files. Static validation passed; isolated evidence unavailable without Docker test.`);
});

test('Recipe candidate validates through existing isolated Docker and disposable PostgreSQL boundaries', { skip: process.env.FORGEWEB_RECIPE_DOCKER_TEST !== 'true' }, async t => {
  const { request, candidate } = await recipe();
  const docker = dockerWorkflowFromEnvironment({ FORGEWEB_DOCKER_ENABLED: 'true' });
  try {
    const validation = await new ForgeWebCandidateValidator().validate(request, candidate, docker.options.validationRunner);
    assert.ok(validation.ok);
    for (const check of validation.value.checks) t.diagnostic(`${check.id}: ${check.status}`);
    assert.equal(validation.value.status, 'passed');
  } finally { await docker.dispose(); }
});
