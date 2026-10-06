/**
 * Ollama LLM provider — talks to a locally running Ollama instance.
 *
 * API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Uses the `/api/chat` endpoint for instruction-following models and
 * `/api/tags` to verify model availability.
 */

import type { LlmConfig } from "./config.ts";
import type { LlmOptions, LlmProvider, LlmResponse } from "./provider.ts";

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

export class OllamaProvider implements LlmProvider {
  readonly name = "Ollama";
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: LlmOptions): Promise<LlmResponse> {
    const startTime = Date.now();
    const messages: OllamaChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${this.config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          stream: false,
          options: {
            temperature: options?.temperature ?? this.config.temperature,
            num_predict: options?.maxTokens ?? this.config.maxTokens,
            ...(options?.stop ? { stop: options.stop } : {}),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`Ollama returned ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as OllamaChatResponse;
      const durationMs = Date.now() - startTime;

      return {
        content: data.message?.content?.trim() ?? "",
        model: data.model ?? this.config.model,
        tokensUsed: {
          prompt: data.prompt_eval_count ?? 0,
          completion: data.eval_count ?? 0,
        },
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(`${this.config.baseUrl}/api/tags`, {
          signal: controller.signal,
        });

        if (!response.ok) return false;

        const data = (await response.json()) as OllamaTagsResponse;
        const modelBase = this.config.model.split(":")[0];
        return data.models?.some(
          (m) => m.name === this.config.model || m.name.startsWith(modelBase),
        ) ?? false;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
}
