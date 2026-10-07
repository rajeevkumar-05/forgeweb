import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../lib.ts';
import { JsonStore } from '../store.ts';
import { PlanningApprovalService } from '../generation/approval.ts';
import { fileManifestDigest, prepareGenerationRequest } from '../generation/contract.ts';
import type { GenerationRequest, PlanningRequest } from '../generation/engine.ts';
import { planPrompt } from '../generation/planning.ts';
import type { PlanningSpecification } from '../generation/planning.ts';
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from '../generation/nexarch/adapter.ts';
import { NexArchBackendAdapter, upstreamArchitecture, upstreamDatabase, upstreamRequirements } from '../generation/nexarch/backend-adapter.ts';
import { NexArchFrontendAdapter } from '../generation/nexarch/frontend-adapter.ts';
import * as planning from '../generation/nexarch/upstream/planning.ts';
import type { RequirementSemantics, SemanticDesign, SemanticField } from '../generation/nexarch/upstream/shared/types/requirement.ts';
import { generateBackend } from '../generation/nexarch/upstream/modules/backend-generator/backend-generator.service.ts';
import { buildProjectModel as backendModel } from '../generation/nexarch/upstream/modules/backend-generator/lib/project-model.ts';
import { generateFrontend } from '../generation/nexarch/upstream/modules/frontend-generator/frontend-generator.service.ts';
import { buildProjectModel as frontendModel } from '../generation/nexarch/upstream/modules/frontend-generator/lib/project-model.ts';

type Mutable<T> = T extends readonly [] ? [] : T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;

const AUDIT_PROMPTS = {
  recipe: 'Build a recipe management application.\n\nUsers can create, edit, and view recipes.\n\nEach recipe has:\n- title\n- ingredients\n- preparation steps\n- cooking time\n- difficulty\n- category\n\nNo payments are required.',
  attendance: 'Build a student attendance management system.\n\nTeachers can record and view attendance for students in classes.\nAttendance should have date and status.',
  task: 'Build a task management application.\n\nUsers can create, edit, assign, and complete tasks.\nTasks have title, description, status, priority, and due date.',
  payment: 'Build an invoice management application where customers can pay invoices online.',
  sms: 'Build a task management application. The application must not send SMS notifications.',
};

function input(prompt: string): PlanningRequest {
  return {
    scope: { projectId: 'semantic-project', buildId: 'semantic-build', operationId: 'semantic-operation', actor: { kind: 'authenticated', subjectId: 'semantic-owner', ownerId: 'semantic-owner' } },
    base: { kind: 'empty', projectId: 'semantic-project', files: [], manifestDigest: fileManifestDigest([]) },
    prompt, databaseDialect: 'postgresql',
    options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 300, maxTotalBytes: 3_000_000 },
  };
}

async function proposal(prompt: string, supply?: (design: SemanticDesign) => void): Promise<PlanningSpecification> {
  const initial = await planPrompt(new NexArchPlanningAdapter(), input(prompt));
  assert.ok(initial.ok && initial.value.state === 'proposed');
  if (!supply) return initial.value;
  // Explicit structured input tests contract capacity, not new NLP extraction.
  const analyzed = planning.analyzeRequirements(prompt);
  assert.equal(analyzed.status, 'COMPLETE');
  if (analyzed.status !== 'COMPLETE') throw new Error('Incomplete fixture');
  const semantics = structuredClone(initial.value.analysis.facets!.semantics!) as RequirementSemantics;
  supply(semantics.design!);
  analyzed.spec.semantics = semantics;
  const result = await planPrompt(new NexArchPlanningAdapter({ ...planning, analyzeRequirements: () => structuredClone(analyzed) }), input(prompt));
  assert.ok(result.ok && result.value.state === 'proposed');
  return result.value;
}

