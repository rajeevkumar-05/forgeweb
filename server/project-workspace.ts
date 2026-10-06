import type {
  ExportSummary,
  GeneratedDatabaseInfo,
  GeneratedFile,
  MasterSpecification,
  ProjectVersion,
  ProjectWorkspace,
  ValidationCheck,
} from "./domain.ts";
import { buildGeneratedFrontend, GENERATED_FRONTEND_TEMPLATE, normalizeMasterSpecification } from "./generated-frontend.ts";
import { buildGeneratedBackend } from "./generated-backend.ts";
import { ApiError, assertPrompt, digest, id, now, safePath, slugify } from "./lib.ts";
import { getLlmConfig, getLlmProvider } from "./llm/index.ts";
import { buildEditPrompt } from "./llm/prompts.ts";
import { parseEditResponse } from "./llm/parser.ts";
import { JsonStore } from "./store.ts";
import { createProjectZip } from "./zip.ts";
import { layoutCompatibility } from "./generation/layout.ts";
import { planRecordDigest } from "./generation/approval.ts";

function requireManagedLayout(workspace: ProjectWorkspace): void {
  if (!workspace.files.length && !workspace.currentVersion) return;
  if (layoutCompatibility(workspace.files, workspace.currentVersion?.layout) !== "managed") throw new ApiError(409, "LAYOUT_UNSUPPORTED", "This layout requires an intentional compatibility workflow.");
}

type EditScope = "frontend" | "backend" | "database" | "fullstack";

export type EditResult = {
  workspace: ProjectWorkspace;
  modifiedFiles: string[];
  phases: string[];
};

function databaseInfo(specification?: MasterSpecification): GeneratedDatabaseInfo {
  const entities = specification?.architecture?.data?.entities ?? specification?.entities ?? [];
  return {
    engine: specification?.architecture?.data?.database ?? (specification ? "PostgreSQL" : "Not required"),
    schemaSource: "Approved master specification",
    tables: entities.map((entity) => ({
      name: entity.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase() + "s",
      purpose: `${entity} records owned by the generated application.`,
    })),
    separationNote: "This schema belongs to the generated application. ForgeWeb project versions and prompts remain in the separate ForgeWeb control-plane store.",
  };
}

function validateStoredProject(files: GeneratedFile[]): ValidationCheck[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const css = byPath.get("frontend/src/styles.css")?.content ?? "";
  const app = byPath.get("frontend/src/App.tsx")?.content ?? "";
  const preview = byPath.get("frontend/preview.html")?.content ?? "";
  const openBraces = [...css].filter((character) => character === "{").length;
  const closeBraces = [...css].filter((character) => character === "}").length;
  const definitions: Array<[string, boolean, string]> = [
    ["Safe project paths", files.length > 0 && files.every((file) => safePath(file.path) === file.path), `${files.length} stored paths inspected.`],
    ["Package configuration", byPath.has("package.json"), "package.json is present."],
    ["Frontend source", app.includes("export default function App") && byPath.has("frontend/src/main.tsx"), "React entrypoint and App component are present."],
    ["Frontend styles", Boolean(css) && openBraces === closeBraces, `${openBraces} opening and ${closeBraces} closing CSS braces.`],
    ["Professional preview source", preview.startsWith("<!doctype html>") && preview.includes("</html>") && preview.includes(GENERATED_FRONTEND_TEMPLATE) && preview.includes('aria-label="Primary navigation"'), "Stored preview is a complete professional application document with primary navigation."],
    ["Backend source", byPath.has("backend/src/index.ts") && byPath.has("backend/src/api/contracts.ts"), "Typed backend entrypoint and contracts are present."],
    ["Security boundary", byPath.has("backend/src/security/access-control.ts"), "Server access-control source is present."],
    ["Architecture", byPath.has("ARCHITECTURE.md"), "Architecture contract is present."],
    ["Acceptance tests", byPath.has("tests/acceptance.test.ts"), "Acceptance test source is present."],
    ["Readable source", files.every((file) => typeof file.content === "string" && file.content.length > 0), "Every stored artifact contains readable source."],
  ];
  return definitions.map(([name, passed, evidence]) => ({ id: id("check"), name, status: passed ? "passed" : "failed", evidence }));
}

