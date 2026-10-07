import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRequirements } from "../generation/nexarch/upstream/planning.ts";
import { extractFeatures } from "../generation/nexarch/upstream/modules/analysis/lib/feature-extractor.ts";
import { detectIntent } from "../generation/nexarch/upstream/modules/analysis/lib/intent-detector.ts";
import { buildSpec } from "../generation/nexarch/upstream/modules/analysis/lib/spec-builder.ts";
import { normalize } from "../generation/nexarch/upstream/modules/analysis/lib/normalize.ts";

function spec(prompt: string) {
  return buildSpec(prompt, normalize(prompt), detectIntent(prompt).profile, extractFeatures(prompt));
}

test("recipe, task and student attendance vocabulary identify their own domains", () => {
  for (const [prompt, domain, entity] of [
    ["Build a recipe management application.", "recipe", "Recipes"],
    ["Build a task management application.", "task", "Tasks"],
    ["Build a student attendance management system.", "attendance", "AttendanceRecords"],
    ["Create a cookbook for home cooks.", "recipe", "Recipes"],
    ["Build a todo application.", "task", "Tasks"],
    ["Teachers record class attendance.", "attendance", "Students"],
  ]) {
    assert.equal(detectIntent(prompt).profile?.id, domain);
    const result = analyzeRequirements(prompt);
    assert.equal(result.status, "COMPLETE");
    if (result.status === "COMPLETE") {
      assert.ok(result.spec.database.includes(entity));
      assert.ok(!result.spec.database.includes("Invoices"));
      assert.ok(!result.spec.modules.includes("Payments"));
    }
  }
});

test("explicit roles, recipe operations and fields survive specification construction", () => {
  const result = spec("Users can create and edit recipes. There are two roles: Admin and User. Each recipe has a name, description, ingredients, cooking steps, cooking time, difficulty and category.");
  assert.deepEqual(result.roles, ["Admin", "User"]);
  assert.ok(result.database.includes("Users") && result.database.includes("Recipes"));
  assert.ok(result.semantics?.operations.some(item => item.action === "create" && item.modules.includes("Recipes")));
  assert.ok(result.semantics?.operations.some(item => item.action === "edit" && item.modules.includes("Recipes")));
  for (const field of ["name", "description", "ingredients", "preparation steps", "cooking time", "difficulty", "category"]) {
    assert.ok(result.semantics?.fields.some(item => item.name === field && item.modules.includes("Recipes")), field);
  }
  assert.deepEqual(spec("There are two roles: Admin and User.").roles, ["Admin", "User"]);
});

test("negative payments and SMS are excluded and never count as positive completeness signals", () => {
  for (const prompt of ["No payments are required.", "We do not need a payment gateway.", "We don't need payments.", "No payments.", "Payments are not required.", "Payments aren't needed.", "The application must not include SMS."]) {
    const features = extractFeatures(prompt);
    assert.ok(!features.modules.includes("Payments"));
    assert.ok(!features.integrations.includes("Payment Gateway"));
    assert.ok(!features.integrations.includes("SMS"));
    assert.ok(features.evidence.some(item => item.polarity === "excluded"));
    const result = analyzeRequirements(prompt);
    assert.equal(result.status, "INCOMPLETE");
    if (result.status === "INCOMPLETE" && features.evidence.some(item => item.label === "Payments")) {
      assert.ok(!result.questions.includes("Does the application take payments?"));
    }
  }
});

test("explicit exclusions override domain defaults, including implied payment entities", () => {
  for (const prompt of ["Build a recipe management application. No payments are required.", "Build an ecommerce app with user accounts. No payments.", "Build a restaurant with user accounts, but no payment gateway."]) {
    const result = spec(prompt);
    assert.ok(!result.modules.includes("Payments") && !result.modules.includes("Billing"));
    assert.ok(!result.integrations.includes("Payment Gateway"));
    assert.ok(!result.database.includes("Payments") && !result.database.includes("Invoices"));
    assert.ok(result.constraints?.some(item => item.includes("Payment")));
  }
});

test("mixed clauses preserve positive operations without leaking negation", () => {
  const recipes = spec("Users can create and edit recipes, but no payments are required.");
  assert.ok(recipes.database.includes("Recipes"));
  assert.deepEqual(recipes.semantics?.operations.map(item => item.action), ["create", "edit"]);
  assert.ok(!recipes.modules.includes("Payments"));
  const payments = spec("The app supports payments but must not send SMS.");
  assert.ok(payments.modules.includes("Payments"));
  assert.ok(payments.integrations.includes("Payment Gateway"));
  assert.ok(!payments.integrations.includes("SMS"));
  const editable = spec("Recipes should be editable; payments are not needed.");
  assert.ok(editable.semantics?.operations.some(item => item.action === "edit"));
  assert.ok(!editable.modules.includes("Payments"));
  assert.ok(spec("Build a recipe app with no payments.").modules.includes("Recipes"));
});