function requestFrom(p: PlanningSpecification): GenerationRequest {
  const f = p.analysis.facets!;
  const specification: GenerationRequest['approved']['specification'] = {
    id: 'semantic-spec', projectId: p.scope.projectId, version: 1, status: 'approved', prompt: p.prompt,
    productName: f.productName, projectType: f.projectType, summary: p.prompt, roles: [...f.roles], entities: [...f.entities],
    authentication: [...f.authentication], integrations: [...f.integrations], constraints: [...(f.constraints ?? [])],
    semantics: structuredClone(f.semantics) as RequirementSemantics,
    requirements: p.analysis.proposedRequirements.map((requirement, index) => ({ ...structuredClone(requirement), acceptanceCriteria: [...requirement.acceptanceCriteria], id: `REQ-${String(index + 1).padStart(3, '0')}` })),
    assumptions: [...f.missingRequirements], architecture: structuredClone(p.architecture!.projection),
    createdAt: '2026-01-01T00:00:00.000Z', confirmedAt: '2026-01-02T00:00:00.000Z',
  };
  const design = { architecture: p.architecture!, database: p.database! };
  return prepareGenerationRequest({ scope: p.scope, base: input(p.prompt).base, options: input(p.prompt).options, design,
    approved: { specification, digest: digest(JSON.stringify(specification)), planDigest: digest(JSON.stringify(design)), planId: 'semantic-plan', bindingDigest: 'semantic-binding' } });
}

async function capture(p: PlanningSpecification) {
  const request = requestFrom(p);
  let backend!: ReturnType<typeof backendModel>;
  let frontend!: ReturnType<typeof frontendModel>;
  let openapi!: Parameters<typeof generateBackend>[4];
  const b = await new NexArchBackendAdapter((...args) => {
    openapi = args[4];
    backend = backendModel(args[0], args[1], args[2], args[4], args[5], args[6]);
    return generateBackend(...args);
  }).generate(request);
  assert.ok(b.ok);
  const f = await new NexArchFrontendAdapter((...args) => {
    frontend = frontendModel(args[0], args[1], args[2], args[3], args[4], args[5]);
    return generateFrontend(...args);
  }).generate(request, b.value);
  assert.ok(f.ok);
  for (const semantics of [p.architecture!.semantics, p.database!.semantics, request.approved.specification.semantics, upstreamRequirements(request).semantics, upstreamArchitecture(request, upstreamDatabase(request)).semantics, upstreamDatabase(request).semantics, backend.semantics, frontend.semantics]) {
    assert.deepEqual(semantics, p.analysis.facets!.semantics);
  }
  return { request, backend, frontend, openapi, b: b.value, f: f.value };
}

function fields(names: string[]): SemanticField[] {
  return names.map(name => ({ name, source: 'known', label: name }));
}

test('real recipe facts survive architecture, database and both generator inputs with column emission', async () => {
  const p = await proposal(AUDIT_PROMPTS.recipe);
  const c = await capture(p);
  const entity = p.analysis.facets!.semantics!.design!.entities.find(entity => entity.name === 'Recipes')!;
  assert.deepEqual(entity.fields.map(field => field.name), ['title', 'ingredients', 'preparationSteps', 'cookingTime', 'difficulty', 'category']);
  assert.deepEqual(c.backend.modules.find(module => module.entity?.entity === 'Recipes')?.semantic, entity);
  assert.deepEqual(c.frontend.pages.find(page => page.entity?.entity === 'Recipes')?.semantic, entity);
  assert.ok(p.database!.entities.find(entity => entity.name === 'Recipes')!.fields.some(field => field.name === 'ingredients'));
  assert.equal(entity.fields[0].category, undefined);
  assert.equal(entity.fields[0].required, undefined);
  assert.equal(entity.fields[0].searchable, undefined);
});

test('supplied typed recipe fields and known field attributes survive every design boundary', async () => {
  const p = await proposal(AUDIT_PROMPTS.recipe, design => {
    const recipe = design.entities.find(entity => entity.name === 'Recipes')!;
    recipe.description = 'Recipes authored by home cooks';
    recipe.fields = fields(['title', 'ingredients', 'preparationSteps', 'cookingTime', 'difficulty', 'category']);
    Object.assign(recipe.fields[0], { category: 'string', required: true, searchable: true, description: 'Recipe title' });
    Object.assign(recipe.fields[5], { category: 'relation', relationTarget: 'Categories', required: false });
    recipe.relationships.push({ target: 'Categories', field: 'category', source: 'known' });
  });
  const c = await capture(p);
  assert.deepEqual(c.frontend.pages.find(page => page.name === 'Recipes')!.semantic, p.analysis.facets!.semantics!.design!.entities.find(entity => entity.name === 'Recipes'));
});