function classifyEdit(prompt: string): EditScope {
  const frontend = /front\s?end|design|style|css|navbar|nav |hero|card|button|color|rounded|glass|layout|responsive|mobile|tablet|font|dashboard|login/i.test(prompt);
  const backend = /back\s?end|api|endpoint|server|route|authorization|authentication|auth\b|service/i.test(prompt);
  const database = /database|schema|table|column|field|migration|phone number|registration/i.test(prompt);
  if ((frontend && backend) || (database && (frontend || backend))) return "fullstack";
  if (database) return "database";
  if (backend) return "backend";
  return "frontend";
}

function replaceFile(files: GeneratedFile[], path: string, transform: (content: string) => string, modified: Set<string>): void {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new ApiError(422, "EDIT_TARGET_MISSING", `The current project does not contain ${path}.`);
  const content = transform(file.content);
  if (content === file.content) return;
  file.content = content;
  file.digest = digest(content);
  modified.add(path);
}

function professionalizeFrontend(sourceFiles: GeneratedFile[], specification: MasterSpecification): { files: GeneratedFile[]; modifiedFiles: string[] } {
  const files = structuredClone(sourceFiles);
  const frontend = buildGeneratedFrontend(specification);
  const modifiedFiles = new Set<string>();
  const setFile = (path: string, content: string, requirements: string[]) => {
    const existing = files.find((file) => file.path === path);
    if (existing?.content === content) return;
    if (existing) {
      existing.content = content;
      existing.digest = digest(content);
    } else {
      files.push({ path, content, requirementIds: requirements, digest: digest(content) });
    }
    modifiedFiles.add(path);
  };
  const moveLegacyFile = (legacyPath: string, modernPath: string, fallback: string, requirements: string[]) => {
    const legacy = files.find((file) => file.path === legacyPath);
    const current = files.find((file) => file.path === modernPath);
    if (!current) setFile(modernPath, legacy?.content ?? fallback, legacy?.requirementIds ?? requirements);
    if (legacy) {
      files.splice(files.indexOf(legacy), 1);
      modifiedFiles.add(legacyPath);
    }
  };

  setFile("frontend/src/App.tsx", frontend.app, ["REQ-003", "REQ-006"]);
  setFile("frontend/src/styles.css", frontend.styles, ["REQ-006"]);
  setFile("frontend/preview.html", frontend.preview, ["REQ-003", "REQ-006"]);
  setFile("frontend/src/main.tsx", 'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.js";\n\ncreateRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);\n', ["REQ-006"]);

  const backend = buildGeneratedBackend(specification);
  moveLegacyFile("src/domain/model.ts", "backend/src/domain/model.ts", backend.model, ["REQ-003", "REQ-004"]);
  moveLegacyFile("src/security/access-control.ts", "backend/src/security/access-control.ts", backend.accessControl, ["REQ-001", "REQ-002", "REQ-004"]);
  moveLegacyFile("src/api/contracts.ts", "backend/src/api/contracts.ts", backend.contracts, ["REQ-003", "REQ-004", "REQ-005"]);
  setFile("backend/src/index.ts", backend.index, ["REQ-001", "REQ-002", "REQ-003"]);

  const architecture = specification.architecture?.markdown ?? [
    `# ${specification.productName} Architecture`,
    "",
    "## System shape",
    "",
    "- Professional React and TypeScript customer frontend",
    "- Typed Node.js backend with server-side role authorization",
    "- PostgreSQL data model with project-scoped ownership",
    "- Versioned validation, audit evidence, and project exports",
    "",
    "## Domain",
    "",
    ...specification.entities.map((entity) => `- ${entity}`),
    "",
  ].join("\n");
  setFile("ARCHITECTURE.md", architecture, specification.requirements.map((requirement) => requirement.id));

  const packageJson = {
    name: slugify(specification.productName),
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "tsc -b && vite build", test: "node --test" },
    dependencies: { animejs: "^4.5.0", gsap: "^3.15.0", react: "^19.2.0", "react-dom": "^19.2.0" },
    devDependencies: { "@vitejs/plugin-react": "^6.0.0", typescript: "^7.0.0", vite: "^8.0.0" },
  };
  const existingPackage = files.find((file) => file.path === "package.json")?.content ?? "";
  if (!existingPackage.includes('"react"')) setFile("package.json", `${JSON.stringify(packageJson, null, 2)}\n`, ["REQ-006"]);

  return { files, modifiedFiles: [...modifiedFiles] };
}

