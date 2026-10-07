import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRequirements } from '../generation/nexarch/upstream/planning.ts';
import { buildSpec } from '../generation/nexarch/upstream/modules/analysis/lib/spec-builder.ts';
import { extractFeatures } from '../generation/nexarch/upstream/modules/analysis/lib/feature-extractor.ts';
import { detectIntent } from '../generation/nexarch/upstream/modules/analysis/lib/intent-detector.ts';
import { normalize } from '../generation/nexarch/upstream/modules/analysis/lib/normalize.ts';
import { NexArchPlanningAdapter, NEXARCH_POSTGRESQL_PLANNING_PROFILE } from '../generation/nexarch/adapter.ts';
import { planPrompt } from '../generation/planning.ts';
import { fileManifestDigest } from '../generation/contract.ts';

const PROMPTS = {
  recipe: 'Build a recipe management application. Users can create, edit, and view recipes. Each recipe has title, ingredients, preparation steps, cooking time, difficulty, and category. No payments are required.',
  attendance: 'Build a student attendance management system. Teachers can record and view attendance for students in classes. Attendance should have date and status.',
  task: 'Build a task management application. Users can create, edit, assign, and complete tasks. Tasks have title, description, status, priority, and due date.',
  payment: 'Build an invoice management application where customers can pay invoices online.',
  sms: 'Build a task management application. The application must not send SMS notifications.',
};

function spec(prompt: string) {
  return buildSpec(prompt, normalize(prompt), detectIntent(prompt).profile, extractFeatures(prompt));
}

function fieldNames(prompt: string, module: string) {
  return spec(prompt).semantics!.fields.filter(field => field.modules.includes(module)).map(field => field.name).sort();
}

function operations(prompt: string, module: string) {
  return spec(prompt).semantics!.operations.filter(operation => operation.modules.includes(module)).map(operation => operation.action).sort();
}

async function design(prompt: string) {
  const result = await planPrompt(new NexArchPlanningAdapter(), {
    scope: { projectId: 'raw-prompt-project', buildId: 'raw-prompt-build', operationId: 'raw-prompt-analysis', actor: { kind: 'authenticated', subjectId: 'owner', ownerId: 'owner' } },
    base: { kind: 'empty', projectId: 'raw-prompt-project', files: [], manifestDigest: fileManifestDigest([]) },
    prompt, databaseDialect: 'postgresql', options: { targetProfile: NEXARCH_POSTGRESQL_PLANNING_PROFILE, maxFiles: 300, maxTotalBytes: 3_000_000 },
  });
  assert.ok(result.ok);
  assert.equal(result.value.state, 'proposed');
  const semantics = result.value.analysis.facets!.semantics!;
  assert.deepEqual(result.value.architecture!.semantics, semantics);
  assert.deepEqual(result.value.database!.semantics, semantics);
  return semantics.design!;
}

test('the raw recipe audit prompt extracts all six fields and the requested operations without metadata injection', async () => {
  const result = await design(PROMPTS.recipe);
  assert.equal(result.projectType, 'Recipe Management');
  const recipe = result.entities.find(entity => entity.name === 'Recipes')!;
  assert.deepEqual(recipe.fields.map(field => field.name).sort(), ['title', 'ingredients', 'preparationSteps', 'cookingTime', 'difficulty', 'category'].sort());
  assert.deepEqual(recipe.operations.map(operation => operation.action).sort(), ['create', 'read', 'update']);
  assert.ok(result.exclusions.some(item => item.name === 'Payments'));
  assert.ok(!result.capabilities.some(item => item.name === 'Payment Gateway' && item.intent === 'requested'));
});

test('the raw attendance audit prompt preserves date/status, record/view, roles and stable entity binding', async () => {
  const result = await design(PROMPTS.attendance);
  assert.equal(result.projectType, 'Student Attendance');
  for (const name of ['Students', 'Classes', 'AttendanceRecords']) assert.ok(result.entities.some(entity => entity.name === name));
  const attendance = result.entities.find(entity => entity.name === 'AttendanceRecords')!;
  assert.deepEqual(attendance.fields.map(field => field.name).sort(), ['date', 'status']);
  assert.deepEqual(attendance.operations.map(operation => operation.name).sort(), ['record', 'view']);
  assert.deepEqual(result.roles.map(role => role.name), ['Admin', 'Teacher', 'Student']);
  assert.equal(result.modules.find(module => module.name === 'Attendance')!.entity, 'AttendanceRecords');
});