test("positive payment and SMS vocabulary remains supported", () => {
  assert.ok(spec("Customers can pay invoices online.").modules.includes("Payments"));
  assert.ok(spec("Customers can pay invoices online.").database.includes("Invoices"));
  assert.ok(spec("The application supports payments.").integrations.includes("Payment Gateway"));
  const sms = spec("Send SMS notifications to users.");
  assert.ok(sms.integrations.includes("SMS"));
  assert.ok(sms.modules.includes("Notifications"));
});

test("explicit exclusion wins contradictions independently of mention order", () => {
  for (const prompt of ["Support payments. No payments.", "No payments. Support payments.", "Support SMS, but do not include SMS."]) {
    const result = spec(prompt);
    assert.ok(!result.modules.includes("Payments"));
    assert.ok(!result.integrations.includes("Payment Gateway") && !result.integrations.includes("SMS"));
    assert.ok(result.semantics?.evidence.some(item => item.polarity === "included"));
    assert.ok(result.semantics?.evidence.some(item => item.polarity === "excluded"));
  }
});

test("punctuation, coordination, contractions and boundaries retain feature scope", () => {
  for (const prompt of ["No payments, SMS or notifications.", "We don't need payments; send SMS notifications.", "No payments, users can create recipes.", "No payments and users can edit recipes.", "No payments: send SMS notifications."]) {
    const result = spec(prompt);
    assert.ok(!result.modules.includes("Payments"));
    if (prompt.includes("send SMS")) assert.ok(result.integrations.includes("SMS"));
    if (prompt.includes("recipes")) assert.ok(result.modules.includes("Recipes"));
  }
  assert.ok(spec("Not only payments but also SMS are supported.").integrations.includes("Payment Gateway"));
  assert.ok(spec("Not only payments but also SMS are supported.").integrations.includes("SMS"));
  assert.ok(!extractFeatures("The cartel uses smstools.").modules.includes("Cart"));
  assert.ok(!extractFeatures("The cartel uses smstools.").integrations.includes("SMS"));
  assert.ok(spec("No payments and librarians can create recipes.").modules.includes("Recipes"));
  assert.ok(spec("No payments, send SMS notifications.").integrations.includes("SMS"));
  assert.ok(!spec("No payments and SMS are required.").integrations.includes("SMS"));
});

test("negated domain mentions do not override the positively requested domain", () => {
  assert.equal(detectIntent("Build a recipe application, not an ecommerce application.").profile?.id, "recipe");
});

test("task and attendance operations and fields stay in planning semantics", () => {
  const tasks = spec("Users create, update, delete, view, assign and track tasks with task status, due dates and priorities.");
  for (const action of ["create", "edit", "delete", "view", "assign", "track"]) assert.ok(tasks.semantics?.operations.some(item => item.action === action && item.modules.includes("Tasks")), action);
  for (const field of ["status", "due date", "priority"]) assert.ok(tasks.semantics?.fields.some(item => item.name === field && item.modules.includes("Tasks")), field);
  const attendance = spec("Teachers mark attendance for students in classes and courses. Track attendance status.");
  for (const entity of ["Students", "Classes", "Courses", "AttendanceRecords"]) assert.ok(attendance.database.includes(entity), entity);
  assert.ok(attendance.semantics?.fields.some(item => item.name === "status" && item.modules.includes("Attendance")));
  assert.deepEqual(attendance.semantics?.operations.find(item => item.action === "record")?.modules, ["Attendance"]);
  const view = spec("Build a student attendance system. Students view attendance status.");
  assert.deepEqual(view.semantics?.operations.find(item => item.action === "view")?.modules, ["Attendance"]);
});

test("comma-separated recipe operations share Recipes, not a category field in another clause", () => {
  const result = spec("Build a recipe management application where users can create, edit, delete, search, and categorize recipes. Each recipe should have ingredients, cooking time, difficulty and category. No payments.");
  assert.equal(result.semantics?.operations.length, 5);
  for (const operation of result.semantics?.operations ?? []) assert.deepEqual(operation.modules, ["Recipes"]);
});

test("analysis/specification output is deterministic for identical prompts", () => {
  const prompt = "Users can create and edit recipes with ingredients and cooking time. No payments or SMS.";
  assert.deepEqual(analyzeRequirements(prompt), analyzeRequirements(prompt));
});

test("denying an operation does not exclude its entity or leak to another module", () => {
  const result = spec("Users can edit recipes and tasks, but must not edit tasks.");
  assert.ok(result.modules.includes("Recipes") && result.modules.includes("Tasks"));
  assert.ok(result.semantics?.operations.some(item => item.action === "edit" && item.modules.includes("Recipes") && !item.modules.includes("Tasks")));
  assert.ok(result.semantics?.exclusions.some(item => item.kind === "operation" && item.label === "edit" && item.modules?.includes("Tasks")));
  assert.ok(spec("No payments and create recipes.").modules.includes("Recipes"));
});