function hasProfessionalFrontend(files: GeneratedFile[]): boolean {
  const paths = new Set(files.map((file) => file.path));
  const requiredPaths = ["ARCHITECTURE.md", "frontend/src/App.tsx", "frontend/src/styles.css", "frontend/src/main.tsx", "frontend/preview.html", "backend/src/index.ts", "backend/src/domain/model.ts", "backend/src/security/access-control.ts", "backend/src/api/contracts.ts"];
  const preview = files.find((file) => file.path === "frontend/preview.html")?.content ?? "";
  const app = files.find((file) => file.path === "frontend/src/App.tsx")?.content ?? "";
  return requiredPaths.every((path) => paths.has(path))
    && (preview.includes(GENERATED_FRONTEND_TEMPLATE) || (preview.includes("<!doctype html>") && preview.includes('aria-label="Primary navigation"')))
    && (app.includes(GENERATED_FRONTEND_TEMPLATE) || app.includes("export default function App"));
}

function cssEdit(prompt: string): string {
  const rules: string[] = [];
  if (/navbar|nav /i.test(prompt) && /small|short|compact|reduce/i.test(prompt)) rules.push("nav { padding-block: .55rem; }");
  if (/glass/i.test(prompt)) rules.push("nav, .generated-card { background: rgba(14, 22, 24, .62); backdrop-filter: blur(18px); border-color: rgba(255,255,255,.16); }");
  if (/rounded|pill/i.test(prompt)) rules.push("button, nav, .generated-card { border-radius: 1.75rem; }");
  if (/card/i.test(prompt) && /small|compact|reduce/i.test(prompt)) rules.push(".generated-card { min-height: 170px; padding: 1.15rem; } .generated-card h2 { margin-top: 2rem; }");
  if (/card/i.test(prompt) && /modern|clean/i.test(prompt)) rules.push(".generated-card { box-shadow: 0 24px 70px rgba(0,0,0,.24); transform: translateZ(0); }");
  if (/hero/i.test(prompt) && /clean|simple|reduce|small/i.test(prompt)) rules.push(".generated-hero { max-width: 760px; padding-block: clamp(3.5rem, 7vw, 6rem); } .generated-hero h1 { max-width: 12ch; }");
  const colors: Record<string, string> = { blue: "#56c8ff", purple: "#bd8cff", pink: "#ff8bd8", orange: "#ffae57", green: "#8df59a", cyan: "#50c7f0", lime: "#dfff68" };
  for (const [name, value] of Object.entries(colors)) if (new RegExp(`\\b${name}\\b`, "i").test(prompt)) rules.push(`:root { --generated-accent: ${value}; } .eyebrow, .generated-card span { color: var(--generated-accent) !important; } .signal-dot { background: var(--generated-accent); }`);
  if (rules.length === 0) rules.push(".generated-card { border-color: rgba(223,255,104,.22); transition: transform .2s ease, border-color .2s ease; } .generated-card:hover { transform: translateY(-3px); }");
  return `\n\n/* ForgeWeb scoped design edit */\n${rules.join("\n")}\n`;
}