test('the raw task audit prompt preserves title and completion without claiming domain operations are implemented', async () => {
  const result = await design(PROMPTS.task);
  assert.equal(result.projectType, 'Task Management');
  const task = result.entities.find(entity => entity.name === 'Tasks')!;
  assert.deepEqual(task.fields.map(field => field.name).sort(), ['title', 'description', 'status', 'priority', 'dueDate'].sort());
  assert.deepEqual(task.operations.map(operation => operation.name).sort(), ['create', 'edit', 'assign', 'complete', 'read'].sort());
  assert.equal(task.operations.find(operation => operation.name === 'read')!.source, 'inferred');
  for (const name of ['assign', 'complete']) assert.ok(task.operations.some(operation => operation.name === name && operation.support === 'unsupported'));
  assert.ok(!task.operations.some(operation => operation.action === 'delete'));
});

test('positive invoice/payment intent remains positive in the real design contract', async () => {
  const result = await design(PROMPTS.payment);
  for (const name of ['Payments', 'Invoices']) assert.ok(result.entities.some(entity => entity.name === name));
  assert.ok(result.capabilities.some(item => item.name === 'Payment Gateway' && item.intent === 'requested' && item.support === 'unsupported'));
  assert.ok(!result.exclusions.some(item => item.name === 'Payments'));
  const direct = spec('Customers can pay invoices online.');
  assert.ok(direct.integrations.includes('Payment Gateway'));
  assert.ok(direct.database.includes('Payments') && direct.database.includes('Invoices'));
});

test('the raw SMS audit prompt produces negative evidence without a positive capability', async () => {
  const result = await design(PROMPTS.sms);
  assert.ok(result.exclusions.some(item => item.name === 'SMS'));
  assert.ok(result.capabilities.some(item => item.name === 'SMS' && item.intent === 'excluded'));
  assert.ok(!result.capabilities.some(item => item.name === 'SMS' && item.intent === 'requested'));
});

test('active completion verbs differ from completed status values', () => {
  assert.deepEqual(operations('Users can complete tasks.', 'Tasks'), ['complete']);
  for (const prompt of ['Tasks have a completed status.', 'Tasks have status completed.', 'Tasks have status complete.', 'Tasks have a status of marked complete.', 'Tasks are complete.']) {
    assert.ok(!operations(prompt, 'Tasks').includes('complete'), prompt);
  }
  assert.deepEqual(fieldNames('Tasks have a completed status.', 'Tasks'), ['status']);
});

test('finish and mark-complete commands canonicalize to complete without inventing record operations', () => {
  for (const prompt of ['Users can finish tasks.', 'Finish tasks.', 'Users can mark tasks as complete.', 'Mark tasks complete.', 'Tasks can be marked complete.', 'Mark completed tasks.']) {
    assert.deepEqual(operations(prompt, 'Tasks'), ['complete'], prompt);
  }
  assert.deepEqual(operations('Teachers can mark attendance.', 'Attendance'), ['record']);
});

test('inline field declaration subjects take precedence over field names that also name modules', () => {
  const category = spec('Each recipe has a category.');
  assert.deepEqual(category.semantics!.fields.find(field => field.name === 'category')!.modules, ['Recipes']);
  assert.deepEqual(fieldNames('Each task has a priority.', 'Tasks'), ['priority']);
  assert.deepEqual(fieldNames('Attendance should have date and status.', 'Attendance'), ['date', 'status']);
});

test('bullet fields retain the explicit owner heading, including category', () => {
  const prompt = 'Build a recipe management application.\nEach recipe has:\n- title\n- ingredients\n- preparation steps\n- cooking time\n- difficulty\n- category';
  assert.deepEqual(fieldNames(prompt, 'Recipes'), ['title', 'ingredients', 'preparation steps', 'cooking time', 'difficulty', 'category'].sort());
  const category = spec(prompt).semantics!.evidence.find(item => item.kind === 'field' && item.label === 'category')!;
  assert.equal(category.clause, '- category');
  assert.equal(category.fieldContext, 'each recipe');
  assert.equal(category.polarity, 'included');
});

test('repeated bullet clauses retain separate owners rather than sharing a global field scope', () => {
  const result = spec('Build a recipe and task application.\nRecipe fields:\n- title\n- description\nTask fields:\n- title\n- status');
  assert.deepEqual(result.semantics!.fields.find(item => item.name === 'title')!.modules.sort(), ['Recipes', 'Tasks']);
  assert.deepEqual(result.semantics!.fields.find(item => item.name === 'description')!.modules, ['Recipes']);
  assert.deepEqual(result.semantics!.fields.find(item => item.name === 'status')!.modules, ['Tasks']);
  assert.deepEqual(result.semantics!.evidence.filter(item => item.kind === 'field' && item.label === 'title').map(item => item.fieldContext), ['recipe', 'task']);
});

