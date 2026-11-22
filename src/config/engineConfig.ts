/**
 * Centralized AI Engine Configuration & Dynamic Model Router for Axioma Backend
 *
 * Environment variables (all optional with safe production defaults):
 * - ENGINE_FAST      : Fast model for regular chat, WhatsApp replies, light extraction
 * - ENGINE_PRO       : High-capability model for PDF, Vision, Lens, Studio, Roleplay, deep/critical analysis
 * - ENGINE_FALLBACK  : Comma-separated or single automatic fallback model(s) on timeout / 429 / 503
 * - ENGINE_IMAGE     : Image generation model identifier
 * - ENGINE_VIDEO     : Video generation model identifier
 * - GEMINI_MODEL_CHAIN : Optional legacy comma-separated fallback chain appended as final safety net
 */

export type EngineMode = "auto" | "fast" | "pro";
export type ResolvedEngineTier = "fast" | "pro";

export type EngineTaskType =
  | "chat"
  | "chat_deep"
  | "chat_critical"
  | "reply_wa"
  | "extraction"
  | "pdf"
  | "vision"
  | "lens"
  | "studio"
  | "roleplay"
  | "voice_transcription"
  | "media_prompt";

export interface ResolveEngineParams {
  requestedMode?: string;
  taskType?: EngineTaskType | string;
  hasAttachment?: boolean;
  thinkingMode?: string;
  agentId?: string;
}

export interface ResolvedEngine {
  selectedMode: EngineMode;
  resolvedTier: ResolvedEngineTier;
  primaryModel: string;
  fallbackModels: string[];
  modelChain: string[];
  reason: string;
}

export interface PublicEngineOption {
  id: EngineMode;
  label: string;
  description: string;
  isDefault: boolean;
}

const DEFAULT_ENGINE_FAST = "gemini-flash-lite-latest";
const DEFAULT_ENGINE_PRO = "gemini-2.5-flash";
const DEFAULT_ENGINE_FALLBACK = "gemini-2.0-flash-lite";
const DEFAULT_ENGINE_IMAGE = "imagen-3.0-generate-002";
const DEFAULT_ENGINE_VIDEO = "veo-2.0-generate-001";

