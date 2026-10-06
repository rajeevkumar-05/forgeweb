/**
 * LLM response parser — extracts and validates structured JSON from
 * LLM output, handling common issues like markdown fences and trailing text.
 */

import type { GeneratedFile, ReviewFinding } from "../domain.ts";
import { digest, safePath } from "../lib.ts";

/**
 * Extract JSON from an LLM response that may contain markdown code fences
 * or surrounding text.
 */
export function extractJson(raw: string): string {
  // Try to find JSON inside ```json ... ``` or ``` ... ``` fences
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a top-level JSON object or array using bracket boundaries
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }

  const firstBracket = raw.indexOf("[");
  const lastBracket = raw.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return raw.slice(firstBracket, lastBracket + 1).trim();
  }

  return raw.trim();
}

/**
 * Safely parse JSON from LLM output. Returns null on failure.
 */
export function safeParseJson<T>(raw: string): T | null {
  try {
    const cleaned = extractJson(raw);
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// --- Specification parsing ---

export interface ParsedSpecification {
  productName: string;
  summary: string;
  roles: string[];
  entities: string[];
  requirements: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: "P0" | "P1";
  }>;
  assumptions: string[];
  architectureNotes?: {
    pages?: string[];
    backendModules?: string[];
    securityNotes?: string[];
  };
}

export function parseSpecificationResponse(raw: string): ParsedSpecification | null {
  const parsed = safeParseJson<ParsedSpecification>(raw);
  if (!parsed) return null;

  // Validate minimum structure
  if (
    typeof parsed.productName !== "string" || !parsed.productName ||
    !Array.isArray(parsed.roles) || parsed.roles.length === 0 ||
    !Array.isArray(parsed.entities) || parsed.entities.length === 0 ||
    !Array.isArray(parsed.requirements) || parsed.requirements.length === 0
  ) {
    return null;
  }

  // Validate each requirement
  for (const req of parsed.requirements) {
    if (!req.id || !req.title || !req.description) return null;
    if (!Array.isArray(req.acceptanceCriteria)) req.acceptanceCriteria = [req.description];
    if (req.priority !== "P0" && req.priority !== "P1") req.priority = "P0";
  }

  return parsed;
}

// --- File generation parsing ---

interface RawFileEntry {
  path: string;
  content: string;
  requirementIds: string[];
}

export interface ParsedFiles {
  files: GeneratedFile[];
}

export function parseFileGenerationResponse(raw: string): ParsedFiles | null {
  const parsed = safeParseJson<{ files: RawFileEntry[] }>(raw);
  if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) return null;

  const files: GeneratedFile[] = [];

  for (const entry of parsed.files) {
    if (typeof entry.path !== "string" || !entry.path) continue;
    if (typeof entry.content !== "string" || !entry.content) continue;
    if (!Array.isArray(entry.requirementIds) || entry.requirementIds.length === 0) continue;

    const sanitizedPath = safePath(entry.path);
    files.push({
      path: sanitizedPath,
      content: entry.content,
      requirementIds: entry.requirementIds,
      digest: digest(entry.content),
    });
  }

  return files.length > 0 ? { files } : null;
}

// --- Edit response parsing ---

export interface ParsedEdit {
  modifiedFiles: GeneratedFile[];
  summary: string;
}

export function parseEditResponse(raw: string): ParsedEdit | null {
  const parsed = safeParseJson<{ modifiedFiles: RawFileEntry[]; summary?: string }>(raw);
  if (!parsed || !Array.isArray(parsed.modifiedFiles) || parsed.modifiedFiles.length === 0) return null;

  const modifiedFiles: GeneratedFile[] = [];

  for (const entry of parsed.modifiedFiles) {
    if (typeof entry.path !== "string" || !entry.path) continue;
    if (typeof entry.content !== "string" || !entry.content) continue;
    if (!Array.isArray(entry.requirementIds)) entry.requirementIds = [];

    modifiedFiles.push({
      path: safePath(entry.path),
      content: entry.content,
      requirementIds: entry.requirementIds,
      digest: digest(entry.content),
    });
  }

  return modifiedFiles.length > 0
    ? { modifiedFiles, summary: parsed.summary ?? "AI-powered edit applied." }
    : null;
}

// --- Review response parsing ---

export interface ParsedReview {
  findings: Array<{
    severity: "info" | "warning" | "error";
    message: string;
    path?: string;
  }>;
  summary: string;
}

export function parseReviewResponse(raw: string): ParsedReview | null {
  const parsed = safeParseJson<ParsedReview>(raw);
  if (!parsed || !Array.isArray(parsed.findings) || parsed.findings.length === 0) return null;

  // Validate severity values
  for (const finding of parsed.findings) {
    if (!["info", "warning", "error"].includes(finding.severity)) {
      finding.severity = "info";
    }
    if (typeof finding.message !== "string" || !finding.message) return null;
  }

  return parsed;
}
