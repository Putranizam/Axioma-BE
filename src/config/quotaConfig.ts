/**
 * Centralized Daily Token Quota & Plan Tier Configuration for Axioma Backend.
 * Adjust token limits, model weights, media costs, and tier metadata strictly from this file.
 */

export type QuotaModelKey = "omni" | "pro" | "architect" | "media";
export type QuotaPlanId = "free" | "pro";
export type CheckoutPlanId = "pro" | "topup";

function parsePositiveEnvInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function formatTokensId(amount: number): string {
  return Math.max(0, Math.round(amount)).toLocaleString("id-ID");
}

/** Daily token allowance for Free users (override via `process.env.DAILY_FREE_TOKENS`). */
export const DAILY_FREE_TOKENS = parsePositiveEnvInt("DAILY_FREE_TOKENS", 50_000);

/** Daily token allowance for Pro users (override via `process.env.DAILY_PRO_TOKENS`). */
export const DAILY_PRO_TOKENS = parsePositiveEnvInt("DAILY_PRO_TOKENS", 500_000);

/** Minimum remaining tokens required to initiate a new text chat request. */
export const MIN_TOKENS_TO_START = parsePositiveEnvInt("MIN_TOKENS_TO_START", 250);

/** Fixed token cost per direct image/video generation request. */
export const MEDIA_TOKEN_COST = parsePositiveEnvInt("MEDIA_TOKEN_COST", 2_500);

/** Per-agent billing multiplier applied to measured token consumption. */
export const MODEL_TOKEN_MULTIPLIER: Readonly<Record<QuotaModelKey, number>> = {
  omni: 1.0,
  pro: 1.0,
  architect: 1.25,
  media: 1.0,
} as const;

export function getDailyTokenLimitForPlan(plan: QuotaPlanId): number {
  return plan === "pro" ? DAILY_PRO_TOKENS : DAILY_FREE_TOKENS;
}

export interface TopupTokenPack {
  id: string;
  tokens: number;
  label: string;
  priceIdr: number;
  priceLabel: string;
}

export const TOPUP_TOKEN_PACKS: readonly TopupTokenPack[] = [
  {
    id: "topup-100k",
    tokens: 100_000,
    label: `+${formatTokensId(100_000)} Token`,
    priceIdr: 15_000,
    priceLabel: "Rp 15.000",
  },
  {
    id: "topup-300k",
    tokens: 300_000,
    label: `+${formatTokensId(300_000)} Token`,
    priceIdr: 35_000,
    priceLabel: "Rp 35.000",
  },
] as const;

export interface PlanTierDefinition {
  id: "free" | "pro" | "topup";
  name: string;
  priceIdr: number;
  priceLabel: string;
  billingCycle: "daily_reset" | "monthly" | "one_time";
  tokens: number;
  description: string;
  highlights: readonly string[];
}

export const PLAN_TIERS: Readonly<Record<"free" | "pro" | "topup", PlanTierDefinition>> = {
  free: {
    id: "free",
    name: "Axioma Gratis",
    priceIdr: 0,
    priceLabel: "Rp0",
    billingCycle: "daily_reset",
    tokens: DAILY_FREE_TOKENS,
    description: `${formatTokensId(DAILY_FREE_TOKENS)} token gratis setiap hari (reset pukul 00.00 WIB).`,
    highlights: [
      `${formatTokensId(DAILY_FREE_TOKENS)} token harian otomatis reset pukul 00.00 WIB`,
      `Bobot token: Omni ${MODEL_TOKEN_MULTIPLIER.omni}× · Pro ${MODEL_TOKEN_MULTIPLIER.pro}× · Architect ${String(MODEL_TOKEN_MULTIPLIER.architect).replace(".", ",")}×`,
      `Generasi media: ${formatTokensId(MEDIA_TOKEN_COST)} token / permintaan`,
    ],
  },
  pro: {
    id: "pro",
    name: "Axioma Pro",
    priceIdr: 49_000,
    priceLabel: "Rp49.000/bulan",
    billingCycle: "monthly",
    tokens: DAILY_PRO_TOKENS,
    description: `Kuota besar ${formatTokensId(DAILY_PRO_TOKENS)} token harian untuk seluruh model AI premium.`,
    highlights: [
      `${formatTokensId(DAILY_PRO_TOKENS)} token harian otomatis reset pukul 00.00 WIB`,
      "Akses penuh semua model AI premium (coding & analisis mendalam)",
      "Upload dokumen & gambar lebih leluasa dengan prioritas kecepatan",
    ],
  },
  topup: {
    id: "topup",
    name: `Top-Up ${formatTokensId(TOPUP_TOKEN_PACKS[0].tokens)} Token`,
    priceIdr: TOPUP_TOKEN_PACKS[0].priceIdr,
    priceLabel: `Rp${formatTokensId(TOPUP_TOKEN_PACKS[0].priceIdr)} / ${formatTokensId(TOPUP_TOKEN_PACKS[0].tokens)} token`,
    billingCycle: "one_time",
    tokens: TOPUP_TOKEN_PACKS[0].tokens,
    description: `Tambahan ${formatTokensId(TOPUP_TOKEN_PACKS[0].tokens)} token ekstra tanpa langganan bulanan, masa aktif selamanya.`,
    highlights: [
      `+${formatTokensId(TOPUP_TOKEN_PACKS[0].tokens)} token ekstra langsung aktif`,
      "Sekali beli, masa aktif selamanya lintas hari",
      `Tersedia juga paket +${formatTokensId(TOPUP_TOKEN_PACKS[1].tokens)} token (Rp${formatTokensId(TOPUP_TOKEN_PACKS[1].priceIdr)})`,
    ],
  },
} as const;

/**
 * Maps an agent ID / engine mode / media flag into one of the 4 canonical quota model keys.
 */
export function resolveQuotaModelKey(params: {
  agentId?: string;
  engineMode?: string;
  isMedia?: boolean;
}): QuotaModelKey {
  if (params.isMedia) {
    return "media";
  }

  const normalizedAgent = (params.agentId || "").trim().toLowerCase();
  const normalizedEngine = (params.engineMode || "").trim().toLowerCase();

  if (normalizedAgent.includes("architect") || normalizedEngine === "architect") {
    return "architect";
  }
  if (
    normalizedAgent.includes("omni") ||
    normalizedEngine === "omni" ||
    normalizedEngine === "fast"
  ) {
    return "omni";
  }
  if (normalizedAgent.includes("pro") || normalizedEngine === "pro") {
    return "pro";
  }

  return "pro";
}
