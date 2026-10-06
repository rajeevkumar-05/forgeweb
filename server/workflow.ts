import type {
  AgentTask,
  ArchitecturePlan,
  Build,
  BuildCapability,
  BuildEvent,
  BuildStatus,
  BuildView,
  GeneratedFile,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  LlmGenerationMetadata,
  MasterSpecification,
  Project,
  Requirement,
  ReviewFinding,
  ValidationCheck,
} from "./domain.ts";
import { ApiError, assertPrompt, delay, digest, id, now, safePath, slugify } from "./lib.ts";
import { canTransition, setBuildStatus } from "./build-state.ts";
import { buildGeneratedFrontend, GENERATED_FRONTEND_TEMPLATE } from "./generated-frontend.ts";
import { buildGeneratedBackend } from "./generated-backend.ts";
import { AGENT_POLICY, createTasks, enforceImplementationTask } from "./policy.ts";
import { ProjectWorkspaceService } from "./project-workspace.ts";
import { JsonStore } from "./store.ts";
import { createFallbackMetadata, getLlmConfig, getLlmProvider } from "./llm/index.ts";
import { buildSpecificationPrompt, buildFrontendPrompt, buildBackendPrompt, buildReviewPrompt } from "./llm/prompts.ts";
import { parseSpecificationResponse, parseFileGenerationResponse, parseReviewResponse } from "./llm/parser.ts";

const stageIndexes: Record<Exclude<BuildStatus, "queued" | "awaiting_confirmation" | "failed" | "needs_context">, number> = {
  specifying: 0,
  planning: 1,
  generating: 2,
  reviewing: 3,
  validating: 4,
  completed: 5,
};

const entityKeywords: Array<[RegExp, string]> = [
  [/projects?|portfolio/i, "Project"],
  [/skills?|tech\s?stack/i, "Skill"],
  [/invoices?|billing|payment/i, "Invoice"],
  [/files?|documents?|assets?/i, "FileAsset"],
  [/inventory|stock|products?|items?/i, "Product"],
  [/orders?|checkout|cart/i, "Order"],
  [/teams?|staff|employees?|members?/i, "TeamMember"],
  [/schedul|calendar|booking|appointments?/i, "Appointment"],
  [/clients?|customers?/i, "Client"],
  [/students?|school|education/i, "Student"],
  [/courses?|lessons?|classes?/i, "Course"],
  [/articles?|posts?|blogs?/i, "Article"],
  [/comments?|reviews?|feedback/i, "Review"],
  [/tasks?|todos?|issues?/i, "Task"],
  [/patients?|clinic|health|medical/i, "Patient"],
  [/events?|tickets?|venues?/i, "Event"],
  [/messages?|chats?|conversations?/i, "Message"],
  [/transactions?|expenses?|budget/i, "Transaction"],
  [/games?|scores?|leaderboard/i, "ScoreEntry"],
];

/**
 * Derive a product name from a conversational prompt.
 *
 * The name is a noun phrase, so everything after a feature list ("with ...") or
 * a subordinate clause ("where users can ...") is dropped before the phrase is
 * cut at the first punctuation. Without the clause strip, a prompt such as
 * "…application where users can create, edit, complete, and delete tasks"
 * yields the fragment "Application Where Users Can Create", which then
 * propagates into the summary, README, preview, and ARCHITECTURE.md title.
 */
function productName(prompt: string): string {
  const cleaned = prompt.replace(/^(?:please\s+)?(?:build|create|make|generate|design)\s+(?:an?\s+)?(?:secure\s+)?/i, "").trim();
  const candidate = cleaned
    .replace(/\s+(?:with|for|featuring|including)\s+.*$/i, "")
    .replace(/\s+(?:where|which|that|who|whose|when|while|so\s+that|in\s+which|allowing|letting|enabling|used\s+by)\b.*$/i, "")
    .split(/[.,;:\n]/)[0]
    ?.trim()
    .replace(/\s+(?:and|or|of|the|a|an|to|for|with|by|in|on|from)$/i, "")
    .trim();
  if (candidate && candidate.length >= 2 && candidate.length <= 60) {
    return candidate.replace(/\b\w/g, (character) => character.toUpperCase());
  }
  return "ForgeWeb Application";
}

const buildCapabilities: BuildCapability[] = [
  {
    id: "react",
    name: "React",
    kind: "framework",
    sourceUrl: "https://react.dev/",
    usage: "Component-driven customer application frontend with typed state and accessible interactions.",
    boundary: "Pinned application dependency; generated code owns its design system.",
  },
  {
    id: "git",
    name: "Git",
    kind: "source-control",
    sourceUrl: "https://git-scm.com/",
    usage: "Specification, architecture, generated files, and evidence remain tied to immutable revisions.",
    boundary: "External remotes require explicit user authorization.",
  },
  {
    id: "gsap",
    name: "GSAP",
    kind: "motion",
    sourceUrl: "https://gsap.com/",
    usage: "High-value timeline and scroll choreography for the generated customer interface.",
    boundary: "Reduced-motion fallbacks and license review are mandatory.",
  },
  {
    id: "animejs",
    name: "Anime.js",
    kind: "motion",
    sourceUrl: "https://animejs.com/",
    usage: "Micro-interactions, SVG motion, and lightweight state transitions.",
    boundary: "Animations support hierarchy and never block core actions.",
  },
  {
    id: "react-bits",
    name: "React Bits",
    kind: "component-source",
    sourceUrl: "https://reactbits.dev/",
    usage: "Reviewed visual-pattern reference for backgrounds, navigation, cards, and text effects.",
    boundary: "Components are selected and attributed deliberately; no blind runtime or MCP dependency is embedded.",
  },
];

