/**
 * Structured prompts for each ForgeWeb generation stage.
 *
 * Each function constructs a system prompt + user prompt pair designed for
 * instruction-following code models like CodeLlama Instruct or Qwen2.5-Coder.
 *
 * Output format is always strict JSON so it can be machine-parsed.
 */

import type { GeneratedFile, MasterSpecification, Requirement } from "../domain.ts";
import { AGENT_POLICY } from "../policy.ts";

/** System prompt establishing the coding discipline for all generation. */
const SYSTEM_PROMPT = `You are ForgeWeb, an expert full-stack TypeScript code generator.

Coding discipline (source: ${AGENT_POLICY.sourceRepository} @ ${AGENT_POLICY.sourceRevision}):
${AGENT_POLICY.principles.map((p, i) => `${i + 1}. ${p}`).join("\n")}

Rules:
- Generate only TypeScript, React (TSX), and CSS code.
- Every generated file MUST map to at least one requirement ID.
- Use server-side authorization — never infer security from hidden UI.
- Prefer simplicity: smallest sufficient implementation.
- All responses MUST be valid JSON. No markdown fences, no explanations outside JSON.
- Follow the exact output schema specified in each prompt.`;

/** Prompt to compile a user idea into structured requirements and architecture. */
export function buildSpecificationPrompt(prompt: string): { system: string; user: string } {
  return {
    system: SYSTEM_PROMPT,
    user: `Analyze the following application idea and produce a structured specification.

APPLICATION IDEA:
${prompt}

OUTPUT SCHEMA (respond with ONLY this JSON, nothing else):
{
  "productName": "string — a proper product name derived from the idea",
  "summary": "string — one-sentence summary of the product",
  "roles": ["string — user roles needed, e.g. Owner, Member, Client"],
  "entities": ["string — domain entities, e.g. User, Project, Invoice"],
  "requirements": [
    {
      "id": "REQ-001",
      "title": "string — requirement title",
      "description": "string — what this requirement entails",
      "acceptanceCriteria": ["string — testable acceptance criteria"],
      "priority": "P0 or P1"
    }
  ],
  "assumptions": ["string — technical assumptions"],
  "architectureNotes": {
    "pages": ["string — frontend pages needed"],
    "backendModules": ["string — backend modules needed"],
    "securityNotes": ["string — security considerations"]
  }
}

RULES:
- Always include Authentication (REQ-001) and Authorization (REQ-002) requirements.
- Generate 5-10 requirements covering core workflow, validation, auditability, and quality.
- Entities should always include "User" plus domain-specific entities.
- Roles should always include "Owner" and "Member".`,
  };
}

/** Prompt to generate React frontend files from an approved specification. */
export function buildFrontendPrompt(specification: MasterSpecification): { system: string; user: string } {
  const reqList = specification.requirements
    .map((r: Requirement) => `  - ${r.id}: ${r.title} — ${r.description}`)
    .join("\n");

  return {
    system: SYSTEM_PROMPT,
    user: `Generate a professional React/TypeScript frontend for the following approved specification.

PRODUCT: ${specification.productName}
SUMMARY: ${specification.summary}
ROLES: ${specification.roles.join(", ")}
ENTITIES: ${specification.entities.join(", ")}

REQUIREMENTS:
${reqList}

PAGES NEEDED: ${specification.architecture.frontend.pages.join(", ")}
COMPONENTS NEEDED: ${specification.architecture.frontend.components.join(", ")}

OUTPUT SCHEMA (respond with ONLY this JSON, nothing else):
{
  "files": [
    {
      "path": "frontend/src/App.tsx",
      "content": "string — full file content",
      "requirementIds": ["REQ-001", "REQ-003"]
    },
    {
      "path": "frontend/src/styles.css",
      "content": "string — full CSS content",
      "requirementIds": ["REQ-006"]
    },
    {
      "path": "frontend/src/main.tsx",
      "content": "string — React entry point",
      "requirementIds": ["REQ-006"]
    }
  ]
}

RULES:
- App.tsx must export a default function component named App.
- Use modern React 19 patterns (hooks, functional components, state management).
- Build rich, fully interactive features specific to the product (e.g. playable canvas/controls for games, workflows for tools, dashboards for portals).
- Include responsive design with mobile/tablet/desktop support.
- Use CSS custom properties and modern styling for a premium dark-mode or thematic aesthetic.
- Include accessible ARIA labels and keyboard navigation.
- Every file MUST have at least one requirementId.
- File paths must start with "frontend/".
- Generate 3-5 frontend files maximum.`,
  };
}