test('recipe create/read/update intent does not acquire delete at backend or frontend design input', async () => {
  const c = await capture(await proposal(AUDIT_PROMPTS.recipe));
  for (const semantic of [c.backend.modules.find(module => module.entity?.entity === 'Recipes')!.semantic!, c.frontend.pages.find(page => page.name === 'Recipes')!.semantic!]) {
    assert.deepEqual(semantic.operations.map(operation => operation.action).sort(), ['create', 'read', 'update']);
    assert.equal(semantic.operationPolicy, 'explicit');
    assert.ok(!semantic.operations.some(operation => operation.action === 'delete'));
  }
});

test('supplied task fields and assign/complete intent survive without claiming domain operations implemented', async () => {
  const p = await proposal(AUDIT_PROMPTS.task, design => {
    const task = design.entities.find(entity => entity.name === 'Tasks')!;
    task.fields = fields(['title', 'description', 'status', 'priority', 'dueDate', 'assignee']);
    assert.ok(task.operations.some(operation => operation.name === 'complete' && operation.support === 'unsupported'));
  });
  const c = await capture(p);
  const task = c.frontend.pages.find(page => page.name === 'Tasks')!.semantic!;
  assert.deepEqual(task.fields.map(field => field.name), ['title', 'description', 'status', 'priority', 'dueDate', 'assignee']);
  for (const name of ['assign', 'complete']) assert.ok(task.operations.some(operation => operation.name === name && operation.support === 'unsupported'));
});

test('real task title and complete intent survive alongside the inferred assignment relationship', async () => {
  const c = await capture(await proposal(AUDIT_PROMPTS.task));
  const task = c.backend.modules.find(module => module.entity?.entity === 'Tasks')!.semantic!;
  assert.deepEqual(task.fields.map(field => field.name), ['title', 'description', 'status', 'dueDate', 'priority']);
  assert.deepEqual(task.relationships, [{ target: 'Users', field: 'assigneeId', kind: 'many-to-one', source: 'inferred' }]);
  assert.ok(task.operations.some(operation => operation.name === 'complete' && operation.support === 'unsupported'));
});

test('supplied attendance date/status/student facts reach table and generator design inputs', async () => {
  const p = await proposal(AUDIT_PROMPTS.attendance, design => {
    const attendance = design.entities.find(entity => entity.name === 'AttendanceRecords')!;
    attendance.fields = fields(['date', 'status', 'student']);
    Object.assign(attendance.fields[2], { category: 'relation', relationTarget: 'Students' });
  });
  const c = await capture(p);
  assert.deepEqual(c.backend.modules.find(module => module.className === 'Attendance')!.semantic!.fields.map(field => field.name), ['date', 'status', 'student']);
  assert.deepEqual(c.frontend.pages.find(page => page.name === 'Attendance')!.semantic!.fields.map(field => field.name), ['date', 'status', 'student']);
});

test('Attendance binds to AttendanceRecords by stable identity in OpenAPI and both design models', async () => {
  const p = await proposal(`${AUDIT_PROMPTS.attendance} Teachers can create attendance records.`);
  const c = await capture(p);
  const architecture = upstreamArchitecture(c.request, upstreamDatabase(c.request));
  assert.equal(architecture.apiModules.find(module => module.module === 'Attendance')!.entity, 'AttendanceRecords');
  assert.equal(c.backend.modules.find(module => module.className === 'Attendance')!.entity!.entity, 'AttendanceRecords');
  assert.equal(c.frontend.pages.find(page => page.name === 'Attendance')!.entity!.entity, 'AttendanceRecords');
  assert.ok(c.b.routes.filter(route => route.feature === 'Attendance').every(route => route.entity === 'AttendanceRecords'));
  assert.equal(c.openapi.paths['/attendance'].post!.requestBody!.content['application/json'].schema.$ref, '#/components/schemas/AttendanceRecordsCreateInput');
});