const HEAVY_TASK_TYPES = new Set<string>([
  "pdf",
  "vision",
  "lens",
  "studio",
  "roleplay",
  "chat_deep",
  "chat_critical",
  "deep",
  "critical",
]);

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const clean = (m || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * Reads active engine identifiers dynamically from process.env with safe defaults.
 */
export function getEngineEnvConfig(): {
  fast: string;
  pro: string;
  fallbacks: string[];
  legacyChain: string[];
} {
  const fast = (process.env.ENGINE_FAST || "").trim() || DEFAULT_ENGINE_FAST;
  const pro = (process.env.ENGINE_PRO || "").trim() || DEFAULT_ENGINE_PRO;
  const envFallbacks = parseCsvEnv(process.env.ENGINE_FALLBACK);
  const fallbacks = envFallbacks.length > 0 ? envFallbacks : [DEFAULT_ENGINE_FALLBACK];
  const legacyChain = parseCsvEnv(process.env.GEMINI_MODEL_CHAIN);

  return { fast, pro, fallbacks, legacyChain };
}

/**
 * Reads media model identifiers (image & video) dynamically from process.env.
 */
export function getMediaEngineConfig(): {
  imageModel: string;
  videoModel: string;
} {
  return {
    imageModel: (process.env.ENGINE_IMAGE || "").trim() || DEFAULT_ENGINE_IMAGE,
    videoModel: (process.env.ENGINE_VIDEO || "").trim() || DEFAULT_ENGINE_VIDEO,
  };
}

/**
 * Returns the default ordered fallback chain derived strictly from environment config.
 */
export function getDefaultEngineChain(): string[] {
  const { fast, pro, fallbacks, legacyChain } = getEngineEnvConfig();
  if (legacyChain.length > 0) {
    return dedupeModels([...legacyChain, fast, pro, ...fallbacks]);
  }
  return dedupeModels([fast, pro, ...fallbacks]);
}

function normalizeRequestedMode(rawMode?: string): EngineMode {
  const clean = (rawMode || "").trim().toLowerCase();
  if (clean === "fast" || clean === "quick" || clean === "cepat") return "fast";
  if (clean === "pro" || clean === "deep" || clean === "mendalam") return "pro";
  return "auto";
}

/**
 * Resolves the target AI engine and its automatic fallback chain based on
 * user mode ("auto" | "fast" | "pro"), task complexity, thinking mode, and attachments.
 */
export function resolveEngine(params: ResolveEngineParams = {}): ResolvedEngine {
  const { fast, pro, fallbacks, legacyChain } = getEngineEnvConfig();
  const selectedMode = normalizeRequestedMode(params.requestedMode);
  const normalizedTask = (params.taskType || "chat").trim().toLowerCase();
  const normalizedThinking = (params.thinkingMode || "").trim().toLowerCase();
  const normalizedAgent = (params.agentId || "").trim().toLowerCase();
  const hasAttachment = Boolean(params.hasAttachment);

  // Explicit user override: Fast
  if (selectedMode === "fast") {
    const chain = dedupeModels([fast, ...fallbacks, pro, ...legacyChain]);
    return {
      selectedMode,
      resolvedTier: "fast",
      primaryModel: chain[0],
      fallbackModels: chain.slice(1),
      modelChain: chain,
      reason: "manual_fast",
    };
  }

  // Explicit user override: Pro
  if (selectedMode === "pro") {
    const chain = dedupeModels([pro, ...fallbacks, fast, ...legacyChain]);
    return {
      selectedMode,
      resolvedTier: "pro",
      primaryModel: chain[0],
      fallbackModels: chain.slice(1),
      modelChain: chain,
      reason: "manual_pro",
    };
  }

  // Dynamic "auto" routing: heavy tasks -> ENGINE_PRO, light/regular chat -> ENGINE_FAST
  const isHeavyTask =
    HEAVY_TASK_TYPES.has(normalizedTask) ||
    normalizedThinking === "deep" ||
    normalizedThinking === "critical" ||
    hasAttachment ||
    normalizedAgent === "axioma-architect";

  if (isHeavyTask) {
    const chain = dedupeModels([pro, ...fallbacks, fast, ...legacyChain]);
    const reason = hasAttachment
      ? "auto_pro_attachment"
      : HEAVY_TASK_TYPES.has(normalizedTask)
      ? `auto_pro_task_${normalizedTask}`
      : normalizedThinking
      ? `auto_pro_thinking_${normalizedThinking}`
      : "auto_pro_agent";

    return {
      selectedMode: "auto",
      resolvedTier: "pro",
      primaryModel: chain[0],
      fallbackModels: chain.slice(1),
      modelChain: chain,
      reason,
    };
  }

  const chain = dedupeModels([fast, ...fallbacks, pro, ...legacyChain]);
  return {
    selectedMode: "auto",
    resolvedTier: "fast",
    primaryModel: chain[0],
    fallbackModels: chain.slice(1),
    modelChain: chain,
    reason: `auto_fast_task_${normalizedTask || "chat"}`,
  };
}

/**
 * Detects whether a model supports configurable hidden thinking budgets
 * without hardcoding a single model version name.
 */
export function isThinkingCapableModel(modelName: string): boolean {
  const lower = (modelName || "").trim().toLowerCase();
  return lower.includes("preview") || lower.includes("thinking") || lower.includes("2.5");
}

/**
 * Public engine catalog returned by GET /api/engines for dynamic frontend selectors.
 */
export function getPublicEngineList(): PublicEngineOption[] {
  return [
    {
      id: "auto",
      label: "Otomatis",
      description:
        "Memilih engine cepat untuk obrolan harian dan engine mendalam untuk dokumen, visual, atau analisis kompleks.",
      isDefault: true,
    },
    {
      id: "fast",
      label: "Cepat",
      description:
        "Respons instan dan ringan untuk percakapan rutin, ringkasan singkat, dan balasan cepat.",
      isDefault: false,
    },
    {
      id: "pro",
      label: "Mendalam",
      description:
        "Penalaran tingkat lanjut untuk analisis kritis, pemrograman, bedah PDF, dan skenario kompleks.",
      isDefault: false,
    },
  ];
}
