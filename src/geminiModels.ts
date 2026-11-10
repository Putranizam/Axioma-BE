/**
 * Centralized Gemini Model Fallback Chain & Execution Engine for Axioma
 *
 * Supports:
 * - Environment variable override: GEMINI_MODEL_CHAIN="model1,model2,model3"
 * - In-memory cooldown tracking for 429 (quota), 404 (deprecated/not found), 500, 503, timeouts
 * - Unified callGeminiWithFallback helper for chat, voice transcription, and title generation
 */

export const DEFAULT_MODEL_CHAIN: readonly string[] = [
  "gemini-flash-lite-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3-flash-preview",
  "gemini-3.8-flash",
];

// Cooldown durations
export const COOLDOWN_DURATIONS = {
  NOT_FOUND_404: 24 * 3600_000, // 24 hours for 404 (deprecated / model does not exist)
  QUOTA_429: 2 * 60_000, // 2 minutes for transient rate limits
  DAILY_QUOTA_ZERO: 30 * 60_000, // 30 minutes when limit: 0 or daily quota exhausted
  SERVER_ERROR_5XX: 60_000, // 1 minute for 500 / 502 / 503 / 504
  TIMEOUT: 60_000, // 1 minute for timeouts
} as const;

// In-memory model cooldown map: modelName -> timestamp until cooldown expires
export const modelCooldownUntil = new Map<string, number>();

/**
 * Returns the effective model chain.
 * Can be overridden globally via process.env.GEMINI_MODEL_CHAIN
 * or per-call via customChain.
 */
export function getModelChain(customChain?: readonly string[]): string[] {
  if (customChain && customChain.length > 0) {
    return [...customChain];
  }
  const envChain = (process.env.GEMINI_MODEL_CHAIN || "").trim();
  if (envChain) {
    const parsed = envChain
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
  }
  return [...DEFAULT_MODEL_CHAIN];
}

export const MODEL_CHAIN: string[] = getModelChain();

/**
 * Determines whether an error from Google Gemini is eligible for model fallback.
 * Covers:
 * - 404: Model not found / deprecated
 * - 429: Rate limit / quota exhausted
 * - 500: Internal server error
 * - 502: Bad gateway
 * - 503: Service unavailable / high demand / overloaded
 * - 504: Gateway timeout
 * - Network timeouts, connection resets, aborted requests
 */
export function isRetryableGeminiError(err: any): boolean {
  if (!err) return false;
  const status = typeof err?.status === "number" ? err.status : undefined;
  if (status === 400) return false;
  if (status !== undefined && [404, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const message = String(err?.message || err || "").toLowerCase();
  if (
    message.includes("400") ||
    message.includes("invalid argument") ||
    message.includes("bad request") ||
    message.includes("unsupported mime") ||
    message.includes("invalid audio")
  ) {
    return false;
  }

  const retryableKeywords = [
    "404",
    "not found",
    "is not supported",
    "no longer available",
    "deprecated",
    "429",
    "quota",
    "rate limit",
    "resource_exhausted",
    "too many requests",
    "500",
    "internal server error",
    "502",
    "bad gateway",
    "503",
    "service unavailable",
    "overloaded",
    "high demand",
    "504",
    "gateway timeout",
    "timeout",
    "timed out",
    "first_chunk_timeout",
    "stream_idle_timeout",
    "fetch failed",
    "econnreset",
    "etimedout",
    "socket hang up",
    "network",
    "aborted",
    "deadline exceeded",
  ];

  return retryableKeywords.some((k) => message.includes(k));
}

export function isQuotaOrRateLimitError(err: any): boolean {
  if (err?.status === 429) return true;
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("resource_exhausted") ||
    msg.includes("too many requests")
  );
}

export function isZeroQuotaError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("limit: 0") || msg.includes("perday") || msg.includes("quota exceeded");
}

export function clearModelCooldown(modelName: string): void {
  modelCooldownUntil.delete(modelName);
}

export function setModelCooldown(modelName: string, durationMs: number): void {
  modelCooldownUntil.set(modelName, Date.now() + durationMs);
}

export interface FallbackAttemptLog {
  model: string;
  status: "ok" | "error" | "timeout" | "429_quota" | "404_not_found";
  elapsedMs: number;
  error?: string;
}

export interface FallbackOptions {
  customChain?: readonly string[];
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  purpose?: string;
  onModelAttempt?: (model: string, attempt: number, total: number) => void;
  onModelFailure?: (model: string, error: any, attempt: number, elapsedMs: number) => void;
}

export interface FallbackResult<T> {
  result: T;
  modelUsed: string;
  attempts: FallbackAttemptLog[];
  fallbackCount: number;
  fallbackOverheadMs: number;
}