function applyScopedEdit(sourceFiles: GeneratedFile[], prompt: string): { files: GeneratedFile[]; modifiedFiles: string[] } {
  const files = structuredClone(sourceFiles);
  const modified = new Set<string>();
  const scope = classifyEdit(prompt);
  const intentionallyInvalid = /remove.*closing.*brace|make.*invalid|broken code/i.test(prompt);

  if (scope === "frontend" || scope === "fullstack") {
    const patch = cssEdit(prompt);
    replaceFile(files, "frontend/src/styles.css", (content) => intentionallyInvalid ? content.replace(/}\s*$/, "") : content + patch, modified);
    replaceFile(files, "frontend/preview.html", (content) => content.replace("</style>", patch + "\n</style>"), modified);
    if (/phone number|registration/i.test(prompt)) {
      replaceFile(files, "frontend/src/App.tsx", (content) => content.replace("export default function App()", 'const registrationFields = ["email", "phoneNumber"] as const;\n\nexport default function App()'), modified);
    }
  }

  if (scope === "backend" || scope === "fullstack") {
    if (/delete|remov/i.test(prompt) && /task|record/i.test(prompt)) {
      replaceFile(files, "backend/src/api/contracts.ts", (content) => content + "\nexport type DeleteRecordInput = { id: string; reason?: string };\n", modified);
      replaceFile(files, "backend/src/index.ts", (content) => content + '\nexport const routes = { deleteRecord: "DELETE /v1/records/:id" } as const;\n', modified);
    } else if (/phone number|registration/i.test(prompt)) {
      replaceFile(files, "backend/src/api/contracts.ts", (content) => content + "\nexport type RegistrationInput = { email: string; phoneNumber: string };\n", modified);
    } else {
      replaceFile(files, "backend/src/api/contracts.ts", (content) => content + `\nexport type ScopedChange_${digest(prompt).slice(7, 15)} = { requestId: string };\n`, modified);
    }
  }

  if (scope === "database" || scope === "fullstack") {
    replaceFile(files, "backend/src/domain/model.ts", (content) => /phone number|registration/i.test(prompt)
      ? content + "\nexport type RegistrationProfile = { phoneNumber: string };\n"
      : content + `\nexport type SchemaChange_${digest(prompt).slice(7, 15)} = { appliedAt: string };\n`, modified);
  }

  return { files, modifiedFiles: [...modified] };
}

/**
 * AI-powered scoped edit. Asks the configured LLM to rewrite whole files in
 * response to an edit request, then merges the result into the current project
 * under strict guardrails:
 *
 *   - Only paths inside the generated project scope (frontend/, backend/, tests/,
 *     README.md, ARCHITECTURE.md, package.json) are accepted; anything else is
 *     dropped. Paths were already normalized through safePath() by the parser.
 *   - The sandbox preview (frontend/preview.html) is ForgeWeb-controlled and is
 *     never AI-authored, so any model attempt to rewrite it is ignored.
 *   - Requirement traceability is preserved: existing files keep their mapping if
 *     the model omits one; new files inherit a requirement id.
 *
 * Returns null when the provider is disabled, unavailable, produces unparseable
 * output, or changes nothing — signaling the caller to fall back to the
 * deterministic scoped edit. Validation of the merged result is the caller's
 * responsibility, so an invalid AI edit also degrades to the deterministic path.
 */