test('a new sentence resets list context and vocabulary alone does not assign fields globally', () => {
  const result = spec('Build a recipe and task application.\nRecipe fields:\n- title\nThe dashboard shows progress.\n- description');
  assert.ok(!result.semantics!.fields.some(item => item.name === 'description'));
  assert.deepEqual(spec('Build a recipe and task application. Title, description and priority.').semantics!.fields, []);
});

test('separate entity declarations in one sentence do not cross-assign common fields', () => {
  const prompt = 'Recipes have title and ingredients, and tasks have description and priority.';
  assert.deepEqual(fieldNames(prompt, 'Recipes'), ['ingredients', 'title']);
  assert.deepEqual(fieldNames(prompt, 'Tasks'), ['description', 'priority']);
});

test('field and completion exclusions retain owner scope and win over positive mentions', () => {
  const result = spec('Recipes have title. Tasks have title. Recipes must not have title. Users can complete tasks but must not complete tasks.');
  assert.deepEqual(result.semantics!.fields.find(field => field.name === 'title')!.modules, ['Tasks']);
  assert.ok(!result.semantics!.operations.some(operation => operation.action === 'complete'));
  assert.ok(result.modules.includes('Recipes') && result.modules.includes('Tasks'));
  assert.ok(result.semantics!.exclusions.some(item => item.kind === 'operation' && item.label === 'complete' && item.modules?.includes('Tasks')));
});

test('negated bullets apply only to their declared owner', () => {
  const result = spec('Build a recipe and task application.\nRecipes have:\n- title\nTasks have:\n- title\n- no title');
  assert.deepEqual(result.semantics!.fields.find(field => field.name === 'title')!.modules, ['Recipes']);
  assert.deepEqual(result.semantics!.exclusions.find(item => item.kind === 'field' && item.label === 'title')!.modules, ['Tasks']);
});

test('payment negation variants still override domain and capability defaults', () => {
  for (const negative of ['We do not need payments.', 'Payments are not required.', 'No payment gateway is required.']) {
    const result = spec(`Build an ecommerce application. ${negative}`);
    assert.ok(!result.modules.includes('Payments'), negative);
    assert.ok(!result.integrations.includes('Payment Gateway'), negative);
    assert.ok(!result.database.includes('Payments') && !result.database.includes('Invoices'), negative);
    assert.ok(result.semantics!.evidence.some(item => item.polarity === 'excluded' && item.label === 'Payment Gateway'));
  }
});

test('new completion vocabulary preserves entity inclusion and negation boundaries', () => {
  const result = spec('Users must not complete tasks, but can edit tasks.');
  assert.ok(result.modules.includes('Tasks'));
  assert.ok(!operations('Users must not complete tasks, but can edit tasks.', 'Tasks').includes('complete'));
  assert.ok(result.semantics!.operations.some(item => item.action === 'edit'));
  const mixed = spec('No payments and complete tasks.');
  assert.ok(mixed.modules.includes('Tasks') && !mixed.modules.includes('Payments'));
  assert.ok(mixed.semantics!.operations.some(item => item.action === 'complete'));
});

test('new field vocabulary uses word boundaries and module allowlists rather than inventing entities', () => {
  assert.ok(!extractFeatures('The titlecase dater completes taskforce.').evidence.some(item => item.kind === 'field' || item.kind === 'operation'));
  assert.deepEqual(fieldNames('Tasks have a due date.', 'Tasks'), ['due date']);
  assert.ok(!spec('Tasks have a date.').semantics!.fields.some(item => item.name === 'date'));
  assert.ok(!spec('Recipes have an imaginary widget.').database.includes('Widgets'));
});

test('raw extraction is deterministic and preserves unknown field properties', async () => {
  for (const prompt of Object.values(PROMPTS)) assert.deepEqual(analyzeRequirements(prompt), analyzeRequirements(prompt));
  const contract = await design(PROMPTS.recipe);
  for (const field of contract.entities.find(entity => entity.name === 'Recipes')!.fields) {
    assert.equal(field.source, 'known');
    assert.equal(field.category, undefined);
    assert.equal(field.required, undefined);
    assert.equal(field.searchable, undefined);
    assert.equal(field.relationTarget, undefined);
  }
});
