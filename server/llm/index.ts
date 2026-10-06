/**
 * LLM module entry point — provides a factory to create the configured
 * provider and re-exports all public types.
 */

import { getLlmConfig, type LlmConfig } from "./config.ts";
import type { LlmGenerationMetadata, LlmProvider } from "./provider.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";

export type { LlmConfig } from "./config.ts";
export type { LlmGenerationMetadata, LlmOptions, LlmProvider, LlmResponse } from "./provider.ts";
export { getLlmConfig, loadLlmConfig, resetLlmConfig } from "./config.ts";

/** Create the appropriate LLM provider from the current configuration. */
export function createLlmProvider(config?: LlmConfig): LlmProvider {
  const resolvedConfig = config ?? getLlmConfig();
  switch (resolvedConfig.provider) {
    case "ollama":
      return new OllamaProvider(resolvedConfig);
    case "openai-compatible":
      return new OpenAICompatibleProvider(resolvedConfig);
    default:
      throw new Error(`Unknown LLM provider: ${resolvedConfig.provider}`);
  }
}

/** Singleton provider instance — lazily initialized. */
let sharedProvider: LlmProvider | undefined;

/** Get the shared provider instance. Creates it on first call. */
export function getLlmProvider(): LlmProvider {
  if (!sharedProvider) sharedProvider = createLlmProvider();
  return sharedProvider;
}

/** Reset the shared provider (useful for tests or runtime reconfiguration). */
export function resetLlmProvider(): void {
  sharedProvider = undefined;
}

/**
 * Inject a specific provider instance as the shared provider. Intended for
 * tests (deterministic mock providers) and advanced runtime reconfiguration.
 * The next `getLlmProvider()` call returns this instance until it is reset.
 */
export function setLlmProvider(provider: LlmProvider): void {
  sharedProvider = provider;
}

/**
 * LLM status information for the `/api/llm/status` endpoint.
 */
export interface LlmStatus {
  enabled: boolean;
  available: boolean;
  provider: string;
  model: string;
  mode: "ai-powered" | "template-fallback";
  baseUrl: string;
}

/** Check the current LLM status. */
export async function getLlmStatus(): Promise<LlmStatus> {
  const config = getLlmConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      available: false,
      provider: config.provider,
      model: config.model,
      mode: "template-fallback",
      baseUrl: config.baseUrl,
    };
  }

  const provider = getLlmProvider();
  const available = await provider.isAvailable();

  return {
    enabled: true,
    available,
    provider: provider.name,
    model: config.model,
    mode: available ? "ai-powered" : "template-fallback",
    baseUrl: config.baseUrl,
  };
}

/** Create LLM metadata for recording in builds/versions. */
export function createFallbackMetadata(): LlmGenerationMetadata {
  const config = getLlmConfig();
  return {
    provider: config.provider,
    model: config.model,
    tokensUsed: { prompt: 0, completion: 0 },
    durationMs: 0,
    fallbackUsed: true,
  };
}