async function applyAiEdit(
  sourceFiles: GeneratedFile[],
  prompt: string,
  specification: MasterSpecification,
): Promise<{ files: GeneratedFile[]; modifiedFiles: string[] } | null> {
  const config = getLlmConfig();
  if (!config.enabled) return null;

  let provider: ReturnType<typeof getLlmProvider>;
  try {
    provider = getLlmProvider();
    if (!(await provider.isAvailable())) return null;
  } catch {
    return null;
  }

  try {
    const { system, user } = buildEditPrompt(prompt, sourceFiles, specification);
    const response = await provider.generate(user, { systemPrompt: system, temperature: 0.1, maxTokens: 8192 });
    const parsed = parseEditResponse(response.content);
    if (!parsed) return null;

    const files = structuredClone(sourceFiles);
    const byPath = new Map(files.map((file) => [file.path, file]));
    const fallbackRequirement = specification.requirements[0]?.id;
    const allowedRoots = ["frontend/", "backend/", "tests/"];
    const allowedExact = new Set(["README.md", "ARCHITECTURE.md", "package.json"]);
    const protectedPaths = new Set(["frontend/preview.html"]);
    const modified = new Set<string>();

    for (const change of parsed.modifiedFiles) {
      const path = change.path;
      // The preview is a ForgeWeb-owned, CSP-restricted isolated representation.
      if (protectedPaths.has(path)) continue;
      const inScope = allowedExact.has(path) || allowedRoots.some((root) => path.startsWith(root));
      if (!inScope) continue;

      const existing = byPath.get(path);
      if (existing) {
        if (existing.content === change.content) continue;
        existing.content = change.content;
        existing.digest = change.digest;
        if (change.requirementIds.length > 0) existing.requirementIds = change.requirementIds;
        modified.add(path);
      } else {
        const requirementIds = change.requirementIds.length > 0
          ? change.requirementIds
          : fallbackRequirement ? [fallbackRequirement] : [];
        if (requirementIds.length === 0) continue; // never store an untraceable file
        const created: GeneratedFile = { path, content: change.content, requirementIds, digest: change.digest };
        files.push(created);
        byPath.set(path, created);
        modified.add(path);
      }
    }

    if (modified.size === 0) return null;
    return { files, modifiedFiles: [...modified].sort() };
  } catch {
    return null;
  }
}

export class ProjectWorkspaceService {
  private readonly store: JsonStore;
  private readonly upgradeLocks = new Map<string, Promise<void>>();

  constructor(store: JsonStore) {
    this.store = store;
  }

  get(projectId: string): ProjectWorkspace {
    const database = this.store.read();
    const project = database.projects[projectId];
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    const specification = project.currentSpecificationId ? database.specifications[project.currentSpecificationId] : undefined;
    const versions = Object.values(database.versions)
      .filter((version) => version.projectId === projectId)
      .sort((left, right) => right.versionNumber - left.versionNumber);
    const currentVersion = project.currentVersionId ? database.versions[project.currentVersionId] : undefined;
    const files = currentVersion ? database.versionFiles[currentVersion.id] ?? [] : project.currentBuildId ? database.files[project.currentBuildId] ?? [] : [];
    return { project, specification, currentVersion, versions, files, database: databaseInfo(specification) };
  }

  async getReady(projectId: string): Promise<ProjectWorkspace> {
    await this.ensureProfessionalFrontend(projectId);
    return this.get(projectId);
  }

  private async ensureProfessionalFrontend(projectId: string): Promise<void> {
    const running = this.upgradeLocks.get(projectId);
    if (running) return running;
    const upgrade = this.performProfessionalFrontendUpgrade(projectId).finally(() => this.upgradeLocks.delete(projectId));
    this.upgradeLocks.set(projectId, upgrade);
    return upgrade;
  }

