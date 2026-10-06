/**
 * OpenAI-compatible LLM provider — works with any server that exposes
 * the `/v1/chat/completions` endpoint, including:
 *   - Together AI
 *   - Groq
 *   - LM Studio
 *   - vLLM
 *   - OpenRouter
 *   - text-generation-inference (TGI)
 */

import type { LlmConfig } from "./config.ts";
import type { LlmOptions, LlmProvider, LlmResponse } from "./provider.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason: string;
}

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ModelsResponse {
  data: Array<{ id: string }>;
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly config: LlmConfig;

  constructor(config: LlmConfig, displayName?: string) {
    this.config = config;
    this.name = displayName ?? this.inferProviderName(config.baseUrl);
  }

  private inferProviderName(baseUrl: string): string {
    if (baseUrl.includes("together")) return "Together AI";
    if (baseUrl.includes("groq")) return "Groq";
    if (baseUrl.includes("openrouter")) return "OpenRouter";
    if (baseUrl.includes("agentrouter")) return "AgentRouter";
    if (baseUrl.includes("tokenrouter")) return "TokenRouter";
    if (baseUrl.includes("api.openai.com")) return "OpenAI";
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) return "Local (OpenAI-compatible)";
    return "OpenAI-compatible";
  }

  private endpoint(path: string): string {
    const base = this.config.baseUrl.replace(/\/+v1\/?$/, "").replace(/\/+$/, "");
    const cleanPath = path.replace(/^\/+/, "");
    return `${base}/${cleanPath}`;
  }

  async generate(prompt: string, options?: LlmOptions): Promise<LlmResponse> {
    const startTime = Date.now();
    const messages: ChatMessage[] = [];

    if (options?.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.endpoint("v1/chat/completions"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          temperature: options?.temperature ?? this.config.temperature,
          max_tokens: options?.maxTokens ?? this.config.maxTokens,
          ...(options?.stop ? { stop: options.stop } : {}),
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`${this.name} returned ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      const durationMs = Date.now() - startTime;

      return {
        content,
        model: data.model ?? this.config.model,
        tokensUsed: {
          prompt: data.usage?.prompt_tokens ?? 0,
          completion: data.usage?.completion_tokens ?? 0,
        },
        durationMs,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private lastAvailableCheck: { result: boolean; timestamp: number } | undefined;

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.lastAvailableCheck && now - this.lastAvailableCheck.timestamp < 15_000) {
      return this.lastAvailableCheck.result;
    }
    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(this.endpoint("v1/models"), {
          headers,
          signal: controller.signal,
        });

        // 200 OK or 429 (rate-limited on free tier) confirms the gateway is reachable and authorized.
        const isOk = response.ok || response.status === 429;
        this.lastAvailableCheck = { result: isOk, timestamp: now };
        return isOk;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      this.lastAvailableCheck = { result: false, timestamp: now };
      return false;
    }
  }
}
