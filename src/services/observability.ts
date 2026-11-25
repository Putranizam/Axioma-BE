import fs from "fs";
import path from "path";

export interface FeatureMetricInput {
  feature: string;
  model: string;
  latencyMs: number;
  inputChars?: number;
  outputChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  fallbackUsed?: boolean;
  error?: boolean;
}

interface FeatureAggregate {
  requests: number;
  errors: number;
  fallbacks: number;
  totalLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

interface DailyMetricsState {
  date: string;
  totalRequests: number;
  totalErrors: number;
  totalEstimatedTokens: number;
  budgetWarned: boolean;
  features: Record<string, FeatureAggregate>;
}

function getUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

let dailyState: DailyMetricsState = {
  date: getUtcDateKey(),
  totalRequests: 0,
  totalErrors: 0,
  totalEstimatedTokens: 0,
  budgetWarned: false,
  features: {},
};

function ensureTodayState(): DailyMetricsState {
  const today = getUtcDateKey();
  if (dailyState.date !== today) {
    dailyState = {
      date: today,
      totalRequests: 0,
      totalErrors: 0,
      totalEstimatedTokens: 0,
      budgetWarned: false,
      features: {},
    };
  }
  return dailyState;
}

export function estimateTokensFromChars(chars = 0): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function getDailyTokenBudget(): number | null {
  const raw = Number(process.env.DAILY_TOKEN_BUDGET);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }
  return null;
}

export function recordFeatureMetric(input: FeatureMetricInput): void {
  const state = ensureTodayState();
  const featureKey = (input.feature || "unknown").trim().toLowerCase();
  const inTokens =
    typeof input.inputTokens === "number" && Number.isFinite(input.inputTokens)
      ? Math.max(0, Math.round(input.inputTokens))
      : estimateTokensFromChars(input.inputChars || 0);
  const outTokens =
    typeof input.outputTokens === "number" && Number.isFinite(input.outputTokens)
      ? Math.max(0, Math.round(input.outputTokens))
      : estimateTokensFromChars(input.outputChars || 0);
  const totalTokens = inTokens + outTokens;
  const safeLatency =
    Number.isFinite(input.latencyMs) && input.latencyMs >= 0
      ? Math.round(input.latencyMs)
      : 0;

  if (!state.features[featureKey]) {
    state.features[featureKey] = {
      requests: 0,
      errors: 0,
      fallbacks: 0,
      totalLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const agg = state.features[featureKey];
  agg.requests += 1;
  if (input.error) {
    agg.errors += 1;
    state.totalErrors += 1;
  }
  if (input.fallbackUsed) {
    agg.fallbacks += 1;
  }
  agg.totalLatencyMs += safeLatency;
  agg.inputTokens += inTokens;
  agg.outputTokens += outTokens;

  state.totalRequests += 1;
  state.totalEstimatedTokens += totalTokens;

  // Soft daily token budget warning (never blocks requests)
  const budget = getDailyTokenBudget();
  if (budget !== null && state.totalEstimatedTokens >= budget && !state.budgetWarned) {
    state.budgetWarned = true;
    console.warn(
      `[COST_GUARDIAN_WARNING] Daily estimated token usage (${state.totalEstimatedTokens}) reached soft limit (${budget}) on ${state.date}.`
    );
  }

  const logRecord = {
    timestamp: new Date().toISOString(),
    feature: featureKey,
    model: input.model,
    latencyMs: safeLatency,
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens,
    fallbackUsed: Boolean(input.fallbackUsed),
    error: Boolean(input.error),
  };

  try {
    const logsDir = path.join(process.cwd(), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(
      path.join(logsDir, "metrics.jsonl"),
      `${JSON.stringify(logRecord)}\n`,
      "utf8"
    );
  } catch {
    // Never crash request flow if filesystem is read-only
  }
}

export function getMetricsSummary(): {
  date: string;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  estimatedTokensToday: number;
  dailyTokenBudget: number | null;
  budgetExceeded: boolean;
  features: Record<
    string,
    {
      requests: number;
      errors: number;
      errorRate: number;
      fallbacks: number;
      avgLatencyMs: number;
      estimatedTokens: number;
    }
  >;
} {
  const state = ensureTodayState();
  const budget = getDailyTokenBudget();
  const featuresOut: Record<
    string,
    {
      requests: number;
      errors: number;
      errorRate: number;
      fallbacks: number;
      avgLatencyMs: number;
      estimatedTokens: number;
    }
  > = {};

  for (const [key, agg] of Object.entries(state.features)) {
    featuresOut[key] = {
      requests: agg.requests,
      errors: agg.errors,
      errorRate: agg.requests > 0 ? Number((agg.errors / agg.requests).toFixed(4)) : 0,
      fallbacks: agg.fallbacks,
      avgLatencyMs: agg.requests > 0 ? Math.round(agg.totalLatencyMs / agg.requests) : 0,
      estimatedTokens: agg.inputTokens + agg.outputTokens,
    };
  }

  return {
    date: state.date,
    totalRequests: state.totalRequests,
    totalErrors: state.totalErrors,
    errorRate:
      state.totalRequests > 0
        ? Number((state.totalErrors / state.totalRequests).toFixed(4))
        : 0,
    estimatedTokensToday: state.totalEstimatedTokens,
    dailyTokenBudget: budget,
    budgetExceeded: budget !== null && state.totalEstimatedTokens >= budget,
    features: featuresOut,
  };
}