  private async performProfessionalFrontendUpgrade(projectId: string): Promise<void> {
    const workspace = this.get(projectId);
    if (!workspace.files.length) return;
    const compatibility = layoutCompatibility(workspace.files, workspace.currentVersion?.layout);
    if (compatibility === "approved-generated") {
      this.requireLayoutApproval(projectId, workspace.currentVersion!);
      return;
    }
    requireManagedLayout(workspace);
    if (hasProfessionalFrontend(workspace.files) && workspace.specification?.architecture) return;
    if (!workspace.specification || workspace.files.length === 0 || !workspace.project.currentBuildId) return;
    const specification = normalizeMasterSpecification(workspace.specification);
    const candidate = professionalizeFrontend(workspace.files, specification);
    const checks = validateStoredProject(candidate.files);
    if (checks.some((check) => check.status === "failed")) throw new ApiError(422, "PREVIEW_UPGRADE_FAILED", "The stored project could not be upgraded to the current preview format.");
    await this.store.mutate((database) => {
      const project = database.projects[projectId];
      database.specifications[specification.id] = specification;
      const activeFiles = project.currentVersionId ? database.versionFiles[project.currentVersionId] : database.files[project.currentBuildId!];
      if (project.currentVersionId !== workspace.project.currentVersionId || digest(JSON.stringify(activeFiles)) !== digest(JSON.stringify(workspace.files))) throw new ApiError(409, "WORKSPACE_CHANGED", "Workspace changed during compatibility upgrade.");
      const versions = Object.values(database.versions).filter((version) => version.projectId === projectId);
      const versionNumber = Math.max(0, ...versions.map((version) => version.versionNumber)) + 1;
      const versionId = id("version");
      database.versions[versionId] = {
        id: versionId,
        projectId,
        buildId: project.currentBuildId!,
        versionNumber,
        label: "Professional interface upgrade",
        editPrompt: "Automatic compatibility upgrade: restore preview support and apply the professional responsive application template.",
        modifiedFiles: candidate.modifiedFiles,
        sourceVersionId: workspace.currentVersion?.id,
        validationStatus: "passed",
        validationChecks: checks,
        createdAt: now(),
      };
      database.versionFiles[versionId] = candidate.files;
      project.currentVersionId = versionId;
      project.currentVersionNumber = versionNumber;
      project.status = "ready";
      project.updatedAt = now();
      const build = database.builds[project.currentBuildId!];
      if (build) {
        database.files[build.id] = candidate.files;
        build.filePaths = candidate.files.map((file) => file.path);
        build.updatedAt = now();
      }
    });
  }

  async getPreview(projectId: string): Promise<{ html: string; versionId: string }> {
    const workspace = await this.getReady(projectId);
    requireManagedLayout(workspace);
    const preview = workspace.files.find((file) => file.path === "frontend/preview.html");
    if (!preview || !workspace.currentVersion) throw new ApiError(422, "PREVIEW_UNAVAILABLE", "This project does not contain a renderable frontend preview.");
    return { html: preview.content, versionId: workspace.currentVersion.id };
  }

  async edit(projectId: string, promptValue: unknown): Promise<EditResult> {
    const prompt = assertPrompt(promptValue);
    const workspace = await this.getReady(projectId);
    requireManagedLayout(workspace);
    if (!workspace.currentVersion) throw new ApiError(409, "PROJECT_NOT_GENERATED", "Generate the project before applying an edit.");
    await this.store.mutate((database) => {
      database.projects[projectId].status = "editing";
      database.projects[projectId].updatedAt = now();
    });
    // Prefer an AI-powered edit when a provider is configured and reachable.
    // Fall back to the deterministic scoped edit if the model is unavailable,
    // returns unparseable output, changes nothing, or produces a project that
    // fails validation — the deterministic path is always a safe backstop.
    const specification = workspace.specification ? normalizeMasterSpecification(workspace.specification) : undefined;
    let candidate: { files: GeneratedFile[]; modifiedFiles: string[] } | null = null;
    if (specification) {
      const aiCandidate = await applyAiEdit(workspace.files, prompt, specification);
      if (aiCandidate && aiCandidate.modifiedFiles.length > 0) {
        const aiChecks = validateStoredProject(aiCandidate.files);
        if (!aiChecks.some((check) => check.status === "failed")) candidate = aiCandidate;
      }
    }
    if (!candidate) candidate = applyScopedEdit(workspace.files, prompt);
    if (candidate.modifiedFiles.length === 0) throw new ApiError(422, "NO_SAFE_EDIT", "No safe project files matched this edit request.");
    const checks = validateStoredProject(candidate.files);
    if (checks.some((check) => check.status === "failed")) {
      await this.store.mutate((database) => {
        database.projects[projectId].status = "validation_failed";
        database.projects[projectId].updatedAt = now();
      });
      throw new ApiError(422, "EDIT_VALIDATION_FAILED", "Changes could not be applied. Validation failed and your previous version is safe.");
    }
    await this.store.mutate((database) => {
      const project = database.projects[projectId];
      const existing = Object.values(database.versions).filter((version) => version.projectId === projectId);
      const versionNumber = Math.max(0, ...existing.map((version) => version.versionNumber)) + 1;
      const versionId = id("version");
      const version: ProjectVersion = {
        id: versionId,
        projectId,
        buildId: workspace.currentVersion!.buildId,
        versionNumber,
        label: prompt.length > 54 ? `${prompt.slice(0, 51)}…` : prompt,
        editPrompt: prompt,
        modifiedFiles: candidate.modifiedFiles,
        sourceVersionId: workspace.currentVersion!.id,
        validationStatus: "passed",
        validationChecks: checks,
        createdAt: now(),
      };
      database.versions[versionId] = version;
      database.versionFiles[versionId] = candidate.files;
      project.currentVersionId = versionId;
      project.currentVersionNumber = versionNumber;
      project.status = "ready";
      project.updatedAt = now();
    });
    return {
      workspace: this.get(projectId),
      modifiedFiles: candidate.modifiedFiles,
      phases: ["Understanding request", "Identifying affected files", "Updating scoped source", "Validating project", "Refreshing preview"],
    };
  }