/** Prompt to generate typed backend files from an approved specification. */
export function buildBackendPrompt(specification: MasterSpecification): { system: string; user: string } {
  const entityUnion = specification.entities.map((e: string) => `"${e}"`).join(" | ");
  const roleUnion = specification.roles.map((r: string) => `"${r}"`).join(" | ");

  return {
    system: SYSTEM_PROMPT,
    user: `Generate typed Node.js/TypeScript backend files for the following approved specification.

PRODUCT: ${specification.productName}
ENTITIES: ${specification.entities.join(", ")}
ENTITY UNION TYPE: ${entityUnion}
ROLES: ${specification.roles.join(", ")}
ROLE UNION TYPE: ${roleUnion}

REQUIREMENTS:
${specification.requirements.map((r: Requirement) => `  - ${r.id}: ${r.title}`).join("\n")}

BACKEND MODULES NEEDED: ${specification.architecture.backend.modules.join(", ")}

OUTPUT SCHEMA (respond with ONLY this JSON, nothing else):
{
  "files": [
    {
      "path": "backend/src/domain/model.ts",
      "content": "string — domain type definitions using the entity and role unions",
      "requirementIds": ["REQ-003", "REQ-004"]
    },
    {
      "path": "backend/src/security/access-control.ts",
      "content": "string — server-side access control with role and ownership checks",
      "requirementIds": ["REQ-001", "REQ-002", "REQ-004"]
    },
    {
      "path": "backend/src/api/contracts.ts",
      "content": "string — typed API request/response contracts with audit envelopes",
      "requirementIds": ["REQ-003", "REQ-004", "REQ-005"]
    },
    {
      "path": "backend/src/index.ts",
      "content": "string — backend entry point",
      "requirementIds": ["REQ-001", "REQ-002", "REQ-003"]
    }
  ]
}

RULES:
- Use strict TypeScript types derived from the entity and role unions.
- Access control MUST be server-side. Export canAccess and requireAccess functions.
- Include audit envelope types with requirementId and actorId fields.
- File paths must start with "backend/".
- Generate exactly 4 backend files.`,
  };
}

/** Prompt for AI-powered scoped edits on an existing project. */
export function buildEditPrompt(
  editPrompt: string,
  currentFiles: GeneratedFile[],
  specification: MasterSpecification,
): { system: string; user: string } {
  const fileList = currentFiles
    .map((f: GeneratedFile) => `--- ${f.path} ---\n${f.content}\n`)
    .join("\n");

  return {
    system: SYSTEM_PROMPT,
    user: `Apply the following edit to the existing project files.

PRODUCT: ${specification.productName}
EDIT REQUEST: ${editPrompt}

CURRENT FILES:
${fileList}

OUTPUT SCHEMA (respond with ONLY this JSON, nothing else):
{
  "modifiedFiles": [
    {
      "path": "string — path of the file being modified",
      "content": "string — the COMPLETE new content of the file",
      "requirementIds": ["string — requirement IDs this file satisfies"]
    }
  ],
  "summary": "string — brief summary of what was changed"
}

RULES:
- Only include files that were actually changed.
- Return the COMPLETE file content, not just the diff.
- Preserve all existing requirement traceability.
- Do not create new files unless the edit explicitly requires it.
- Do not remove existing functionality unless the edit explicitly requests it.
- Maintain consistent code style with the existing files.`,
  };
}

/** Prompt for AI-powered independent code review. */
export function buildReviewPrompt(
  files: GeneratedFile[],
  specification: MasterSpecification,
): { system: string; user: string } {
  const fileList = files
    .map((f: GeneratedFile) => `--- ${f.path} (traces: ${f.requirementIds.join(", ")}) ---\n${f.content}\n`)
    .join("\n");

  return {
    system: `You are an independent code reviewer. You did NOT write this code.
Review for: scope violations, missing requirements, security issues, unnecessary complexity.
${AGENT_POLICY.principles.map((p, i) => `${i + 1}. ${p}`).join("\n")}`,
    user: `Review the following generated files against the approved specification.

PRODUCT: ${specification.productName}
REQUIREMENTS:
${specification.requirements.map((r: Requirement) => `  - ${r.id}: ${r.title} [${r.priority}]`).join("\n")}

GENERATED FILES:
${fileList}

OUTPUT SCHEMA (respond with ONLY this JSON, nothing else):
{
  "findings": [
    {
      "severity": "info | warning | error",
      "message": "string — description of the finding",
      "path": "string | null — file path if applicable"
    }
  ],
  "summary": "string — overall review summary"
}

RULES:
- severity "error" means a blocking issue that must be fixed.
- severity "warning" means a potential issue worth noting.
- severity "info" means a positive observation.
- If everything looks good, return a single "info" finding.`,
  };
}