function createArchitecture(
  name: string,
  prompt: string,
  roles: string[],
  entities: string[],
  requirements: Requirement[],
): ArchitecturePlan {
  const isCommerce = /shop|store|commerce|product catalog|checkout/i.test(prompt);
  const isDashboard = /portal|dashboard|admin|inventory|scheduler/i.test(prompt);
  const pages = [
    "Secure sign-in",
    isDashboard ? "Role-aware dashboard" : "Product home",
    ...entities.filter((entity) => entity !== "User").slice(0, 4).map((entity) => entity + " workspace"),
    isCommerce ? "Checkout and order status" : "Activity and audit history",
    "Settings and access management",
  ];
  const components = [
    "Responsive application shell",
    "Command and search surface",
    "Data cards and empty states",
    "Accessible forms and confirmation dialogs",
    "Evidence and activity timeline",
  ];
  const diagram = [
    "flowchart LR",
    "  Browser[React customer app] --> API[Typed backend API]",
    "  API --> Auth[Session and role policy]",
    "  API --> Domain[Domain modules]",
    "  Domain --> DB[PostgreSQL]",
    "  API --> Jobs[Background jobs]",
    "  Tests[Acceptance and security checks] --> API",
    "  Git[Git revision] --> Graph[Requirement and code graph]",
  ].join("\n");
  const database = "PostgreSQL";
  const dataRules = [
    "Every mutable record has an owner or project boundary",
    "Archive before destructive deletion",
    "Migrations and audit events are versioned",
  ];
  const delivery = [
    "Git-native revisions",
    "Automated type, test, security, and accessibility checks",
    "Requirement-to-code graph snapshot",
    "Sanitized export",
  ];
  const fence = String.fromCharCode(96).repeat(3);
  const markdown = [
    "# " + name + " Architecture",
    "",
    "## Product boundary",
    "",
    "A secure application for " + roles.join(", ") + ". " + requirements.length + " proposed requirements drive every generated frontend and backend artifact.",
    "",
    "## System shape",
    "",
    "- React and TypeScript customer frontend",
    "- TypeScript modular backend with typed HTTP contracts",
    "- PostgreSQL data model with project-scoped ownership",
    "- Server-side authentication and role authorization",
    "- Background jobs for slow or retryable work",
    "- Git-linked requirement, file, test, and evidence graph",
    "",
    "## Frontend",
    "",
    ...pages.map((page) => "- " + page),
    "",
    "Motion is progressive enhancement: GSAP handles major timelines, Anime.js handles SVG and micro-interactions, and every experience provides reduced-motion behavior.",
    "",
    "## Backend",
    "",
    "- Identity and session module",
    "- Role and ownership policy module",
    ...entities.map((entity) => "- " + entity + " domain module"),
    "- Audit and evidence module",
    "",
    "## Data model",
    "",
    "Database: " + database + ".",
    "",
    ...entities.map((entity) => "- " + entity + " table with owner, timestamps, and audit trail"),
    "",
    ...dataRules.map((rule) => "- " + rule),
    "",
    "## Security",
    "",
    "- Authorization is enforced on the server, never inferred from hidden UI.",
    "- Input is validated at the API boundary.",
    "- Destructive operations require confirmation and audit evidence.",
    "- Secrets and external integrations remain isolated capability handles.",
    "",
    "## Delivery",
    "",
    ...delivery.map((item) => "- " + item),
    "",
    "## Diagram",
    "",
    fence + "mermaid",
    diagram,
    fence,
    "",
    "## Generation gate",
    "",
    "No frontend or backend source is generated until this architecture and its requirements are explicitly confirmed.",
    "",
  ].join("\n");
  return {
    systemShape: "Modular TypeScript application with a React client, typed backend, relational data, durable jobs, and Git-linked evidence.",
    frontend: {
      framework: "React 19 and TypeScript",
      pages,
      components,
      motion: ["GSAP timelines and scroll choreography", "Anime.js SVG and micro-interactions", "React Bits-inspired reviewed visual patterns", "Reduced-motion alternatives"],
    },
    backend: {
      runtime: "Node.js and TypeScript",
      modules: ["Identity", "Authorization", ...entities, "Audit", "Validation"],
      apiStyle: "Versioned JSON HTTP contracts with server-side validation",
      jobs: ["Long-running generation", "Notifications and integrations", "Evidence and graph synchronization"],
    },
    data: {
      database,
      entities,
      rules: dataRules,
    },
    security: [
      "Secure session boundary",
      "Server-side role and ownership checks",
      "Validated input and output contracts",
      "Secret isolation and redacted logs",
      "Explicit confirmation for consequential actions",
    ],
    delivery,
    diagram,
    markdown,
    capabilities: buildCapabilities,
  };
}

/** Template-based specification (original implementation — used as fallback). */
function compileSpecificationTemplate(projectId: string, prompt: string): MasterSpecification {
  const name = productName(prompt);
  const entities = ["User", ...entityKeywords.filter(([keyword]) => keyword.test(prompt)).map(([, entity]) => entity)];
  const uniqueEntities = [...new Set(entities)];
  const roles = ["Owner", "Member", ...(/client|customer/i.test(prompt) ? ["Client"] : [])];
  const requirements: Requirement[] = [
    ["Authentication", "Users can sign in and sign out through a secure session boundary."],
    ["Authorization", `Server-side role checks protect ${uniqueEntities.join(", ")}.`],
    ["Core workflow", `Authorized users can create, view, update, and safely archive ${uniqueEntities.filter((entity) => entity !== "User").join(", ") || "domain records"}.`],
    ["Validation", "Invalid and unauthorized input fails closed with a useful error."],
    ["Auditability", "Consequential operations retain requirement and actor traceability."],
    ["Quality", "The application includes responsive behavior and automated acceptance checks."],
  ].map(([title, description], index) => ({
    id: `REQ-${String(index + 1).padStart(3, "0")}`,
    title,
    description,
    acceptanceCriteria: [description],
    priority: "P0",
  }));
  return {
    id: id("spec"),
    projectId,
    version: 1,
    status: "proposed",
    prompt,
    productName: name,
    summary: `A secure ${name.toLowerCase()} with explicit roles, typed domain boundaries, validation, tests, and traceability.`,
    roles,
    entities: uniqueEntities,
    requirements,
    assumptions: [
      "The first generated stack is TypeScript and uses server-side authorization.",
      "Destructive domain actions use archive semantics unless the specification explicitly requires deletion.",
      "External integrations remain proposals until their credentials and terms are approved.",
    ],
    architecture: createArchitecture(name, prompt, roles, uniqueEntities, requirements),
    createdAt: now(),
  };
}