test('Admin/User roles survive specification, typed contract and both design models', async () => {
  const c = await capture(await proposal(AUDIT_PROMPTS.recipe));
  assert.deepEqual(c.request.approved.specification.roles, ['Admin', 'User']);
  assert.deepEqual(c.backend.roles, ['Admin', 'User']);
  assert.deepEqual(c.frontend.roles, ['Admin', 'User']);
  assert.deepEqual(c.backend.semantics!.design!.roles.map(role => role.name), ['Admin', 'User']);
});

test('payment/gateway/invoice/SMS exclusions survive all boundaries as explicit negative intent', async () => {
  const c = await capture(await proposal(`${AUDIT_PROMPTS.recipe} The application must not include SMS.`));
  const design = c.frontend.semantics!.design!;
  for (const [kind, name] of [['module', 'Payments'], ['integration', 'Payment Gateway'], ['entity', 'Invoices'], ['integration', 'SMS']]) {
    assert.ok(design.exclusions.some(item => item.kind === kind && item.name === name));
  }
  assert.ok(design.capabilities.some(capability => capability.name === 'SMS' && capability.intent === 'excluded'));
  assert.ok(!c.b.entities.some(entity => entity.name === 'Payments' || entity.name === 'Invoices'));
});

test('positive payments stay requested but unsupported, not excluded or implemented', async () => {
  const c = await capture(await proposal(AUDIT_PROMPTS.payment));
  assert.ok(c.frontend.semantics!.design!.capabilities.some(item => item.name === 'Payment Gateway' && item.intent === 'requested' && item.support === 'unsupported'));
  assert.ok(upstreamRequirements(c.request).integrations.includes('Payment Gateway'));
  assert.ok(!c.frontend.semantics!.design!.exclusions.some(item => item.name === 'Payments'));
  assert.equal(c.b.routes.find(route => route.path.endsWith('/payments/checkout'))?.status, 'stub');
});

test('positive and excluded SMS remain distinguishable from not requested', async () => {
  const positive = await capture(await proposal('Build a task management application. Send SMS notifications to users.'));
  const negative = await capture(await proposal(AUDIT_PROMPTS.sms));
  const absent = await capture(await proposal(AUDIT_PROMPTS.task));
  assert.ok(positive.frontend.semantics!.design!.capabilities.some(item => item.name === 'SMS' && item.intent === 'requested' && item.support === 'unsupported'));
  assert.ok(upstreamRequirements(positive.request).integrations.includes('SMS'));
  assert.ok(negative.frontend.semantics!.design!.capabilities.some(item => item.name === 'SMS' && item.intent === 'excluded'));
  assert.ok(!absent.frontend.semantics!.design!.capabilities.some(item => item.name === 'SMS'));
});

test('Authentication is canonical while frontend still requires actual implemented auth capabilities', async () => {
  const c = await capture(await proposal(AUDIT_PROMPTS.task));
  assert.ok(c.backend.modules.some(module => module.className === 'Authentication' && module.basePath === '/auth'));
  assert.ok(c.b.routes.filter(route => route.path.startsWith('/api/v1/auth/')).every(route => route.feature === 'Authentication'));
  assert.ok(!c.frontend.pages.some(page => page.name === 'Auth'));
  assert.equal(c.frontend.authEnabled, true);
  assert.ok(c.f.api.generatedCalls.some(call => call.path.startsWith('/api/v1/auth/')));
  assert.equal(c.frontend.pages.find(page => page.name === 'Tasks')!.implemented, true);
  assert.ok(c.frontend.pages.find(page => page.name === 'Tasks')!.semantic!.operations.some(operation => operation.action === 'read' && operation.source === 'inferred'));
});

test('explicitly excluded operations and unspecified operations are not positive CRUD defaults', async () => {
  const denied = await capture(await proposal('Build a recipe management application. Users can view recipes but must not delete recipes.'));
  assert.ok(denied.backend.modules.find(module => module.entity?.entity === 'Recipes')!.semantic!.operations.some(operation => operation.name === 'delete' && operation.intent === 'excluded'));
  const unspecified = await capture(await proposal(AUDIT_PROMPTS.sms));
  assert.equal(unspecified.frontend.pages.find(page => page.name === 'Tasks')!.semantic!.operationPolicy, 'unspecified');
  assert.deepEqual(unspecified.frontend.pages.find(page => page.name === 'Tasks')!.semantic!.operations, []);
});

