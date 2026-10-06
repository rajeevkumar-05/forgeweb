/**
 * LLM provider interface — the abstraction boundary between ForgeWeb's
 * workflow logic and any specific LLM backend (Ollama, Together AI, Groq, etc.).
 *
 * Every provider implements `LlmProvider`. The workflow only ever calls
 * `generate()` and `isAvailable()`.
 */

export interface LlmOptions {
  /** Sampling temperature. Lower = more deterministic. Default from config. */
  temperature?: number;
  /** Maximum output tokens. Default from config. */
  maxTokens?: number;
  /** System prompt (role instructions, coding discipline, output format). */
  systemPrompt?: string;
  /** Stop sequences — generation halts when any of these are emitted. */
  stop?: string[];
}

export interface LlmResponse {
  /** The generated text content. */
  content: string;
  /** Model identifier that produced this response. */
  model: string;
  /** Token usage breakdown. */
  tokensUsed: { prompt: number; completion: number };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

export interface LlmProvider {
  /** The display name of this provider (e.g. "Ollama", "Together AI"). */
  readonly name: string;

  /**
   * Generate a completion from the given prompt.
   * Throws on network errors or provider-side failures.
   */
  generate(prompt: string, options?: LlmOptions): Promise<LlmResponse>;

  /**
   * Check whether the provider is reachable and the configured model is available.
   * Returns `true` if ready, `false` otherwise. Should never throw.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Metadata recorded alongside every LLM-involved generation.
 * Stored in Build and ProjectVersion for observability.
 */
export interface LlmGenerationMetadata {
  provider: string;
  model: string;
  tokensUsed: { prompt: number; completion: number };
  durationMs: number;
  /** True if the LLM was unavailable or returned invalid output and
   *  ForgeWeb fell back to template-based generation. */
  fallbackUsed: boolean;
}
