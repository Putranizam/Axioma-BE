/**
 * Centralized Daily Credit Quota & Plan Tier Configuration for Axioma Backend.
 * Adjust credit limits, model weights, and pricing strictly from this single file.
 */

export type QuotaModelKey = "omni" | "pro" | "architect" | "media";
export type QuotaPlanId = "free" | "pro";
export type CheckoutPlanId = "pro" | "topup";

export const DAILY_FREE_CREDITS = 30;

export const MODEL_CREDIT_COST: Readonly<Record<QuotaModelKey, number>> = {
  omni: 1,
  pro: 3,
  architect: 4,
  media: 5,
} as const;

export interface PlanTierDefinition {
  id: "free" | "pro" | "topup";
  name: string;
  priceIdr: number;
  priceLabel: string;
  billingCycle: "daily_reset" | "monthly" | "one_time";
  credits: number | "unlimited";
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
    credits: DAILY_FREE_CREDITS,
    description: `${DAILY_FREE_CREDITS} kredit gratis setiap hari (reset pukul 00:00 WIB).`,
    highlights: [
      `${DAILY_FREE_CREDITS} kredit harian otomatis reset 00:00 WIB`,
      "Omni (1 kredit) · Pro (3 kredit) · Architect (4 kredit) · Media (5 kredit)",
      "Auto-Language Mirroring, Auto-Media & Live Preview",
    ],
  },
  pro: {
    id: "pro",
    name: "Axioma Pro",
    priceIdr: 49_000,
    priceLabel: "Rp49.000/bulan",
    billingCycle: "monthly",
    credits: "unlimited",
    description: "Akses kuota besar hingga 15x lebih banyak untuk seluruh model AI premium.",
    highlights: [
      "Kuota chat harian hingga 15x lebih besar",
      "Akses semua model AI premium (coding & analisis mendalam)",
      "Upload file & gambar lebih leluasa dengan prioritas kecepatan",
    ],
  },
  topup: {
    id: "topup",
    name: "Top-Up 50 Kredit",
    priceIdr: 15_000,
    priceLabel: "Rp15.000 / 50 kredit",
    billingCycle: "one_time",
    credits: 50,
    description: "Tambahan 50 kredit ekstra tanpa langganan bulanan, masa aktif selamanya.",
    highlights: [
      "+50 kredit ekstra langsung aktif",
      "Sekali beli, masa aktif selamanya lintas hari",
      "Tersedia juga paket +150 kredit (Rp35.000)",
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
