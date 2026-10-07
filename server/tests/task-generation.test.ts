import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../store.ts';
import { PlanningApprovalService } from '../generation/approval.ts';
import { CandidateAssembler } from '../generation/candidate.ts';
import { fileManifestDigest } from '../generation/contract.ts';
import { ForgeWebCandidateValidator } from '../generation/validation.ts';
import { digest } from '../lib.ts';
import type { PlanningRequest } from '../generation/engine.ts';
import { planPrompt } from '../generation/planning.ts';
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from '../generation/nexarch/adapter.ts';
import { NexArchBackendAdapter, upstreamRequirements, upstreamDatabase } from '../generation/nexarch/backend-adapter.ts';
import { NexArchFrontendAdapter } from '../generation/nexarch/frontend-adapter.ts';
import { generateOpenApi } from '../generation/nexarch/upstream/modules/database-designer/lib/openapi-generator.ts';
import { semanticDesign } from '../generation/nexarch/semantic-design.ts';
import * as planning from '../generation/nexarch/upstream/planning.ts';

const PROMPT = 'Build a task management application.\n\nUsers can create, edit, assign, and complete tasks.\n\nEach task has title, description, status, priority, and due date.';
const FIELDS = ['title', 'description', 'status', 'priority', 'dueDate'];
async function generateTask() {
  const input: PlanningRequest = {
    scope: { projectId: 'task-project', buildId: 'task-build', operationId: 'task-operation', actor: { kind: 'authenticated', ownerId: 'task-owner', subjectId: 'task-owner' } },
    base: { kind: 'empty', projectId: 'task-project', files: [], manifestDigest: fileManifestDigest([]) },
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
      database.projects[input.scope.projectId] = { id: input.scope.projectId, slug: 'task-project', name: 'Task', status: 'awaiting_confirmation', currentBuildId: input.scope.buildId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      database.builds[input.scope.buildId] = { id: input.scope.buildId, projectId: input.scope.projectId, status: 'awaiting_confirmation', currentStageIndex: 1, stageDetail: 'Planning', stages: [], taskIds: [], filePaths: [], reviewFindings: [], validationChecks: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    });
    const approval = new PlanningApprovalService(store, (_project, actor) => actor.kind === 'authenticated' && actor.ownerId === 'task-owner' && actor.subjectId === 'task-owner');
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


let fixture: ReturnType<typeof generateTask> | undefined;
const task = () => fixture ??= generateTask();
function source(candidate: Awaited<ReturnType<typeof generateTask>>['candidate'], path: string) {
  const file = candidate.files.find(file => file.path === path);
  assert.ok(file, path);
  return file.content;
}
for (const field of FIELDS) {
  test(`raw Task emits ${field} in database, Prisma, DTO, validator and OpenAPI`, async () => {
    const { database, candidate, openapi } = await task();
    assert.ok(database.tables.find(table => table.entity === 'Tasks')!.columns.some(column => column.field === field));
    assert.match(source(candidate, 'backend/prisma/schema.prisma'), new RegExp('\\b' + field + '\\s+'));
    for (const path of ['dto/tasks.dto.ts', 'validators/tasks.validators.ts']) assert.match(source(candidate, 'backend/src/modules/tasks/' + path), new RegExp('\\b' + field + '\\??:'));
    for (const name of ['Tasks', 'TasksCreateInput', 'TasksUpdateInput']) assert.ok(Object.hasOwn(openapi.components.schemas[name].properties!, field));
  });
  test(`raw Task binds ${field} in the real form, list and detail`, async () => {
    const { candidate } = await task();
    assert.match(source(candidate, 'frontend/src/features/tasks/components/TaskForm.tsx'), new RegExp("register\\('" + field + "'\\)"));
    const page = source(candidate, 'frontend/src/features/tasks/TasksPage.tsx');
    assert.match(page, new RegExp("key: '" + field + "'"));
    assert.match(page, new RegExp('detailRecord\\.' + field + '\\b'));
  });
}
test('exact raw Task preserves five fields and every semantic boundary with inferred read', async () => {
  const { proposal, request, database, candidate } = await task();
  const semantics = proposal.analysis.facets!.semantics!;
  const entity = semantics.design!.entities.find(entity => entity.name === 'Tasks')!;
  assert.deepEqual(entity.fields.map(field => field.name).sort(), [...FIELDS].sort());
  assert.deepEqual(entity.operations.map(operation => operation.name).sort(), ['assign', 'complete', 'create', 'edit', 'read']);
  assert.equal(entity.operations.find(operation => operation.name === 'read')!.source, 'inferred');
  for (const value of [request.approved.specification.semantics, request.design.architecture.semantics, request.design.database!.semantics, database.semantics, upstreamRequirements(request).semantics]) assert.deepEqual(value, semantics);
  assert.deepEqual(JSON.parse(candidate.artifacts.find(artifact => artifact.kind === 'requirements')!.content).semantics, semantics);
  const columns = database.tables.find(table => table.entity === 'Tasks')!.columns;
  assert.ok(columns.every(column => FIELDS.includes(column.field) || ['id', 'createdAt', 'updatedAt', 'deletedAt', 'assigneeId'].includes(column.field)));
});
test('assignment relationship uses the generic optional foreign key, not an invented action', async () => {
  const { database } = await task();
  const column = database.tables.find(table => table.entity === 'Tasks')!.columns.find(column => column.field === 'assigneeId')!;
  assert.equal(column.nullable, true);
  assert.equal(column.references!.table, 'Users');
  assert.equal(column.references!.onDelete, 'SET NULL');
});
test('Task implements only CREATE READ UPDATE; no DELETE, assignment or completion endpoint/control', async () => {
  const { candidate, backend, frontend } = await task();
  const routes = backend.value.routes.filter(route => route.entity === 'Tasks');
  assert.deepEqual(routes.map(route => route.method + ' ' + route.path).sort(), ['GET /api/v1/tasks', 'GET /api/v1/tasks/:id', 'POST /api/v1/tasks', 'PUT /api/v1/tasks/:id']);
  assert.ok(routes.every(route => route.status === 'implemented'));
  assert.equal(frontend.value.pages.find(page => page.entity === 'Tasks')!.status, 'implemented');
  const calls = frontend.value.api.generatedCalls.filter(call => call.feature === 'Tasks');
  assert.deepEqual(calls.map(call => call.method + ' ' + call.path).sort(), routes.map(route => route.method + ' ' + route.path).sort());
  const page = source(candidate, 'frontend/src/features/tasks/TasksPage.tsx');
  assert.match(page, /Unsupported operations:/);
  assert.match(page, /assign, complete/);
  assert.doesNotMatch(page, /Assign Task|Complete Task|Delete Task|useDelete|useAssign|useComplete/);
  assert.doesNotMatch(source(candidate, 'backend/src/modules/tasks/routes/tasks.routes.ts'), /router\\.delete|\/assign|\/complete/);
  assert.match(source(candidate, 'frontend/src/content/site.ts'), /Requested but unsupported: Tasks: assign, Tasks: complete/);
  assert.doesNotMatch(source(candidate, 'frontend/src/content/site.ts'), /Users can assign tasks|Users can complete tasks/);
});

test('nullable relationship form sends null instead of an invalid empty UUID, while backend remains strict', async () => {
  const { candidate } = await task();
  assert.match(source(candidate, 'frontend/src/features/tasks/schema.ts'), /assigneeId: z\.string\(\)\.uuid\(\)\.or\(z\.literal\(''\)\)\.nullable\(\)\.optional\(\)/);
  assert.match(source(candidate, 'frontend/src/features/tasks/components/TaskForm.tsx'), /assigneeId: values\.assigneeId === '' \? null : values\.assigneeId/);
  assert.match(source(candidate, 'backend/src/modules/tasks/validators/tasks.validators.ts'), /assigneeId: z\.string\(\)\.uuid\(\)\.nullable\(\)\.optional\(\)/);
});

test('HTML date edit input receives the date portion of an API ISO timestamp', async () => {
  const { candidate } = await task();
  assert.match(source(candidate, 'frontend/src/features/tasks/components/TaskForm.tsx'), /dueDate: initialValues\?\.dueDate\?\.slice\(0, 10\)/);
  assert.match(source(candidate, 'backend/src/modules/tasks/validators/tasks.validators.ts'), /dueDate: z\.coerce\.date\(\)/);
});
test('editing implies READ generically, but an explicit exclusion remains authoritative', () => {
  for (const prompt of [
    'Build a recipe management application. Users can edit recipes.',
    'Build a recipe management application. Users can edit recipes but must not view recipes.',
  ]) {
    const result = planning.analyzeRequirements(prompt);
    assert.equal(result.status, 'COMPLETE');
    if (result.status !== 'COMPLETE') return;
    const design = semanticDesign(result.spec, []);
    const operations = design.entities.find(entity => entity.name === 'Recipes')!.operations;
    assert.equal(operations.some(operation => operation.action === 'read' && operation.intent === 'requested'), !prompt.includes('must not'));
  }
});
test('explicit structured write-only metadata is not expanded', async () => {
  const { request } = await task();
  const spec = upstreamRequirements(request);
  spec.semantics!.design!.entities.find(entity => entity.name === 'Tasks')!.operations = [{ name: 'edit', action: 'update', intent: 'requested', source: 'known', support: 'unverified' }];
  assert.deepEqual(semanticDesign(spec, []), spec.semantics!.design);
});
test('Task static semantic coverage passes and candidate assembly remains deterministic', async () => {
  const { request, candidate, backend, frontend } = await task();
  const report = await new ForgeWebCandidateValidator().validate(request, candidate);
  assert.ok(report.ok);
  assert.equal(report.value.checks.find(check => check.id === 'semantic-coverage')!.status, 'passed');
  assert.equal(report.value.status, 'unavailable');
  const again = new CandidateAssembler().assemble(request, backend, frontend);
  assert.ok(again.ok);
  assert.deepEqual(again.value, candidate);
});
for (const defect of ['missing entity', 'missing field', 'missing supported operation', 'unrequested delete', 'false unsupported action', 'changed semantic contract']) {
  test('semantic validator rejects ' + defect + ' before isolated execution', async () => {
    const { request, candidate } = await task();
    const malformed = structuredClone(candidate);
    const entities = malformed.assembly.evidence.backendEntities as unknown as { name: string; fields: string[] }[];
    const routes = malformed.assembly.capabilities.backendRoutes as unknown as { entity?: string; method: string; path: string; status: string }[];
    if (defect === 'missing entity') entities.splice(entities.findIndex(entity => entity.name === 'Tasks'), 1);
    if (defect === 'missing field') entities.find(entity => entity.name === 'Tasks')!.fields.splice(entities.find(entity => entity.name === 'Tasks')!.fields.indexOf('title'), 1);
    if (defect === 'missing supported operation') routes.splice(routes.findIndex(route => route.entity === 'Tasks' && route.method === 'POST'), 1);
    if (defect === 'unrequested delete') routes.push({ ...routes.find(route => route.entity === 'Tasks')!, method: 'DELETE' });
    if (defect === 'false unsupported action') routes.push({ ...routes.find(route => route.entity === 'Tasks')!, method: 'POST', path: '/api/v1/tasks/assign' });
    if (defect === 'changed semantic contract') {
      const artifact = malformed.artifacts.find(artifact => artifact.kind === 'requirements')!;
      const content = JSON.parse(artifact.content);
      content.semantics.design.entities.find((entity: { name: string }) => entity.name === 'Tasks').fields = [];
      Reflect.set(artifact, 'content', JSON.stringify(content));
      Reflect.set(artifact, 'digest', digest(artifact.content));
    }
    let executed = false;
    const report = await new ForgeWebCandidateValidator().validate(request, malformed, { async validate() { executed = true; throw new Error('MUST_NOT_RUN'); } });
    assert.ok(report.ok);
    assert.equal(report.value.status, 'failed');
    assert.equal(report.value.checks.find(check => check.id === 'semantic-coverage')!.status, 'failed');
    assert.equal(executed, false);
  });
}