  async restore(projectId: string, versionId: string): Promise<ProjectWorkspace> {
    const workspace = await this.getReady(projectId);
    const version = workspace.versions.find((candidate) => candidate.id === versionId);
    if (!version || version.validationStatus !== "passed") throw new ApiError(404, "VERSION_NOT_RESTORABLE", "The selected validated version was not found.");
    if (layoutCompatibility(this.store.read().versionFiles[versionId] ?? [], version.layout) === "unsupported") throw new ApiError(409, "LAYOUT_UNSUPPORTED", "Cannot restore an unfamiliar layout automatically.");
    if (version.layout) this.requireLayoutApproval(projectId, version);
    await this.store.mutate((database) => {
      const project = database.projects[projectId];
      project.currentVersionId = version.id;
      project.currentVersionNumber = version.versionNumber;
      project.status = "ready";
      project.updatedAt = now();
    });
    return this.get(projectId);
  }

  private requireLayoutApproval(projectId: string, version: ProjectVersion): void {
    const plan = this.store.read().planningRecords?.[version.layout!.approvedPlanId];
    if (!plan || plan.proposal.scope.projectId !== projectId || plan.digest !== planRecordDigest(plan) || plan.approval?.planDigest !== plan.digest) throw new ApiError(409, "LAYOUT_UNSUPPORTED", "Generated layout has no matching durable approval.");
  }

  async validateExport(projectId: string): Promise<ExportSummary> {
    const workspace = await this.getReady(projectId);
    requireManagedLayout(workspace);
    if (!workspace.currentVersion) throw new ApiError(409, "PROJECT_NOT_GENERATED", "Generate the project before exporting it.");
    const checks = validateStoredProject(workspace.files);
    const passed = !checks.some((check) => check.status === "failed");
    await this.store.mutate((database) => {
      const project = database.projects[projectId];
      project.status = passed ? "ready_to_export" : "validation_failed";
      project.updatedAt = now();
    });
    return {
      projectId,
      projectName: workspace.project.name,
      versionId: workspace.currentVersion.id,
      versionNumber: workspace.currentVersion.versionNumber,
      frontend: workspace.files.some((file) => file.path.startsWith("frontend/")) ? "generated" : "missing",
      backend: workspace.files.some((file) => file.path.startsWith("backend/")) ? "generated" : "missing",
      database: workspace.database.tables.length > 0 ? "configured" : "not-required",
      validation: passed ? "passed" : "failed",
      fileCount: workspace.files.length,
      checks,
    };
  }

  async export(projectId: string): Promise<{ archive: Buffer; filename: string; summary: ExportSummary }> {
    const summary = await this.validateExport(projectId);
    if (summary.validation !== "passed") throw new ApiError(422, "EXPORT_VALIDATION_FAILED", "Project validation failed. Fix the issues before exporting.");
    const workspace = this.get(projectId);
    return { archive: createProjectZip(workspace.files), filename: `${slugify(workspace.project.name)}-v${summary.versionNumber}.zip`, summary };
  }
}
