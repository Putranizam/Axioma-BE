import { DetectedIntent, ThinkingMode } from "./intelligenceLayer";
import { LanguageCode, resolveLanguageCode } from "../utils/promptBuilder";

export interface ModelSelectionInput {
  thinkingMode?: ThinkingMode | string;
  intent?: DetectedIntent | string;
  language?: LanguageCode | string;
  messageLength?: number;
}

export interface ModelSelectionResult {
  selectedModel: string;
  tier: "primary" | "fast";
  reason: string;
}

const REGIONAL_LANGUAGES = new Set<LanguageCode>(["jv-ngoko", "jv-krama", "su"]);

export function getPrimaryGeminiModel(): string {
  return (process.env.GEMINI_PRIMARY_MODEL || "gemini-3-flash-preview").trim();
}

export function getFastGeminiModel(): string {
  return (process.env.GEMINI_FAST_MODEL || "gemini-flash-lite-latest").trim();
}

/**
 * Axioma Model Router:
 * - Regional languages (Jawa/Sunda) or complex tasks (deep/critical or coding/analysis) -> primary Gemini model.
 * - Quick & short tasks -> fastest/most economical Gemini Flash-Lite model.
 */
export function selectModel(input: ModelSelectionInput): ModelSelectionResult {
  const safeLang = resolveLanguageCode(input.language);
  const thinking = String(input.thinkingMode || "quick").toLowerCase();
  const intent = String(input.intent || "general").toLowerCase();
  const msgLen = typeof input.messageLength === "number" ? input.messageLength : 0;

  const primaryModel = getPrimaryGeminiModel();
  const fastModel = getFastGeminiModel();

  if (REGIONAL_LANGUAGES.has(safeLang)) {
    return {
      selectedModel: primaryModel,
      tier: "primary",
      reason: `regional_language:${safeLang}`,
    };
  }

  if (thinking === "deep" || thinking === "critical") {
    return {
      selectedModel: primaryModel,
      tier: "primary",
      reason: `thinking_mode:${thinking}`,
    };
  }

  if (intent === "coding" || intent === "analysis") {
    return {
      selectedModel: primaryModel,
      tier: "primary",
      reason: `complex_intent:${intent}`,
    };
  }

  if (thinking === "quick" && msgLen <= 240) {
    return {
      selectedModel: fastModel,
      tier: "fast",
      reason: "quick_short_message",
    };
  }

  return {
    selectedModel: fastModel,
    tier: "fast",
    reason: "default_efficient",
  };
}

export interface AiRecoveryPayload {
  code: "AI_RECOVERY_NEEDED";
  message: string;
  retryable: true;
}

export class AiRecoveryError extends Error {
  code: "AI_RECOVERY_NEEDED" = "AI_RECOVERY_NEEDED";
  retryable = true as const;

  constructor(
    message = "Layanan AI sedang sibuk atau mengalami gangguan sementara. Silakan coba lagi."
  ) {
    super(message);
    this.name = "AiRecoveryError";
  }

  toPayload(): AiRecoveryPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: true,
    };
  }
}

export function isFallbackProviderConfigured(): boolean {
  return Boolean((process.env.FALLBACK_API_KEY || "").trim());
}

/**
 * Optional OpenAI-compatible fallback provider (e.g. Groq / OpenRouter).
 * Returns null cleanly if FALLBACK_API_KEY is not set in `.env`.
 */
export async function callOpenAiCompatibleFallback(params: {
  systemInstruction?: string;
  userPrompt: string;
  temperature?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  const apiKey = (process.env.FALLBACK_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("FALLBACK_API_KEY is not configured");
  }

  const baseUrl = (process.env.FALLBACK_BASE_URL || "https://api.groq.com/openai/v1")
    .trim()
    .replace(/\/+$/, "");
  const model = (process.env.FALLBACK_MODEL || "llama-3.3-70b-versatile").trim();

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (params.systemInstruction && params.systemInstruction.trim()) {
    messages.push({ role: "system", content: params.systemInstruction.trim() });
  }
  messages.push({ role: "user", content: params.userPrompt });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: params.signal,
    body: JSON.stringify({
      model,
      messages,
      temperature: params.temperature ?? 0.5,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Fallback provider HTTP ${response.status}: ${errText.slice(0, 200)}`
    );
  }

  const json = (await response.json()) as any;
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Fallback provider returned empty content");
  }

  return { text: text.trim(), model };
}

function isTransientRecoveryError(err: any): boolean {
  if (!err) return false;
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 429 || status === 503 || status === 504 || status === 502) {
    return true;
  }
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("overloaded") ||
    msg.includes("rate limit") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const timeoutPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error(`AI_RECOVERY_TIMEOUT after ${timeoutMs}ms`)),
      { once: true }
    );
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RecoveryOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
  recoveryMessage?: string;
}

export interface RecoveryExecutionResult<T> {
  result: T;
  fallbackUsed: boolean;
  retries: number;
}

/**
 * Axioma Error Recovery wrapper:
 * 1. Runs `primaryFn` with a safe timeout (default 25s).
 * 2. On transient error (429 / 503 / timeout), retries once after 800ms.
 * 3. If still failing and `fallbackFn` is provided (with FALLBACK_API_KEY configured), switches to fallback.
 * 4. If all fail, throws structured `AiRecoveryError` ({ code: 'AI_RECOVERY_NEEDED', message, retryable: true }).
 */
export async function executeWithRecovery<T>(
  primaryFn: (signal: AbortSignal) => Promise<T>,
  fallbackFn?: (signal: AbortSignal) => Promise<T>,
  options: RecoveryOptions = {}
): Promise<RecoveryExecutionResult<T>> {
  const timeoutMs = options.timeoutMs ?? 25_000;
  const retryDelayMs = options.retryDelayMs ?? 800;

  let retries = 0;

  try {
    const result = await runWithTimeout(primaryFn, timeoutMs);
    return { result, fallbackUsed: false, retries };
  } catch (firstErr: any) {
    if (isTransientRecoveryError(firstErr)) {
      retries = 1;
      await delay(retryDelayMs);
      try {
        const result = await runWithTimeout(primaryFn, timeoutMs);
        return { result, fallbackUsed: false, retries };
      } catch (retryErr: any) {
        if (fallbackFn && isFallbackProviderConfigured()) {
          try {
            const fbResult = await runWithTimeout(fallbackFn, timeoutMs);
            return { result: fbResult, fallbackUsed: true, retries };
          } catch {
            throw new AiRecoveryError(options.recoveryMessage);
          }
        }
        throw new AiRecoveryError(options.recoveryMessage);
      }
    }

    if (fallbackFn && isFallbackProviderConfigured()) {
      try {
        const fbResult = await runWithTimeout(fallbackFn, timeoutMs);
        return { result: fbResult, fallbackUsed: true, retries };
      } catch {
        throw new AiRecoveryError(options.recoveryMessage);
      }
    }

    throw new AiRecoveryError(options.recoveryMessage);
  }
}
