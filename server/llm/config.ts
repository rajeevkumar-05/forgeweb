/**
 * LLM configuration — reads from environment variables with sensible defaults.
 *
 * Each setting accepts a canonical `FORGEWEB_LLM_*` variable and a shorter
 * `LLM_*` alias. When both are set, `FORGEWEB_LLM_*` wins.
 *
 *   FORGEWEB_LLM_PROVIDER / LLM_PROVIDER     — "ollama" | "openai-compatible"
 *                                              (aliases: openai, openrouter, groq,
 *                                               together, agentrouter, lmstudio → openai-compatible)
 *   FORGEWEB_LLM_MODEL / LLM_MODEL           — model identifier
 *   FORGEWEB_LLM_BASE_URL / LLM_BASE_URL     — API base URL
 *   FORGEWEB_LLM_API_KEY / LLM_API_KEY       — API key for cloud providers (never hardcoded)
 *   FORGEWEB_LLM_TEMPERATURE / LLM_TEMPERATURE — sampling temperature 0.0–2.0 (default: "0.1")
 *   FORGEWEB_LLM_MAX_TOKENS / LLM_MAX_TOKENS — max output tokens (default: "4096")
 *   FORGEWEB_LLM_TIMEOUT_MS / LLM_TIMEOUT_MS — request timeout in ms (default: "120000")
 *   FORGEWEB_LLM_ENABLED / LLM_ENABLED       — "true" | "false" (default: "true")
 *
 * A local `.env` file is loaded first (see `../env.ts`). Real environment
 * variables always take precedence over that file.
 */

import "../env.ts";

export type LlmProviderKind = "ollama" | "openai-compatible";

export interface LlmConfig {
  readonly enabled: boolean;
  readonly provider: LlmProviderKind;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

/**
 * Read an environment setting, preferring the canonical `FORGEWEB_LLM_<suffix>`
 * name and falling back to the shorter `LLM_<suffix>` alias, then a default.
 */
function env(suffix: string, fallback: string): string {
  const canonical = process.env[`FORGEWEB_LLM_${suffix}`]?.trim();
  if (canonical) return canonical;
  const alias = process.env[`LLM_${suffix}`]?.trim();
  if (alias) return alias;
  // Accept TOKENROUTER_API_KEY as an additional alias for the API key.
  if (suffix === "API_KEY") {
    const tokenRouter = process.env["TOKENROUTER_API_KEY"]?.trim();
    if (tokenRouter) return tokenRouter;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a provider string to one of the two supported provider kinds.
 * Common OpenAI-compatible gateways are accepted as friendly aliases.
 */
function normalizeProvider(raw: string): LlmProviderKind {
  const value = raw.trim().toLowerCase();
  if (value === "ollama") return "ollama";
  if (value === "openai-compatible") return "openai-compatible";
  const openAiCompatibleAliases = new Set([
    "openai",
    "openrouter",
    "open-router",
    "groq",
    "together",
    "togetherai",
    "together-ai",
    "agentrouter",
    "agent-router",
    "tokenrouter",
    "token-router",
    "lmstudio",
    "lm-studio",
    "vllm",
    "tgi",
    "mistral",
    "deepseek",
    "fireworks",
  ]);
  if (openAiCompatibleAliases.has(value)) return "openai-compatible";
  throw new Error(
    `Unsupported LLM provider: "${raw}". Use "ollama" or "openai-compatible" (or an alias such as openai, openrouter, groq, together, agentrouter).`,
  );
}

export function loadLlmConfig(): LlmConfig {
  const provider = normalizeProvider(env("PROVIDER", "ollama"));

  const defaultBaseUrl = provider === "ollama"
    ? "http://127.0.0.1:11434"
    : "http://127.0.0.1:1234/v1"; // LM Studio default

  const defaultModel = provider === "ollama"
    ? "qwen2.5-coder:7b-instruct"
    : "gpt-4o-mini";

  return {
    enabled: env("ENABLED", "true").toLowerCase() !== "false",
    provider,
    model: env("MODEL", defaultModel),
    baseUrl: env("BASE_URL", defaultBaseUrl).replace(/\/+$/, ""),
    apiKey: env("API_KEY", ""),
    temperature: clamp(parseFloat(env("TEMPERATURE", "0.1")), 0, 2),
    maxTokens: Math.max(256, parseInt(env("MAX_TOKENS", "4096"), 10) || 4096),
    timeoutMs: Math.max(5_000, parseInt(env("TIMEOUT_MS", "120000"), 10) || 120_000),
  };
}

/** Singleton config — computed once at startup. */
let cachedConfig: LlmConfig | undefined;

export function getLlmConfig(): LlmConfig {
  if (!cachedConfig) cachedConfig = loadLlmConfig();
  return cachedConfig;
}

/** Reset cached config (useful for tests or runtime reconfiguration). */
export function resetLlmConfig(): void {
  cachedConfig = undefined;
}