/**
 * Executes a Gemini request function with automatic fallback across the model chain.
 * Tries each model in order, skipping or deprioritizing models currently in cooldown.
 */
export async function callGeminiWithFallback<T>(
  requestFn: (modelName: string, signal?: AbortSignal) => Promise<T>,
  options: FallbackOptions = {}
): Promise<FallbackResult<T>> {
  const chain = getModelChain(options.customChain);
  const now = Date.now();

  // Prioritize models that are not in cooldown
  const availableModels = chain.filter((m) => (modelCooldownUntil.get(m) || 0) <= now);
  const coolingModels = chain.filter((m) => (modelCooldownUntil.get(m) || 0) > now);
  const orderedModels = availableModels.length > 0 ? [...availableModels, ...coolingModels] : [...chain];

  const attempts: FallbackAttemptLog[] = [];
  let lastError: any = null;
  let fallbackOverheadMs = 0;

  for (let i = 0; i < orderedModels.length; i++) {
    const modelName = orderedModels[i];
    const attemptNum = i + 1;

    if (options.abortSignal?.aborted) {
      throw new Error("Permintaan ke Gemini dibatalkan sebelum selesai.");
    }

    options.onModelAttempt?.(modelName, attemptNum, orderedModels.length);

    const attemptStart = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let didTimeout = false;

    if (options.abortSignal) {
      options.abortSignal.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true }
      );
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, options.timeoutMs);
    }

    try {
      const result = await requestFn(modelName, controller.signal);
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - attemptStart;

      clearModelCooldown(modelName);

      attempts.push({
        model: modelName,
        status: "ok",
        elapsedMs: elapsed,
      });

      console.info(
        `[Gemini Success] (${options.purpose || "request"}) attempt ${attemptNum}/${orderedModels.length} with model "${modelName}" OK in ${elapsed}ms`
      );

      return {
        result,
        modelUsed: modelName,
        attempts,
        fallbackCount: attempts.length - 1,
        fallbackOverheadMs,
      };
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - attemptStart;
      fallbackOverheadMs += elapsed;
      lastError = err;

      const isTimedOut = didTimeout || (controller.signal.aborted && options.abortSignal && !options.abortSignal.aborted);
      const status = typeof err?.status === "number" ? err.status : undefined;
      const errMsg = String(err?.message || err);
      const errMsgLower = errMsg.toLowerCase();

      let statusLabel: FallbackAttemptLog["status"] = "error";

      if (status === 404 || errMsgLower.includes("not found") || errMsgLower.includes("is not supported") || errMsgLower.includes("no longer available")) {
        statusLabel = "404_not_found";
        setModelCooldown(modelName, COOLDOWN_DURATIONS.NOT_FOUND_404);
      } else if (isZeroQuotaError(err)) {
        statusLabel = "429_quota";
        setModelCooldown(modelName, COOLDOWN_DURATIONS.DAILY_QUOTA_ZERO);
      } else if (isQuotaOrRateLimitError(err)) {
        statusLabel = "429_quota";
        setModelCooldown(modelName, COOLDOWN_DURATIONS.QUOTA_429);
      } else if (isTimedOut || errMsgLower.includes("timeout")) {
        statusLabel = "timeout";
        setModelCooldown(modelName, COOLDOWN_DURATIONS.TIMEOUT);
      } else if (status === 400 || !isRetryableGeminiError(err)) {
        statusLabel = "error";
        // Do not set model cooldown for 400 or non-retryable client errors
      } else {
        setModelCooldown(modelName, COOLDOWN_DURATIONS.SERVER_ERROR_5XX);
      }

      attempts.push({
        model: modelName,
        status: statusLabel,
        elapsedMs: elapsed,
        error: errMsg,
      });

      console.warn(
        `[Gemini Fallback] (${options.purpose || "request"}) attempt ${attemptNum}/${orderedModels.length} with model "${modelName}" failed after ${elapsed}ms (${statusLabel}, status=${status ?? "n/a"}): ${errMsg}. Trying next model...`
      );

      options.onModelFailure?.(modelName, err, attemptNum, elapsed);

      if (options.abortSignal?.aborted) {
        throw err;
      }

      const retryable = isRetryableGeminiError(err) || isTimedOut;
      if (!retryable) {
        throw err;
      }
    }
  }

  // All models failed
  const failedSummary = attempts.map((a) => `${a.model} (${a.status})`).join(", ");
  const finalError = new Error(
    `Semua model Gemini dalam fallback chain (${failedSummary}) gagal dipanggil: ${lastError?.message || lastError || "Unknown error"}`
  );
  (finalError as any).attempts = attempts;
  (finalError as any).lastError = lastError;
  throw finalError;
}

