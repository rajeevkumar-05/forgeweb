import type { AgentTask, GeneratedFile, MasterSpecification } from "./domain.ts";
import { ApiError, digest, id } from "./lib.ts";

const principles = [
  "Think before coding: expose material assumptions and ambiguity.",
  "Simplicity first: implement the smallest sufficient solution.",
  "Surgical changes: touch only task-scoped paths and behavior.",
  "Goal-driven execution: acceptance requires observable evidence.",
] as const;

export const AGENT_POLICY = Object.freeze({
  version: "forgeweb-karpathy-1.0.0",
  sourceRepository: "https://github.com/multica-ai/andrej-karpathy-skills",
  sourceRevision: "2c60614",
  sourceDigest: digest(principles.join("\n")),
  workflowReference: "https://github.com/garrytan/gstack",
  principles,
});

/**
 * File budget for the implementation task.
 *
 * The deterministic template emits a fixed 12-file skeleton, but real AI
 * generation produces a coherent multi-file frontend + backend and must not be
 * capped at the template size. This ceiling is generous enough for a full app
 * skeleton (frontend pages/components, backend modules, tests, scaffolding)
 * while still rejecting pathological runaway output. The added-line budget is
 * likewise sized for a real skeleton rather than the template.
 */
const IMPLEMENTATION_FILE_BUDGET = Object.freeze({
  maxFiles: 40,
  maxAddedLines: 20_000,
  maxDeletedLines: 0,
});

export function createTasks(buildId: string, specification: MasterSpecification): AgentTask[] {
  const requirementIds = specification.requirements.map((requirement) => requirement.id);
  const common = {
    buildId,
    requirementIds,
    forbiddenPaths: [".env", ".git", "node_modules", "../"],
    behaviorToPreserve: ["Approved specification intent", "Authorization boundaries", "Deterministic and reviewable output"],
    assumptions: specification.assumptions,
    policyPackVersion: AGENT_POLICY.version,
    policySourceRevision: AGENT_POLICY.sourceRevision,
    policySourceDigest: AGENT_POLICY.sourceDigest,
    status: "ready" as const,
  };
  return [
    {
      ...common,
      id: id("task"),
      role: "engineering_planner",
      objective: "Convert the approved specification into a minimal, ordered implementation plan.",
      allowedPaths: [],
      simplestSufficientApproach: "Use one secure TypeScript service boundary and explicit domain contracts.",
      changeBudget: { maxFiles: 0, maxAddedLines: 0, maxDeletedLines: 0 },
      acceptanceCriteria: ["Every P0 requirement is assigned to generated code and validation."],
      validationPlan: ["Check requirement coverage before generation."],
    },
    {
      ...common,
      id: id("task"),
      role: "implementation",
      objective: "Generate the smallest secure application skeleton satisfying the approved requirements.",
      allowedPaths: ["README.md", "ARCHITECTURE.md", "package.json", "frontend/", "backend/", "tests/"],
      simplestSufficientApproach: "Generate a prompt-specific React frontend, typed backend boundaries, access control, architecture, and acceptance tests without speculative services.",
      changeBudget: { ...IMPLEMENTATION_FILE_BUDGET },
      acceptanceCriteria: ["All files map to requirements.", "No generated path escapes the project.", "No unapproved dependency is introduced."],
      validationPlan: ["Verify paths and digests.", "Check requirement traceability."],
    },
    {
      ...common,
      id: id("task"),
      role: "engineering_reviewer",
      objective: "Independently review scope, simplicity, security boundaries, and requirement coverage.",
      allowedPaths: [],
      simplestSufficientApproach: "Review the immutable generated manifest and report evidence-linked findings.",
      changeBudget: { maxFiles: 0, maxAddedLines: 0, maxDeletedLines: 0 },
      acceptanceCriteria: ["Implementation does not self-approve.", "Unrelated or speculative files are rejected."],
      validationPlan: ["Run policy and manifest review."],
    },
    {
      ...common,
      id: id("task"),
      role: "validator",
      objective: "Validate generated artifacts and produce acceptance evidence.",
      allowedPaths: [],
      simplestSufficientApproach: "Run deterministic structural, security, and traceability checks.",
      changeBudget: { maxFiles: 0, maxAddedLines: 0, maxDeletedLines: 0 },
      acceptanceCriteria: ["Every required check passes with current evidence."],
      validationPlan: ["Validate file safety, required artifacts, policy provenance, and graph integrity."],
    },
  ];
}

export function enforceImplementationTask(task: AgentTask, files: GeneratedFile[]): void {
  if (task.role !== "implementation") throw new ApiError(500, "WRONG_TASK_ROLE", "Policy enforcement requires an implementation task.");
  if (files.length > task.changeBudget.maxFiles) throw new ApiError(422, "CHANGE_BUDGET_EXCEEDED", "Generated file count exceeds the approved task budget.");
  const allowed = task.allowedPaths;
  for (const file of files) {
    const permitted = allowed.some((path) => path.endsWith("/") ? file.path.startsWith(path) : file.path === path);
    if (!permitted) throw new ApiError(422, "PATH_SCOPE_VIOLATION", `Generated path is outside task scope: ${file.path}`);
    if (file.requirementIds.length === 0) throw new ApiError(422, "MISSING_TRACEABILITY", `Generated file has no requirement traceability: ${file.path}`);
  }
}