test('legacy requests without semantic metadata remain valid and keep the canonical auth boundary', async () => {
  const request = structuredClone(requestFrom(await proposal(AUDIT_PROMPTS.task))) as Mutable<GenerationRequest>;
  const specification = structuredClone(request.approved.specification);
  delete specification.semantics;
  const design = structuredClone(request.design);
  delete design.architecture.semantics;
  delete design.database!.semantics;
  for (const entity of design.database!.entities) delete entity.semantic;
  for (const endpoint of design.architecture.endpoints) { delete endpoint.module; delete endpoint.entity; }
  const legacy = { ...request, design, approved: { ...request.approved, specification, digest: digest(JSON.stringify(specification)), planDigest: digest(JSON.stringify(design)) } };
  const database = upstreamDatabase(prepareGenerationRequest(legacy));
  assert.equal(database.semantics, undefined);
  assert.equal(upstreamRequirements(legacy).semantics, undefined);
  assert.ok(upstreamArchitecture(legacy, database).apiModules.some(module => module.module === 'Authentication'));
  const b = await new NexArchBackendAdapter().generate(legacy);
  assert.ok(b.ok);
  assert.ok((await new NexArchFrontendAdapter().generate(legacy, b.value)).ok);
});

test('real durable approval and store reload preserve the exact semantic contract in GenerationRequest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeweb-semantic-contract-'));
  try {
    const store = new JsonStore(directory);
    await store.initialize();
    const p = await proposal(AUDIT_PROMPTS.recipe);
    await store.mutate(database => {
      database.projects[p.scope.projectId] = { id: p.scope.projectId, slug: 'semantic-project', name: 'Semantic', status: 'awaiting_confirmation', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', currentBuildId: p.scope.buildId };
      database.builds[p.scope.buildId] = { id: p.scope.buildId, projectId: p.scope.projectId, status: 'awaiting_confirmation', currentStageIndex: 1, stageDetail: 'Planning', stages: [], taskIds: [], filePaths: [], reviewFindings: [], validationChecks: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    });
    const verifyOwner = (_project: unknown, actor: PlanningRequest['scope']['actor']) => JSON.stringify(actor) === JSON.stringify(p.scope.actor);
    const approval = new PlanningApprovalService(store, verifyOwner);
    const engine = { name: 'nexarch-planning', version: '1', contractVersion: 'forgeweb-generation-v1' as const };
    const record = await approval.save(p, { kind: 'empty', manifestDigest: fileManifestDigest([]) }, engine, input(p.prompt).options);
    await approval.approve(record.id, record.digest, p.scope.projectId, p.scope.actor);
    const reloaded = new JsonStore(directory);
    await reloaded.initialize();
    const request = await new PlanningApprovalService(reloaded, verifyOwner).generationRequest(record.id, record.digest, p.scope.projectId, p.scope.actor);
    assert.deepEqual(request.approved.specification.semantics, p.analysis.facets!.semantics);
    assert.deepEqual(request.design.database!.semantics, p.analysis.facets!.semantics);
    assert.deepEqual(upstreamRequirements(request).constraints, p.analysis.facets!.constraints);
    assert.equal(request.approved.digest, digest(JSON.stringify(request.approved.specification)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('database planning rejects altered semantic architecture metadata', async () => {
  const adapter = new NexArchPlanningAdapter();
  const request = input(AUDIT_PROMPTS.recipe);
  const analysis = await adapter.analyzeRequirements(request);
  assert.ok(analysis.ok);
  const architecture = await adapter.planArchitecture({ ...request, analysis: analysis.value });
  assert.ok(architecture.ok);
  const altered = structuredClone(architecture.value) as Mutable<typeof architecture.value>;
  altered.semantics!.design!.entities.find(entity => entity.name === 'Recipes')!.fields.length = 0;
  const result = await adapter.designDatabase({ ...request, analysis: analysis.value, architecture: altered });
  assert.equal(result.ok, false);
});