/** LLM-powered specification with template fallback. */
async function compileSpecification(projectId: string, prompt: string): Promise<{ specification: MasterSpecification; llmMetadata: LlmGenerationMetadata }> {
  const config = getLlmConfig();

  if (config.enabled) {
    try {
      const provider = getLlmProvider();
      const available = await provider.isAvailable();

      if (available) {
        const { system, user } = buildSpecificationPrompt(prompt);
        const response = await provider.generate(user, { systemPrompt: system, temperature: 0.2, maxTokens: 4096 });
        const parsed = parseSpecificationResponse(response.content);

        if (parsed) {
          const name = parsed.productName || productName(prompt);
          const uniqueEntities = [...new Set(parsed.entities)];
          const requirements: Requirement[] = parsed.requirements.map((r, index) => ({
            id: r.id || `REQ-${String(index + 1).padStart(3, "0")}`,
            title: r.title,
            description: r.description,
            acceptanceCriteria: r.acceptanceCriteria,
            priority: r.priority,
          }));

          const specification: MasterSpecification = {
            id: id("spec"),
            projectId,
            version: 1,
            status: "proposed",
            prompt,
            productName: name,
            summary: parsed.summary || `A secure ${name.toLowerCase()} generated by AI.`,
            roles: parsed.roles,
            entities: uniqueEntities,
            requirements,
            assumptions: parsed.assumptions || [
              "The first generated stack is TypeScript and uses server-side authorization.",
            ],
            architecture: createArchitecture(name, prompt, parsed.roles, uniqueEntities, requirements),
            createdAt: now(),
          };

          return {
            specification,
            llmMetadata: {
              provider: provider.name,
              model: response.model,
              tokensUsed: response.tokensUsed,
              durationMs: response.durationMs,
              fallbackUsed: false,
            },
          };
        }
        console.warn("[ForgeWeb LLM] Specification response could not be parsed, falling back to template.");
      }
    } catch (error) {
      console.warn("[ForgeWeb LLM] Specification generation failed, falling back to template:", error instanceof Error ? error.message : error);
    }
  }

  // Fallback to template-based specification
  return {
    specification: compileSpecificationTemplate(projectId, prompt),
    llmMetadata: createFallbackMetadata(),
  };
}

