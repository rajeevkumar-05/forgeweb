/**
 * Local environment file loading.
 *
 * ForgeWeb reads all provider settings from the environment — no key, URL, or
 * model name is ever hardcoded. To make local development practical without a
 * dependency, a `.env` file in the project root is loaded on startup using
 * Node's built-in loader.
 *
 * Precedence is deliberate and matches operator expectations:
 *
 *   real process environment  >  .env file  >  built-in defaults
 *
 * `process.loadEnvFile()` never overwrites a variable that is already set, so
 * an explicit `FORGEWEB_LLM_ENABLED=false pnpm test` always wins over the file,
 * and CI/production environments are never shadowed by a stray local `.env`.
 *
 * The file itself is gitignored (`.env`, `.env.*`); `.env.example` is the
 * committed, secret-free template. Importing this module is idempotent: ESM
 * caches it, so every entry point can safely import it.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

function envFilePath(): string {
  const configured = process.env.FORGEWEB_ENV_FILE?.trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  return resolve(process.cwd(), ".env");
}

const path = envFilePath();

if (existsSync(path)) {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    // A malformed local file must never prevent the control plane from starting.
    // The path is reported, not the contents, so no secret reaches the log.
    console.warn(`[ForgeWeb] Ignoring unreadable environment file at ${path}:`, error instanceof Error ? error.message : error);
  }
}

/** The environment file path that was considered, for diagnostics. */
export const environmentFilePath = path;
