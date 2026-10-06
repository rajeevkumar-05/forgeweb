import { createHash, randomUUID } from "node:crypto";

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || `project-${Date.now()}`;
}

export function assertPrompt(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "INVALID_PROMPT", "Prompt must be a string.");
  const prompt = value.trim();
  if (prompt.length < 12) throw new ApiError(400, "PROMPT_TOO_SHORT", "Describe the product in at least 12 characters.");
  if (prompt.length > 4_000) throw new ApiError(400, "PROMPT_TOO_LONG", "Prompt must be 4,000 characters or fewer.");
  return prompt;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Path segments that must never appear in a generated project path.
 * These protect against escaping the workspace (`..`), leaking secrets
 * (`.env`, `.env.*`), and exposing control-plane/dependency artifacts
 * (`.git`, `node_modules`). Matching is segment-based so legitimate files
 * such as `.gitignore` or `environment.ts` are still allowed.
 */
function isForbiddenSegment(segment: string): boolean {
  return (
    segment === ".git" ||
    segment === "node_modules" ||
    segment === ".env" ||
    segment.startsWith(".env.")
  );
}

export function safePath(path: string): string {
  if (typeof path !== "string") throw new ApiError(400, "UNSAFE_PATH", "Generated path must be a string.");
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("\0")) {
    throw new ApiError(400, "UNSAFE_PATH", `Unsafe generated path: ${path}`);
  }
  const segments = normalized.split("/");
  if (segments.some(isForbiddenSegment)) {
    throw new ApiError(400, "UNSAFE_PATH", `Generated path targets a protected location: ${path}`);
  }
  return normalized;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