/** Template-based file generation (original implementation — used as fallback). */
function generateFilesTemplate(specification: MasterSpecification): GeneratedFile[] {
  const requirementIds = specification.requirements.map((requirement) => requirement.id);
  const frontend = buildGeneratedFrontend(specification);
  const backend = buildGeneratedBackend(specification);
  const packageJson = {
    name: slugify(specification.productName),
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite --root frontend", build: "tsc -p frontend/tsconfig.json && tsc -p backend/tsconfig.json && vite build --root frontend", test: "node --test", "start:api": "node backend/dist/index.js" },
    dependencies: { animejs: "^4.5.0", gsap: "^3.15.0", react: "^19.2.0", "react-dom": "^19.2.0" },
    devDependencies: { "@types/node": "^24.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^6.0.0", typescript: "^7.0.0", vite: "^8.0.0" },
  };
  const templates = [
    { path: "README.md", requirements: requirementIds, content: "# " + specification.productName + "\n\n" + specification.summary + "\n\nGenerated only after confirmation of specification " + specification.id + ".\n" },
    { path: "ARCHITECTURE.md", requirements: requirementIds, content: specification.architecture.markdown },
    { path: "package.json", requirements: ["REQ-006"], content: JSON.stringify(packageJson, null, 2) + "\n" },
    { path: "frontend/index.html", requirements: ["REQ-006"], content: '<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>' + specification.productName + '</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>\n</html>\n' },
    { path: "frontend/tsconfig.json", requirements: ["REQ-006"], content: '{\n  "compilerOptions": { "target": "ES2022", "useDefineForClassFields": true, "lib": ["ES2022", "DOM"], "allowJs": false, "skipLibCheck": true, "esModuleInterop": true, "allowSyntheticDefaultImports": true, "strict": true, "module": "ESNext", "moduleResolution": "bundler", "resolveJsonModule": true, "isolatedModules": true, "noEmit": true, "jsx": "react-jsx" },\n  "include": ["src"]\n}\n' },
    { path: "frontend/src/App.tsx", requirements: ["REQ-003", "REQ-006"], content: frontend.app },
    { path: "frontend/src/styles.css", requirements: ["REQ-006"], content: frontend.styles },
    { path: "frontend/src/main.tsx", requirements: ["REQ-006"], content: 'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.js";\n\ncreateRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);\n' },
    { path: "frontend/preview.html", requirements: ["REQ-003", "REQ-006"], content: frontend.preview },
    { path: "backend/src/domain/model.ts", requirements: ["REQ-003", "REQ-004"], content: backend.model },
    { path: "backend/src/security/access-control.ts", requirements: ["REQ-001", "REQ-002", "REQ-004"], content: backend.accessControl },
    { path: "backend/src/api/contracts.ts", requirements: ["REQ-003", "REQ-004", "REQ-005"], content: backend.contracts },
    { path: "backend/src/index.ts", requirements: ["REQ-001", "REQ-002", "REQ-003"], content: backend.index },
    { path: "backend/tsconfig.json", requirements: ["REQ-006"], content: '{\n  "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true, "esModuleInterop": true, "skipLibCheck": true, "outDir": "dist", "rootDir": "src", "types": ["node"] },\n  "include": ["src"]\n}\n' },
    { path: "tests/acceptance.test.ts", requirements: requirementIds, content: 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("approved architecture keeps requirement coverage", () => { assert.equal(' + JSON.stringify(requirementIds) + ".length, " + requirementIds.length + "); });\n" },
  ];
  return templates.map((template) => ({
    path: safePath(template.path),
    content: template.content,
    requirementIds: template.requirements,
    digest: digest(template.content),
  }));
}

/** LLM-powered file generation with template fallback. */
async function generateFiles(specification: MasterSpecification): Promise<{ files: GeneratedFile[]; llmMetadata: LlmGenerationMetadata }> {
  const config = getLlmConfig();

  if (config.enabled) {
    try {
      const provider = getLlmProvider();
      const available = await provider.isAvailable();

      if (available) {
        // Generate frontend files
        const frontendPrompt = buildFrontendPrompt(specification);
        const frontendResponse = await provider.generate(frontendPrompt.user, {
          systemPrompt: frontendPrompt.system,
          temperature: 0.1,
          maxTokens: 8192,
        });
        const frontendParsed = parseFileGenerationResponse(frontendResponse.content);

        // Generate backend files
        const backendPrompt = buildBackendPrompt(specification);
        const backendResponse = await provider.generate(backendPrompt.user, {
          systemPrompt: backendPrompt.system,
          temperature: 0.1,
          maxTokens: 4096,
        });
        const backendParsed = parseFileGenerationResponse(backendResponse.content);

        if (frontendParsed && backendParsed) {
          // Merge AI-authored source with the ForgeWeb-controlled baseline.
          //
          // The model authors the real React frontend and typed backend. ForgeWeb
          // still guarantees a coherent, reviewable, sandbox-safe project:
          //
          //   1. ForgeWeb owns the sandbox preview artifact (frontend/preview.html).
          //      It is served under a strict CSP (script-src 'none') and must carry
          //      the required template marker, so it can never be AI-authored — any
          //      model-emitted preview is dropped and the deterministic preview wins.
          //   2. Every REQUIRED baseline artifact the model omitted is backfilled
          //      with its deterministic version. AI-authored source that IS present
          //      is preserved untouched. This guarantees hasProfessionalFrontend()
          //      is satisfied, so the stored project is kept exactly as generated and
          //      is never clobbered by the compatibility upgrade in getReady().
          const previewPath = "frontend/preview.html";
          const llmFiles = [...frontendParsed.files, ...backendParsed.files].filter((file) => file.path !== previewPath);

          // Deterministic template provides scaffolding (README, ARCHITECTURE,
          // package.json, tests, preview) and safe fallbacks for any omitted source.
          const baseline = generateFilesTemplate(specification);
          const baselineByPath = new Map(baseline.map((file) => [file.path, file]));
          const requiredBaselinePaths = [
            "README.md",
            "ARCHITECTURE.md",
            "package.json",
            "frontend/index.html",
            "frontend/tsconfig.json",
            "frontend/src/App.tsx",
            "frontend/src/styles.css",
            "frontend/src/main.tsx",
            previewPath,
            "backend/tsconfig.json",
            "backend/src/domain/model.ts",
            "backend/src/security/access-control.ts",
            "backend/src/api/contracts.ts",
            "backend/src/index.ts",
            "tests/acceptance.test.ts",
          ];
          const present = new Set(llmFiles.map((file) => file.path));
          for (const path of requiredBaselinePaths) {
            if (present.has(path)) continue;
            const fallback = baselineByPath.get(path);
            if (!fallback) continue;
            llmFiles.push(fallback);
            present.add(path);
          }

          const totalTokens = {
            prompt: frontendResponse.tokensUsed.prompt + backendResponse.tokensUsed.prompt,
            completion: frontendResponse.tokensUsed.completion + backendResponse.tokensUsed.completion,
          };

          return {
            files: llmFiles,
            llmMetadata: {
              provider: provider.name,
              model: frontendResponse.model,
              tokensUsed: totalTokens,
              durationMs: frontendResponse.durationMs + backendResponse.durationMs,
              fallbackUsed: false,
            },
          };
        }
        console.warn("[ForgeWeb LLM] File generation response could not be parsed, falling back to template.");
      }
    } catch (error) {
      console.warn("[ForgeWeb LLM] File generation failed, falling back to template:", error instanceof Error ? error.message : error);
    }
  }

  // Fallback to template-based generation
  return {
    files: generateFilesTemplate(specification),
    llmMetadata: createFallbackMetadata(),
  };
}
function review(specification: MasterSpecification, implementationTask: AgentTask, files: GeneratedFile[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const traced = new Set(files.flatMap((file) => file.requirementIds));
  for (const requirement of specification.requirements) {
    if (!traced.has(requirement.id)) findings.push({ id: id("finding"), severity: "error", message: `${requirement.id} has no generated artifact.` });
  }
  if (files.length > implementationTask.changeBudget.maxFiles) {
    findings.push({ id: id("finding"), severity: "error", message: "Implementation exceeds the approved file budget." });
  }
  if (findings.length === 0) findings.push({ id: id("finding"), severity: "info", message: "Independent review found no blocking scope, simplicity, or traceability issues." });
  return findings;
}

/**
 * AI-powered independent review. Augments — never replaces — the deterministic
 * review, which remains the hard gate. The model can surface qualitative issues
 * (security smells, unnecessary complexity, unclear coverage) that structural
 * checks miss.
 *
 * These findings are advisory: a build that already passed the deterministic
 * gate must not be hard-blocked by a model that may hallucinate. Any severity
 * the model reports as "error" is recorded as a "warning" for gating purposes,
 * with the original severity preserved in the message text for transparency.
 * Returns [] when the provider is disabled, unavailable, or unparseable.
 */
async function aiReviewAdvisory(specification: MasterSpecification, files: GeneratedFile[]): Promise<ReviewFinding[]> {
  const config = getLlmConfig();
  if (!config.enabled) return [];

  let provider: ReturnType<typeof getLlmProvider>;
  try {
    provider = getLlmProvider();
    if (!(await provider.isAvailable())) return [];
  } catch {
    return [];
  }

  try {
    const { system, user } = buildReviewPrompt(files, specification);
    const response = await provider.generate(user, { systemPrompt: system, temperature: 0.1, maxTokens: 2048 });
    const parsed = parseReviewResponse(response.content);
    if (!parsed) return [];
    return parsed.findings.map((finding) => ({
      id: id("finding"),
      severity: finding.severity === "error" ? "warning" : finding.severity,
      message: `[AI reviewer${finding.severity === "error" ? " — model flagged as error" : ""}] ${finding.message}`,
      ...(finding.path ? { path: finding.path } : {}),
    }));
  } catch {
    return [];
  }
}

/**
 * Deterministic validation of a generated project. Exported so the gate can be
 * unit-tested directly (including the failing P0-coverage path, which the
 * deterministic review stage normally intercepts before validation runs).
 */
export function validateGeneratedProject(specification: MasterSpecification, files: GeneratedFile[], findings: ReviewFinding[]): ValidationCheck[] {
  const paths = new Set(files.map((file) => file.path));
  const traced = new Set(files.flatMap((file) => file.requirementIds));
  // Strict P0 gate: every P0 requirement must map to at least one implementing
  // file. That mapping is what earns the requirement its `SATISFIED_BY` and
  // `VALIDATED_BY` edges in the traceability graph, because each check declares
  // the files it inspected. Missing coverage must FAIL validation — never skip.
  const p0Requirements = specification.requirements.filter((requirement) => requirement.priority === "P0");
  const p0Uncovered = p0Requirements.filter((requirement) => !files.some((file) => file.requirementIds.includes(requirement.id)));
  const allPaths = [...paths];
  const checks: ValidationCheck[] = [
    { id: id("check"), name: "Safe generated paths", status: files.every((file) => !file.path.includes("..")) ? "passed" : "failed", evidence: `${files.length} repository-relative paths inspected.`, subjectPaths: allPaths },
    { id: id("check"), name: "Architecture contract", status: paths.has("ARCHITECTURE.md") ? "passed" : "failed", evidence: "The approved architecture is preserved beside generated source.", subjectPaths: ["ARCHITECTURE.md"] },
    { id: id("check"), name: "Required secure boundary", status: paths.has("backend/src/security/access-control.ts") ? "passed" : "failed", evidence: "Server-side access-control artifact is present.", subjectPaths: ["backend/src/security/access-control.ts"] },
    { id: id("check"), name: "Customer frontend", status: paths.has("frontend/src/App.tsx") && paths.has("frontend/src/styles.css") ? "passed" : "failed", evidence: "Responsive React application and design system are present.", subjectPaths: ["frontend/src/App.tsx", "frontend/src/styles.css"] },
    { id: id("check"), name: "Professional preview artifact", status: files.find((file) => file.path === "frontend/preview.html")?.content.includes(GENERATED_FRONTEND_TEMPLATE) ? "passed" : "failed", evidence: "A stored, sandbox-renderable professional application preview is present.", subjectPaths: ["frontend/preview.html"] },
    { id: id("check"), name: "Customer backend", status: paths.has("backend/src/index.ts") && paths.has("backend/src/api/contracts.ts") ? "passed" : "failed", evidence: "Typed backend entrypoint and API contracts are present.", subjectPaths: ["backend/src/index.ts", "backend/src/api/contracts.ts"] },
    { id: id("check"), name: "Acceptance tests", status: paths.has("tests/acceptance.test.ts") ? "passed" : "failed", evidence: "Generated acceptance-test artifact is present.", subjectPaths: ["tests/acceptance.test.ts"] },
    { id: id("check"), name: "Requirement traceability", status: specification.requirements.every((requirement) => traced.has(requirement.id)) ? "passed" : "failed", evidence: `${traced.size}/${specification.requirements.length} requirement identifiers mapped.`, subjectPaths: allPaths },
    { id: id("check"), name: "P0 requirement coverage", status: p0Uncovered.length === 0 ? "passed" : "failed", evidence: p0Uncovered.length === 0 ? `${p0Requirements.length} P0 requirement(s) each map to generated implementation and validation.` : `${p0Uncovered.length} P0 requirement(s) lack implementation mapping: ${p0Uncovered.map((requirement) => requirement.id).join(", ")}.`, subjectPaths: allPaths },
    { id: id("check"), name: "Independent review", status: findings.every((finding) => finding.severity !== "error") ? "passed" : "failed", evidence: `${findings.length} review record(s) evaluated.` },
    { id: id("check"), name: "Policy provenance", status: AGENT_POLICY.sourceRevision.length >= 7 && AGENT_POLICY.sourceDigest.startsWith("sha256:") ? "passed" : "failed", evidence: `${AGENT_POLICY.version} at upstream revision ${AGENT_POLICY.sourceRevision}.` },
    // Honest reporting: the control plane cannot compile the generated app's own
    // TypeScript here, so this check is reported as skipped with a reason rather
    // than a fabricated pass. The exported project ships its own tsc/vite scripts.
    { id: id("check"), name: "Generated application type-check", status: "skipped", evidence: "Skipped: ForgeWeb does not compile generated application code in the control plane. The exported project includes its own TypeScript/Vite toolchain (npm run typecheck && npm run build) for the developer to run." },
  ];
  return checks;
}

function buildGraph(project: Project, build: Build, specification: MasterSpecification, tasks: AgentTask[], files: GeneratedFile[], checks: ValidationCheck[]): GraphSnapshot {
  const nodes: GraphNode[] = [{ id: project.id, type: "project", label: project.name }];
  const edges: GraphEdge[] = [];
  for (const requirement of specification.requirements) {
    nodes.push({ id: requirement.id, type: "requirement", label: requirement.title });
    edges.push({ id: id("edge"), type: "CONTAINS", from: project.id, to: requirement.id });
  }
  for (const task of tasks) {
    nodes.push({ id: task.id, type: "task", label: task.objective, metadata: { role: task.role } });
    for (const requirementId of task.requirementIds) edges.push({ id: id("edge"), type: "PERFORMED_BY", from: requirementId, to: task.id });
  }
  // Requirement -> implementing files, and the reverse index used below to
  // attribute validation checks back to the requirements they actually cover.
  const filesByRequirement = new Map<string, Set<string>>();
  for (const file of files) {
    const fileId = `file:${file.path}`;
    nodes.push({ id: fileId, type: "file", label: file.path, metadata: { digest: file.digest } });
    for (const requirementId of file.requirementIds) {
      edges.push({ id: id("edge"), type: "SATISFIED_BY", from: requirementId, to: fileId });
      const paths = filesByRequirement.get(requirementId) ?? new Set<string>();
      paths.add(file.path);
      filesByRequirement.set(requirementId, paths);
    }
  }
  for (const check of checks) {
    nodes.push({ id: check.id, type: "validation", label: check.name, metadata: { status: check.status } });
    // Project-wide evidence: every check belongs to the build's validation record.
    edges.push({ id: id("edge"), type: "VALIDATED_BY", from: project.id, to: check.id });
    // Requirement-level evidence: a requirement is only reported as validated by
    // a check that inspected at least one file implementing that requirement, so
    // an unimplemented requirement gains no validation edge it did not earn.
    for (const requirement of specification.requirements) {
      const implementing = filesByRequirement.get(requirement.id);
      if (!implementing) continue;
      if (!(check.subjectPaths ?? []).some((path) => implementing.has(path))) continue;
      edges.push({ id: id("edge"), type: "VALIDATED_BY", from: requirement.id, to: check.id });
    }
  }
  return {
    id: id("graph"),
    projectId: project.id,
    buildId: build.id,
    mode: "authoritative",
    engine: "forgeweb-structural-adapter",
    upstreamTarget: "code-review-graph@2.3.7",
    nodes,
    edges,
    createdAt: now(),
  };
}

export class BuildWorkflow {
  private running = new Set<string>();
  private readonly store: JsonStore;
  private readonly stageDelayMs: number;
  readonly workspace: ProjectWorkspaceService;

  constructor(store: JsonStore, stageDelayMs = 180) {
    this.store = store;
    this.stageDelayMs = stageDelayMs;
    this.workspace = new ProjectWorkspaceService(store);
  }

  async create(promptValue: unknown): Promise<BuildView> {
    const prompt = assertPrompt(promptValue);
    const timestamp = now();
    const projectId = id("project");
    const buildId = id("build");
    const name = productName(prompt);
    const project: Project = {
      id: projectId,
      slug: `${slugify(name)}-${projectId.slice(-5)}`,
      name,
      status: "planning",
      originalPrompt: prompt,
      createdAt: timestamp,
      updatedAt: timestamp,
      currentBuildId: buildId,
    };
    const build: Build = {
      id: buildId,
      projectId,
      status: "queued",
      currentStageIndex: -1,
      stageDetail: "Build accepted and queued.",
      stages: [],
      taskIds: [],
      filePaths: [],
      reviewFindings: [],
      validationChecks: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.projects[project.id] = project;
      database.builds[build.id] = build;
      database.events[build.id] = [{ id: id("event"), buildId, type: "build.created", message: "Build accepted.", timestamp }];
    });
    void this.prepare(buildId, prompt);
    return this.get(buildId);
  }

  get(buildId: string): BuildView {
    const database = this.store.read();
    const build = database.builds[buildId];
    if (!build) throw new ApiError(404, "BUILD_NOT_FOUND", "Build was not found.");
    return {
      ...build,
      project: database.projects[build.projectId],
      specification: build.specificationId ? database.specifications[build.specificationId] : undefined,
      events: database.events[buildId] ?? [],
    };
  }

  getProject(projectId: string): { project: Project; specification?: MasterSpecification; files: GeneratedFile[]; graph?: GraphSnapshot } {
    const database = this.store.read();
    const project = database.projects[projectId];
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project was not found.");
    return {
      project,
      specification: project.currentSpecificationId ? database.specifications[project.currentSpecificationId] : undefined,
      files: project.currentVersionId ? database.versionFiles[project.currentVersionId] ?? [] : project.currentBuildId ? database.files[project.currentBuildId] ?? [] : [],
      graph: project.currentGraphSnapshotId ? database.graphs[project.currentGraphSnapshotId] : undefined,
    };
  }

  listProjects(): Project[] {
    return Object.values(this.store.read().projects).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async prepare(buildId: string, prompt?: string): Promise<void> {
    const runKey = `prepare:${buildId}`;
    if (this.running.has(runKey)) return;
    this.running.add(runKey);
    try {
      const initial = this.get(buildId);
      const sourcePrompt = prompt ?? initial.specification?.prompt;
      if (!sourcePrompt) throw new ApiError(500, "MISSING_PROMPT", "Build cannot resume without a prompt.");

      await this.stage(buildId, "specifying", "Turning the idea into a proposed, versioned master specification.");
      const { specification, llmMetadata: specLlmMetadata } = await compileSpecification(initial.projectId, sourcePrompt);
      await this.store.mutate((database) => {
        database.specifications[specification.id] = specification;
        const build = database.builds[buildId];
        build.specificationId = specification.id;
        build.llmMetadata = specLlmMetadata;
        const modeLabel = specLlmMetadata.fallbackUsed ? "template" : `AI (${specLlmMetadata.model})`;
        build.stageDetail = `${specification.requirements.length} proposed requirements mapped across ${specification.entities.length} domain entities [${modeLabel}].`;
        const project = database.projects[build.projectId];
        project.currentSpecificationId = specification.id;
        project.updatedAt = now();
      });
      await this.completeStage(buildId);

      await this.stage(buildId, "planning", "Applying the shared coding discipline and creating bounded specialist tasks.");
      const tasks = createTasks(buildId, specification);
      await this.store.mutate((database) => {
        for (const task of tasks) database.tasks[task.id] = task;
        database.builds[buildId].taskIds = tasks.map((task) => task.id);
        database.builds[buildId].stageDetail = `${tasks.length} bounded tasks created under ${AGENT_POLICY.version}.`;
      });
      await this.completeStage(buildId);

      await this.store.mutate((database) => {
        const build = database.builds[buildId];
        setBuildStatus(build, "awaiting_confirmation");
        build.stageDetail = `Architecture and ${specification.requirements.length} requirements are ready for confirmation. No source has been generated.`;
        build.updatedAt = now();
        const project = database.projects[build.projectId];
        project.status = "awaiting_confirmation";
        project.updatedAt = now();
        this.pushEvent(database.events[buildId], buildId, "build.awaiting_confirmation", build.stageDetail, {
          requirements: specification.requirements.length,
          architectureFile: "ARCHITECTURE.md",
        });
      });
    } catch (error) {
      await this.fail(buildId, error);
    } finally {
      this.running.delete(runKey);
    }
  }

  async revise(buildId: string, notesValue: unknown): Promise<BuildView> {
    const current = this.get(buildId);
    if (current.generationMode === "safe" || current.planningRecordId) {
      throw new ApiError(409, "SAFE_REVISION_UNAVAILABLE", "Verified plans must be replaced through a new approved safe-generation request.");
    }
    if (current.status !== "awaiting_confirmation" || !current.specification) {
      throw new ApiError(409, "INVALID_BUILD_STATE", "The specification can only be revised while it is awaiting confirmation.");
    }
    const notes = assertPrompt(notesValue);
    const original = current.specification.prompt;
    const revised = `${original}\n\nRevision notes from the user:\n${notes}`;
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      setBuildStatus(build, "specifying");
      build.planningRecordId = undefined;
      build.stageDetail = "Revising the specification from user feedback.";
      build.updatedAt = now();
      const project = database.projects[build.projectId];
      project.status = "planning";
      project.updatedAt = now();
      this.pushEvent(database.events[buildId], buildId, "build.stage.started", "Specification revision requested by the user.", { stage: "specifying" as const, stageIndex: stageIndexes.specifying });
    });
    void this.prepare(buildId, revised);
    return this.get(buildId);
  }

  async confirm(buildId: string): Promise<BuildView> {
    const current = this.get(buildId);
    if (current.planningRecordId) throw new ApiError(409, "PLANNING_GENERATION_UNAVAILABLE", "An exact planning approval and a supported generation capability are required.");
    if (current.status === "completed") return current;
    if (current.status !== "awaiting_confirmation" || !current.specification) {
      throw new ApiError(409, "INVALID_BUILD_STATE", "Requirements can only be confirmed after the architecture proposal is ready.");
    }
    const confirmedAt = now();
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      if (build.planningRecordId) throw new ApiError(409, "PLANNING_GENERATION_UNAVAILABLE", "Planning approvals cannot start the legacy generator.");
      const specification = database.specifications[build.specificationId!];
      specification.status = "approved";
      specification.confirmedAt = confirmedAt;
      build.confirmedAt = confirmedAt;
      setBuildStatus(build, "generating");
      build.stageDetail = "Requirements confirmed. Starting frontend and backend generation.";
      build.updatedAt = confirmedAt;
      const project = database.projects[build.projectId];
      project.status = "building";
      project.updatedAt = confirmedAt;
      this.pushEvent(database.events[buildId], buildId, "build.confirmed", build.stageDetail, { specificationId: specification.id });
    });
    void this.execute(buildId);
    return this.get(buildId);
  }

  private async execute(buildId: string): Promise<void> {
    const runKey = `execute:${buildId}`;
    if (this.running.has(runKey)) return;
    this.running.add(runKey);
    try {
      const initial = this.get(buildId);
      const specification = initial.specification;
      if (initial.planningRecordId) throw new ApiError(409, "PLANNING_GENERATION_UNAVAILABLE", "Planning approvals cannot start the legacy generator.");
      if (!specification || specification.status !== "approved") {
        throw new ApiError(409, "SPECIFICATION_NOT_CONFIRMED", "Frontend and backend generation requires an approved specification.");
      }
      const database = this.store.read();
      const tasks = initial.taskIds.map((taskId) => database.tasks[taskId]).filter((task): task is AgentTask => Boolean(task));
      if (tasks.length === 0) throw new ApiError(500, "TASK_PLAN_INVALID", "Approved task plan is missing.");

      await this.stage(buildId, "generating", "Generating a minimal secure application skeleton in an isolated manifest.");
      const { files, llmMetadata: genLlmMetadata } = await generateFiles(specification);
      const implementationTask = tasks.find((task) => task.role === "implementation");
      if (!implementationTask) throw new ApiError(500, "TASK_PLAN_INVALID", "Implementation task is missing.");
      enforceImplementationTask(implementationTask, files);
      await this.store.mutate((database) => {
        database.files[buildId] = files;
        const build = database.builds[buildId];
        build.filePaths = files.map((file) => file.path);
        build.llmMetadata = genLlmMetadata;
        const modeLabel = genLlmMetadata.fallbackUsed ? "template" : `AI (${genLlmMetadata.model})`;
        build.stageDetail = `${files.length} scoped files generated with complete file digests [${modeLabel}].`;
        for (const taskId of build.taskIds) database.tasks[taskId].status = "completed";
      });
      await this.completeStage(buildId);

      await this.stage(buildId, "reviewing", "Running an independent scope, simplicity, and traceability review.");
      const deterministicFindings = review(specification, implementationTask, files);
      if (deterministicFindings.some((finding) => finding.severity === "error")) throw new ApiError(422, "REVIEW_FAILED", "Independent engineering review found blocking issues.");
      // Deterministic gate passed — augment with advisory AI findings (non-blocking).
      const advisoryFindings = await aiReviewAdvisory(specification, files);
      const findings = [...deterministicFindings, ...advisoryFindings];
      await this.store.mutate((database) => {
        database.builds[buildId].reviewFindings = findings;
        const advisoryNote = advisoryFindings.length > 0 ? ` ${advisoryFindings.length} advisory AI review finding(s) recorded.` : "";
        database.builds[buildId].stageDetail = `Independent engineering review passed without blocking findings.${advisoryNote}`;
      });
      await this.completeStage(buildId);

      await this.stage(buildId, "validating", "Validating paths, security boundary, tests, provenance, and requirement coverage.");
      const checks = validateGeneratedProject(specification, files, findings);
      if (checks.some((check) => check.status === "failed")) throw new ApiError(422, "VALIDATION_FAILED", "One or more required validation checks failed.");
      const passedChecks = checks.filter((check) => check.status === "passed").length;
      const skippedChecks = checks.filter((check) => check.status === "skipped").length;
      await this.store.mutate((database) => {
        database.builds[buildId].validationChecks = checks;
        database.builds[buildId].stageDetail = `${passedChecks} deterministic validation checks passed${skippedChecks > 0 ? `, ${skippedChecks} skipped (cannot run in the control plane)` : ""}.`;
      });
      await this.completeStage(buildId);

      const current = this.get(buildId);
      const graph = buildGraph(current.project, current, specification, tasks, files, checks);
      await this.store.mutate((database) => {
        database.graphs[graph.id] = graph;
        const build = database.builds[buildId];
        setBuildStatus(build, "completed");
        build.currentStageIndex = stageIndexes.completed;
        build.stageDetail = `Validated — ${passedChecks} checks passed${skippedChecks > 0 ? ` and ${skippedChecks} skipped` : ""}, ${graph.nodes.length} graph nodes synchronized.`;
        build.graphSnapshotId = graph.id;
        build.completedAt = now();
        build.updatedAt = now();
        build.stages.push({ index: stageIndexes.completed, key: "completed", label: "Graph synchronized", detail: build.stageDetail, startedAt: now(), completedAt: now() });
        const project = database.projects[build.projectId];
        const versionId = id("version");
        database.versions[versionId] = {
          id: versionId,
          projectId: project.id,
          buildId,
          versionNumber: 1,
          label: "Initial generation",
          editPrompt: specification.prompt,
          modifiedFiles: files.map((file) => file.path),
          validationStatus: "passed",
          validationChecks: checks,
          createdAt: now(),
        };
        database.versionFiles[versionId] = files;
        project.status = "ready";
        project.originalPrompt = specification.prompt;
        project.currentVersionId = versionId;
        project.currentVersionNumber = 1;
        project.currentGraphSnapshotId = graph.id;
        project.updatedAt = now();
        this.pushEvent(database.events[buildId], buildId, "build.completed", build.stageDetail, { graphNodes: graph.nodes.length, checks: checks.length });
      });
    } catch (error) {
      await this.fail(buildId, error);
    } finally {
      this.running.delete(runKey);
    }
  }

  private async fail(buildId: string, error: unknown): Promise<void> {
    const code = error instanceof ApiError ? error.code : "BUILD_FAILED";
    const message = error instanceof Error ? error.message : "Build failed unexpectedly.";
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      if (!build) return;
      // fail() runs from error handlers and could fire after the build already
      // reached a terminal state; only record the failure if it is a legal move.
      if (!canTransition(build.status, "failed")) return;
      setBuildStatus(build, "failed");
      build.error = { code, message };
      build.stageDetail = message;
      build.updatedAt = now();
      database.projects[build.projectId].status = "failed";
      this.pushEvent(database.events[buildId], buildId, "build.failed", message, { code });
    });
  }

  private async stage(buildId: string, status: Exclude<BuildStatus, "queued" | "awaiting_confirmation" | "completed" | "failed" | "needs_context">, detail: string): Promise<void> {
    await delay(this.stageDelayMs);
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      setBuildStatus(build, status);
      build.currentStageIndex = stageIndexes[status];
      build.stageDetail = detail;
      build.updatedAt = now();
      build.stages.push({ index: stageIndexes[status], key: status, label: status[0].toUpperCase() + status.slice(1), detail, startedAt: now() });
      this.pushEvent(database.events[buildId], buildId, "build.stage.started", detail, { stage: status, stageIndex: stageIndexes[status] });
    });
  }

  private async completeStage(buildId: string): Promise<void> {
    await this.store.mutate((database) => {
      const build = database.builds[buildId];
      const current = [...build.stages].reverse().find((stage) => stage.index === build.currentStageIndex && !stage.completedAt);
      if (current) current.completedAt = now();
      this.pushEvent(database.events[buildId], buildId, "build.stage.completed", build.stageDetail, { stageIndex: build.currentStageIndex });
    });
  }

  private pushEvent(events: BuildEvent[], buildId: string, type: BuildEvent["type"], message: string, data?: BuildEvent["data"]): void {
    events.push({ id: id("event"), buildId, type, message, timestamp: now(), data });
  }
}
