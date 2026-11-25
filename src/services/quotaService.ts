import fs from "fs";
import path from "path";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  MEDIA_TOKEN_COST,
  MIN_TOKENS_TO_START,
  MODEL_TOKEN_MULTIPLIER,
  PLAN_TIERS,
  TOPUP_TOKEN_PACKS,
  QuotaModelKey,
  QuotaPlanId,
  getDailyTokenLimitForPlan,
} from "../config/quotaConfig";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7 (Waktu Indonesia Barat)

export type TokenMeasurementSource = "gemini" | "estimated" | "fixed_media";

export interface TokenUsageSummary {
  plan: QuotaPlanId;
  unit: "token";
  dailyLimit: number;
  usedTokens: number;
  remainingTokens: number;
  bonusTokens: number;
  usagePercent: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  resetAt: string;
  lastRequestTokens?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    multiplier: number;
    source: TokenMeasurementSource;
  };
}

export interface UserQuotaSnapshot extends TokenUsageSummary {
  expiresAt?: string;
  minTokensToStart: number;
  mediaTokenCost: number;
  weights: typeof MODEL_TOKEN_MULTIPLIER;
  tiers: typeof PLAN_TIERS;
  topupPacks: typeof TOPUP_TOKEN_PACKS;
}

export type TokenPreFlightResult =
  | {
      allowed: true;
      plan: QuotaPlanId;
      unit: "token";
      dailyLimit: number;
      usedTokens: number;
      remainingTokens: number;
      bonusTokens: number;
      usagePercent: number;
      promptTokensUsed: number;
      completionTokensUsed: number;
      requiredTokens: number;
      resetAt: string;
    }
  | {
      allowed: false;
      code: "QUOTA_EXCEEDED";
      plan: QuotaPlanId;
      unit: "token";
      dailyLimit: number;
      usedTokens: number;
      remainingTokens: number;
      bonusTokens: number;
      usagePercent: number;
      promptTokensUsed: number;
      completionTokensUsed: number;
      requiredTokens: number;
      resetAt: string;
    };

interface DailyTokenUsageRecord {
  userId: string;
  dateWib: string;
  dailyTokenLimit: number;
  tokensUsed: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  updatedAt: string;
}

interface PersistedTokenQuotaFile {
  version: 2;
  plans: Record<string, QuotaPlanId>;
  proExpiresAt?: Record<string, string>;
  bonusTokens: Record<string, number>;
  dailyTokenUsage: Record<string, DailyTokenUsageRecord>;
}

const DATA_DIR = path.resolve(process.cwd(), ".data");
const QUOTA_STORE_PATH = path.join(DATA_DIR, "axioma-quota.json");
const MAX_QUOTA_CACHE_ENTRIES = 5_000;
const QUOTA_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const LOCAL_PERSIST_DEBOUNCE_MS = 2_000;

// Fast in-memory cache keyed by `${userId}:${YYYY-MM-DD_WIB}`
const dailyTokenUsageMap = new Map<string, DailyTokenUsageRecord>();
const userPlanMap = new Map<string, QuotaPlanId>();
const userProExpiresAtMap = new Map<string, string>();
const userBonusTokensMap = new Map<string, number>();

function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  maxEntries = MAX_QUOTA_CACHE_ENTRIES
): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function cleanupQuotaMaps(now: Date = new Date()): void {
  const todayWib = getWibDateKey(now);
  for (const [key, rec] of dailyTokenUsageMap.entries()) {
    if (rec.dateWib !== todayWib) {
      dailyTokenUsageMap.delete(key);
    }
  }
  for (const map of [
    dailyTokenUsageMap,
    userPlanMap,
    userProExpiresAtMap,
    userBonusTokensMap,
  ] as Array<Map<string, unknown>>) {
    while (map.size > MAX_QUOTA_CACHE_ENTRIES) {
      const oldestKey = map.keys().next().value;
      if (oldestKey === undefined) break;
      map.delete(oldestKey);
    }
  }
}

const quotaCleanupTimer = setInterval(() => {
  cleanupQuotaMaps();
}, QUOTA_CACHE_CLEANUP_INTERVAL_MS);
if (typeof quotaCleanupTimer.unref === "function") {
  quotaCleanupTimer.unref();
}

let pendingLocalPersistTimer: ReturnType<typeof setTimeout> | null = null;
let localPersistInFlight = false;
let localPersistQueuedAgain = false;

let storeHydrated = false;
let supabaseRef: SupabaseClient | null = null;
let supabaseQuotaTableAvailable: boolean | null = null;
let supabaseTokenColumnsAvailable: boolean | null = null;

function isMissingTableError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    msg.includes("relation") && msg.includes("does not exist") ||
    msg.includes("could not find the table")
  );
}

function isMissingColumnError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = String(error.message || "").toLowerCase();
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    (msg.includes("column") && msg.includes("does not exist")) ||
    msg.includes("could not find the")
  );
}

/**
 * Fair fallback estimator when a provider/fallback or aborted stream does not report `usageMetadata`.
 * Uses 1 token ~= 4 characters (`Math.ceil(chars / 4)`).
 */
export function estimateTokenCountFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function computeUsagePercent(usedTokens: number, dailyLimit: number): number {
  if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) return 0;
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return 0;
  const raw = (usedTokens / dailyLimit) * 100;
  return Number(Math.min(100, Math.max(0, raw)).toFixed(1));
}

/**
 * Binds the initialized Supabase client so token quota tracking automatically persists to
 * `public.user_daily_quotas`, probing table & token column availability at startup.
 */
export function bindQuotaSupabaseClient(client: SupabaseClient | null): void {
  supabaseRef = client;
  supabaseQuotaTableAvailable = null;
  supabaseTokenColumnsAvailable = null;

  if (!client) {
    console.log(
      "[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — Supabase client tidak tersedia"
    );
    return;
  }

  void (async () => {
    try {
      const { error } = await client
        .from("user_daily_quotas")
        .select(
          "user_id, tokens_used, prompt_tokens_used, completion_tokens_used, daily_token_limit, bonus_tokens"
        )
        .limit(1);

      if (error) {
        if (isMissingTableError(error)) {
          supabaseQuotaTableAvailable = false;
          supabaseTokenColumnsAvailable = false;
          console.warn(
            "[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — tabel public.user_daily_quotas belum dibuat di Supabase"
          );
          return;
        }
        if (isMissingColumnError(error)) {
          supabaseQuotaTableAvailable = true;
          supabaseTokenColumnsAvailable = false;
          console.warn(
            "[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — kolom token belum tersedia di public.user_daily_quotas (jalankan migrations/008_token_quota_system.sql)"
          );
          return;
        }
        console.warn(
          `[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — probe Supabase gagal: ${error.message}`
        );
        return;
      }

      supabaseQuotaTableAvailable = true;
      supabaseTokenColumnsAvailable = true;
      console.log("[QuotaService] Storage: Supabase token quota (public.user_daily_quotas)");
    } catch (err: any) {
      console.warn(
        `[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — ${err?.message || err}`
      );
    }
  })();
}

export function getQuotaSupabaseClient(): SupabaseClient | null {
  return supabaseRef;
}

/**
 * Returns today's calendar date in WIB (`YYYY-MM-DD`, UTC+7).
 */
export function getWibDateKey(now: Date = new Date()): string {
  const wibDate = new Date(now.getTime() + WIB_OFFSET_MS);
  return wibDate.toISOString().slice(0, 10);
}

/**
 * Returns the ISO-8601 timestamp of the next 00:00:00 WIB reset (`YYYY-MM-DDT00:00:00+07:00`).
 */
export function getNextWibMidnightIso(now: Date = new Date()): string {
  const wibNow = new Date(now.getTime() + WIB_OFFSET_MS);
  const nextDayWib = new Date(
    Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate() + 1, 0, 0, 0)
  );
  const yyyy = nextDayWib.getUTCFullYear();
  const mm = String(nextDayWib.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(nextDayWib.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00+07:00`;
}

function makeUsageKey(userId: string, dateWib: string): string {
  return `${userId}:${dateWib}`;
}

function getEnvProUserIds(): Set<string> {
  const raw = (process.env.PRO_USER_IDS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function hydrateLocalStoreOnce(): void {
  if (storeHydrated) return;
  storeHydrated = true;

  try {
    if (!fs.existsSync(QUOTA_STORE_PATH)) return;
    const raw = fs.readFileSync(QUOTA_STORE_PATH, "utf-8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Partial<PersistedTokenQuotaFile>;

    if (parsed.plans && typeof parsed.plans === "object") {
      for (const [uid, plan] of Object.entries(parsed.plans)) {
        if (plan === "free" || plan === "pro") {
          setBoundedMap(userPlanMap, uid, plan);
        }
      }
    }

    if (parsed.proExpiresAt && typeof parsed.proExpiresAt === "object") {
      for (const [uid, exp] of Object.entries(parsed.proExpiresAt)) {
        if (typeof exp === "string" && exp.trim()) {
          setBoundedMap(userProExpiresAtMap, uid, exp.trim());
        }
      }
    }

    if (parsed.bonusTokens && typeof parsed.bonusTokens === "object") {
      for (const [uid, bonus] of Object.entries(parsed.bonusTokens)) {
        if (typeof bonus === "number" && Number.isFinite(bonus) && bonus >= 0) {
          setBoundedMap(userBonusTokensMap, uid, Math.floor(bonus));
        }
      }
    }

    const todayWib = getWibDateKey();
    if (parsed.dailyTokenUsage && typeof parsed.dailyTokenUsage === "object") {
      for (const [key, rec] of Object.entries(parsed.dailyTokenUsage)) {
        if (
          rec &&
          typeof rec.userId === "string" &&
          typeof rec.dateWib === "string" &&
          rec.dateWib === todayWib
        ) {
          const plan = userPlanMap.get(rec.userId) || "free";
          const limit =
            typeof rec.dailyTokenLimit === "number" &&
            Number.isFinite(rec.dailyTokenLimit) &&
            rec.dailyTokenLimit > 0
              ? Math.floor(rec.dailyTokenLimit)
              : getDailyTokenLimitForPlan(plan);
          const promptUsed =
            typeof rec.promptTokensUsed === "number" && Number.isFinite(rec.promptTokensUsed)
              ? Math.max(0, Math.floor(rec.promptTokensUsed))
              : 0;
          const completionUsed =
            typeof rec.completionTokensUsed === "number" &&
            Number.isFinite(rec.completionTokensUsed)
              ? Math.max(0, Math.floor(rec.completionTokensUsed))
              : 0;
          const totalUsed =
            typeof rec.tokensUsed === "number" && Number.isFinite(rec.tokensUsed)
              ? Math.max(promptUsed + completionUsed, Math.floor(rec.tokensUsed))
              : promptUsed + completionUsed;

          setBoundedMap(dailyTokenUsageMap, key, {
            userId: rec.userId,
            dateWib: rec.dateWib,
            dailyTokenLimit: limit,
            tokensUsed: totalUsed,
            promptTokensUsed: promptUsed,
            completionTokensUsed: completionUsed,
            updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
          });
        }
      }
    }
  } catch (err: any) {
    console.warn(
      "[quotaService] Local quota store hydration warning (falling back to in-memory):",
      err?.message || err
    );
  }
}

async function flushLocalStoreAsync(): Promise<void> {
  if (localPersistInFlight) {
    localPersistQueuedAgain = true;
    return;
  }
  localPersistInFlight = true;
  try {
    const todayWib = getWibDateKey(new Date());
    const prunedDailyUsage: Record<string, DailyTokenUsageRecord> = {};
    for (const [key, rec] of dailyTokenUsageMap.entries()) {
      if (rec.dateWib === todayWib) {
        prunedDailyUsage[key] = rec;
      }
    }

    const payload: PersistedTokenQuotaFile = {
      version: 2,
      plans: Object.fromEntries(userPlanMap.entries()),
      proExpiresAt: Object.fromEntries(userProExpiresAtMap.entries()),
      bonusTokens: Object.fromEntries(userBonusTokensMap.entries()),
      dailyTokenUsage: prunedDailyUsage,
    };

    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(QUOTA_STORE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err: any) {
    console.warn(
      "[quotaService] Local quota persist skipped (in-memory active):",
      err?.message || err
    );
  } finally {
    localPersistInFlight = false;
    if (localPersistQueuedAgain) {
      localPersistQueuedAgain = false;
      persistLocalStoreSafe();
    }
  }
}

function persistLocalStoreSafe(): void {
  if (pendingLocalPersistTimer) return;
  pendingLocalPersistTimer = setTimeout(() => {
    pendingLocalPersistTimer = null;
    void flushLocalStoreAsync();
  }, LOCAL_PERSIST_DEBOUNCE_MS);
  if (typeof pendingLocalPersistTimer.unref === "function") {
    pendingLocalPersistTimer.unref();
  }
}

async function readSupabaseQuotaRow(
  userId: string,
  dateWib: string
): Promise<{
  hasTodayRow: boolean;
  plan?: QuotaPlanId;
  dailyTokenLimit?: number;
  tokensUsed?: number;
  promptTokensUsed?: number;
  completionTokensUsed?: number;
  bonusTokens?: number;
  proExpiresAt?: string | null;
  updatedAt?: string;
} | null> {
  if (
    !supabaseRef ||
    supabaseQuotaTableAvailable === false ||
    supabaseTokenColumnsAvailable === false
  ) {
    return null;
  }

  try {
    const { data, error } = await supabaseRef
      .from("user_daily_quotas")
      .select(
        "plan, daily_token_limit, tokens_used, prompt_tokens_used, completion_tokens_used, bonus_tokens, pro_expires_at, updated_at"
      )
      .eq("user_id", userId)
      .eq("usage_date", dateWib)
      .maybeSingle();

    if (error) {
      if (isMissingTableError(error)) {
        supabaseQuotaTableAvailable = false;
        supabaseTokenColumnsAvailable = false;
      } else if (isMissingColumnError(error)) {
        supabaseTokenColumnsAvailable = false;
      }
      return null;
    }

    supabaseQuotaTableAvailable = true;
    supabaseTokenColumnsAvailable = true;

    if (data) {
      const plan: QuotaPlanId = data.plan === "pro" ? "pro" : "free";
      const limitVal =
        typeof data.daily_token_limit === "number" && data.daily_token_limit > 0
          ? Math.floor(data.daily_token_limit)
          : getDailyTokenLimitForPlan(plan);
      const promptVal =
        typeof data.prompt_tokens_used === "number"
          ? Math.max(0, Math.floor(data.prompt_tokens_used))
          : 0;
      const completionVal =
        typeof data.completion_tokens_used === "number"
          ? Math.max(0, Math.floor(data.completion_tokens_used))
          : 0;
      const usedVal =
        typeof data.tokens_used === "number"
          ? Math.max(promptVal + completionVal, Math.floor(data.tokens_used))
          : promptVal + completionVal;

      return {
        hasTodayRow: true,
        plan,
        dailyTokenLimit: limitVal,
        tokensUsed: usedVal,
        promptTokensUsed: promptVal,
        completionTokensUsed: completionVal,
        bonusTokens:
          typeof data.bonus_tokens === "number"
            ? Math.max(0, Math.floor(data.bonus_tokens))
            : 0,
        proExpiresAt:
          typeof data.pro_expires_at === "string" && data.pro_expires_at.trim()
            ? data.pro_expires_at.trim()
            : null,
        updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
      };
    }

    // No row yet for today's WIB date: carry forward permanent `plan`, `bonus_tokens`, and `pro_expires_at`
    // while resetting daily token usage to 0.
    const { data: latestPrev, error: prevError } = await supabaseRef
      .from("user_daily_quotas")
      .select("plan, bonus_tokens, pro_expires_at, updated_at")
      .eq("user_id", userId)
      .order("usage_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prevError || !latestPrev) return null;

    const prevPlan: QuotaPlanId = latestPrev.plan === "pro" ? "pro" : "free";
    return {
      hasTodayRow: false,
      plan: prevPlan,
      dailyTokenLimit: getDailyTokenLimitForPlan(prevPlan),
      tokensUsed: 0,
      promptTokensUsed: 0,
      completionTokensUsed: 0,
      bonusTokens:
        typeof latestPrev.bonus_tokens === "number"
          ? Math.max(0, Math.floor(latestPrev.bonus_tokens))
          : 0,
      proExpiresAt:
        typeof latestPrev.pro_expires_at === "string" && latestPrev.pro_expires_at.trim()
          ? latestPrev.pro_expires_at.trim()
          : null,
      updatedAt:
        typeof latestPrev.updated_at === "string" ? latestPrev.updated_at : undefined,
    };
  } catch {
    return null;
  }
}

async function upsertSupabaseQuotaRow(params: {
  userId: string;
  dateWib: string;
  plan: QuotaPlanId;
  dailyTokenLimit: number;
  tokensUsed: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  bonusTokens: number;
  proExpiresAt?: string | null;
}): Promise<void> {
  if (
    !supabaseRef ||
    supabaseQuotaTableAvailable === false ||
    supabaseTokenColumnsAvailable === false
  ) {
    return;
  }

  try {
    const { error } = await supabaseRef.from("user_daily_quotas").upsert(
      {
        user_id: params.userId,
        usage_date: params.dateWib,
        plan: params.plan,
        daily_token_limit: Math.max(0, Math.floor(params.dailyTokenLimit)),
        tokens_used: Math.max(0, Math.floor(params.tokensUsed)),
        prompt_tokens_used: Math.max(0, Math.floor(params.promptTokensUsed)),
        completion_tokens_used: Math.max(0, Math.floor(params.completionTokensUsed)),
        bonus_tokens: Math.max(0, Math.floor(params.bonusTokens)),
        pro_expires_at: params.proExpiresAt || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,usage_date" }
    );

    if (error) {
      if (isMissingTableError(error)) {
        supabaseQuotaTableAvailable = false;
        supabaseTokenColumnsAvailable = false;
      } else if (isMissingColumnError(error)) {
        supabaseTokenColumnsAvailable = false;
      }
    }
  } catch {
    // Best-effort DB sync; local persistent store + in-memory Map remain authoritative
  }
}

export interface PreflightUserQuotaState {
  userId: string;
  plan: QuotaPlanId;
  dailyLimit: number;
  tokensUsed: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  bonusTokens: number;
  dateWib: string;
  expiresAt?: string;
}

async function loadUserDailyState(
  userId: string,
  now: Date = new Date()
): Promise<PreflightUserQuotaState> {
  hydrateLocalStoreOnce();

  const cleanUserId = (userId || "").trim() || "anonymous";
  const dateWib = getWibDateKey(now);
  const usageKey = makeUsageKey(cleanUserId, dateWib);

  const dbRow = await readSupabaseQuotaRow(cleanUserId, dateWib);
  if (dbRow) {
    const existingLocal = dailyTokenUsageMap.get(usageKey);
    const localUpdatedMs = existingLocal ? Date.parse(existingLocal.updatedAt) || 0 : 0;
    const dbUpdatedMs = dbRow.updatedAt ? Date.parse(dbRow.updatedAt) || 0 : 0;

    if (dbRow.plan && (!userPlanMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)) {
      setBoundedMap(userPlanMap, cleanUserId, dbRow.plan);
    }

    if (
      typeof dbRow.bonusTokens === "number" &&
      (!userBonusTokensMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)
    ) {
      setBoundedMap(userBonusTokensMap, cleanUserId, Math.max(0, dbRow.bonusTokens));
    }

    if (
      dbRow.proExpiresAt &&
      (!userProExpiresAtMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)
    ) {
      setBoundedMap(userProExpiresAtMap, cleanUserId, dbRow.proExpiresAt);
    } else if (
      dbRow.plan === "free" &&
      (!userPlanMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)
    ) {
      userProExpiresAtMap.delete(cleanUserId);
    }

    if (dbRow.hasTodayRow && (!existingLocal || dbUpdatedMs > localUpdatedMs)) {
      const resolvedPlan = dbRow.plan || userPlanMap.get(cleanUserId) || "free";
      const resolvedLimit = getDailyTokenLimitForPlan(resolvedPlan);
      setBoundedMap(dailyTokenUsageMap, usageKey, {
        userId: cleanUserId,
        dateWib,
        dailyTokenLimit: resolvedLimit,
        tokensUsed: Math.max(0, dbRow.tokensUsed ?? 0),
        promptTokensUsed: Math.max(0, dbRow.promptTokensUsed ?? 0),
        completionTokensUsed: Math.max(0, dbRow.completionTokensUsed ?? 0),
        updatedAt: dbRow.updatedAt || now.toISOString(),
      });
    }
  }

  const proIds = getEnvProUserIds();
  let plan: QuotaPlanId = proIds.has(cleanUserId)
    ? "pro"
    : userPlanMap.get(cleanUserId) || "free";

  let expiresAt: string | undefined = userProExpiresAtMap.get(cleanUserId);
  if (plan === "pro" && !proIds.has(cleanUserId) && expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (Number.isFinite(expiryMs) && expiryMs <= now.getTime()) {
      plan = "free";
      expiresAt = undefined;
      userPlanMap.set(cleanUserId, "free");
      userProExpiresAtMap.delete(cleanUserId);
      persistLocalStoreSafe();
    }
  }

  const dailyLimit = getDailyTokenLimitForPlan(plan);
  const existingDailyRecord = dailyTokenUsageMap.get(usageKey);
  const tokensUsed = existingDailyRecord ? Math.max(0, existingDailyRecord.tokensUsed) : 0;
  const promptTokensUsed = existingDailyRecord
    ? Math.max(0, existingDailyRecord.promptTokensUsed)
    : 0;
  const completionTokensUsed = existingDailyRecord
    ? Math.max(0, existingDailyRecord.completionTokensUsed)
    : 0;
  const bonusTokens = Math.max(0, userBonusTokensMap.get(cleanUserId) ?? 0);

  return {
    userId: cleanUserId,
    plan,
    dailyLimit,
    tokensUsed,
    promptTokensUsed,
    completionTokensUsed,
    bonusTokens,
    dateWib,
    expiresAt,
  };
}

function buildTokenSummary(params: {
  plan: QuotaPlanId;
  dailyLimit: number;
  tokensUsed: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  bonusTokens: number;
  resetAt: string;
  lastRequestTokens?: TokenUsageSummary["lastRequestTokens"];
}): TokenUsageSummary {
  const dailyRemaining = Math.max(0, params.dailyLimit - params.tokensUsed);
  const remainingTokens = dailyRemaining + Math.max(0, params.bonusTokens);
  const usagePercent = computeUsagePercent(params.tokensUsed, params.dailyLimit);

  return {
    plan: params.plan,
    unit: "token",
    dailyLimit: params.dailyLimit,
    usedTokens: params.tokensUsed,
    remainingTokens,
    bonusTokens: Math.max(0, params.bonusTokens),
    usagePercent,
    promptTokensUsed: Math.max(0, params.promptTokensUsed),
    completionTokensUsed: Math.max(0, params.completionTokensUsed),
    resetAt: params.resetAt,
    ...(params.lastRequestTokens ? { lastRequestTokens: params.lastRequestTokens } : {}),
  };
}

/**
 * Returns the active daily token quota snapshot for `userId` (`GET /api/quota`).
 */
export async function getUserQuota(
  userId: string,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  const state = await loadUserDailyState(userId, now);
  const resetAt = getNextWibMidnightIso(now);
  const summary = buildTokenSummary({
    plan: state.plan,
    dailyLimit: state.dailyLimit,
    tokensUsed: state.tokensUsed,
    promptTokensUsed: state.promptTokensUsed,
    completionTokensUsed: state.completionTokensUsed,
    bonusTokens: state.bonusTokens,
    resetAt,
  });

  return {
    ...summary,
    ...(state.plan === "pro" && state.expiresAt ? { expiresAt: state.expiresAt } : {}),
    minTokensToStart: MIN_TOKENS_TO_START,
    mediaTokenCost: MEDIA_TOKEN_COST,
    weights: MODEL_TOKEN_MULTIPLIER,
    tiers: PLAN_TIERS,
    topupPacks: TOPUP_TOKEN_PACKS,
  };
}

/**
 * Loads user's daily token quota state without deducting tokens yet.
 * Run in parallel with Turnstile & chat/history lookup before streaming starts.
 */
export async function prefetchUserQuotaState(
  userId: string,
  now: Date = new Date()
): Promise<PreflightUserQuotaState> {
  return loadUserDailyState(userId, now);
}

/**
 * Synchronously validates whether the user has enough remaining tokens to start a request
 * (`MIN_TOKENS_TO_START` for text chat, or `MEDIA_TOKEN_COST` for image/video generation).
 * Does NOT deduct tokens yet — real token deduction occurs in `recordTokenUsage` after generation.
 */
export function checkTokenQuotaPreFlight(
  preflight: PreflightUserQuotaState,
  options?: {
    modelKey?: QuotaModelKey;
    requiredTokens?: number;
  },
  now: Date = new Date()
): TokenPreFlightResult {
  const cleanUserId = preflight.userId;
  const resetAt = getNextWibMidnightIso(now);
  const requiredTokens = Math.max(
    1,
    Math.floor(
      options?.requiredTokens ??
        (options?.modelKey === "media" ? MEDIA_TOKEN_COST : MIN_TOKENS_TO_START)
    )
  );

  // Merge with latest in-memory counters to protect against concurrent requests
  const usageKey = makeUsageKey(cleanUserId, preflight.dateWib);
  const latestDaily = dailyTokenUsageMap.get(usageKey);
  const latestBonus = userBonusTokensMap.get(cleanUserId);

  const tokensUsed = latestDaily
    ? Math.max(preflight.tokensUsed, latestDaily.tokensUsed)
    : preflight.tokensUsed;
  const promptTokensUsed = latestDaily
    ? Math.max(preflight.promptTokensUsed, latestDaily.promptTokensUsed)
    : preflight.promptTokensUsed;
  const completionTokensUsed = latestDaily
    ? Math.max(preflight.completionTokensUsed, latestDaily.completionTokensUsed)
    : preflight.completionTokensUsed;
  const bonusTokens =
    typeof latestBonus === "number"
      ? Math.min(preflight.bonusTokens, Math.max(0, latestBonus))
      : preflight.bonusTokens;

  const dailyLimit = preflight.dailyLimit;
  const dailyRemaining = Math.max(0, dailyLimit - tokensUsed);
  const remainingTokens = dailyRemaining + bonusTokens;
  const usagePercent = computeUsagePercent(tokensUsed, dailyLimit);

  if (remainingTokens <= 0 || remainingTokens < requiredTokens) {
    return {
      allowed: false,
      code: "QUOTA_EXCEEDED",
      plan: preflight.plan,
      unit: "token",
      dailyLimit,
      usedTokens: tokensUsed,
      remainingTokens,
      bonusTokens,
      usagePercent,
      promptTokensUsed,
      completionTokensUsed,
      requiredTokens,
      resetAt,
    };
  }

  return {
    allowed: true,
    plan: preflight.plan,
    unit: "token",
    dailyLimit,
    usedTokens: tokensUsed,
    remainingTokens,
    bonusTokens,
    usagePercent,
    promptTokensUsed,
    completionTokensUsed,
    requiredTokens,
    resetAt,
  };
}

export interface RecordTokenUsageInput {
  modelKey: QuotaModelKey;
  promptTokens: number;
  completionTokens: number;
  /** Optional fixed total tokens (used for media generation = MEDIA_TOKEN_COST). */
  fixedTotalTokens?: number;
  source: TokenMeasurementSource;
  preflight?: PreflightUserQuotaState | null;
}

/**
 * Records actual measured (or fallback-estimated) token consumption after generation completes.
 * - Applies `MODEL_TOKEN_MULTIPLIER[modelKey]` cleanly to prompt & completion tokens.
 * - Deducts from daily allowance first, spilling any overflow into permanent `bonusTokens`.
 * - Persists asynchronously to Supabase `public.user_daily_quotas` and debounced local JSON fallback.
 */
export function recordTokenUsage(
  userId: string,
  input: RecordTokenUsageInput,
  now: Date = new Date()
): TokenUsageSummary {
  hydrateLocalStoreOnce();

  const cleanUserId = (userId || "").trim() || "anonymous";
  const dateWib = input.preflight?.dateWib || getWibDateKey(now);
  const usageKey = makeUsageKey(cleanUserId, dateWib);
  const resetAt = getNextWibMidnightIso(now);

  const proIds = getEnvProUserIds();
  const plan: QuotaPlanId =
    input.preflight?.plan ||
    (proIds.has(cleanUserId) ? "pro" : userPlanMap.get(cleanUserId) || "free");
  const dailyLimit = input.preflight?.dailyLimit || getDailyTokenLimitForPlan(plan);

  const latestDaily = dailyTokenUsageMap.get(usageKey);
  const prevTokensUsed = latestDaily
    ? Math.max(latestDaily.tokensUsed, input.preflight?.tokensUsed ?? 0)
    : input.preflight?.tokensUsed ?? 0;
  const prevPromptUsed = latestDaily
    ? Math.max(latestDaily.promptTokensUsed, input.preflight?.promptTokensUsed ?? 0)
    : input.preflight?.promptTokensUsed ?? 0;
  const prevCompletionUsed = latestDaily
    ? Math.max(latestDaily.completionTokensUsed, input.preflight?.completionTokensUsed ?? 0)
    : input.preflight?.completionTokensUsed ?? 0;

  const latestBonus = userBonusTokensMap.get(cleanUserId);
  const prevBonusTokens =
    typeof latestBonus === "number"
      ? Math.max(0, latestBonus)
      : Math.max(0, input.preflight?.bonusTokens ?? 0);

  const multiplier = MODEL_TOKEN_MULTIPLIER[input.modelKey] ?? 1.0;

  let billedPrompt: number;
  let billedCompletion: number;
  let billedTotal: number;

  if (
    typeof input.fixedTotalTokens === "number" &&
    Number.isFinite(input.fixedTotalTokens) &&
    input.fixedTotalTokens > 0
  ) {
    billedTotal = Math.round(input.fixedTotalTokens);
    const rawPrompt = Math.max(0, Math.round(input.promptTokens));
    billedPrompt = Math.min(billedTotal, rawPrompt);
    billedCompletion = Math.max(0, billedTotal - billedPrompt);
  } else {
    const safePrompt = Math.max(0, Math.round(input.promptTokens));
    const safeCompletion = Math.max(0, Math.round(input.completionTokens));
    billedPrompt = Math.max(0, Math.round(safePrompt * multiplier));
    billedCompletion = Math.max(0, Math.round(safeCompletion * multiplier));
    billedTotal = billedPrompt + billedCompletion;
  }

  // Deduct from remaining daily allowance first; spill overflow into permanent bonusTokens
  const dailyRemainingBefore = Math.max(0, dailyLimit - prevTokensUsed);
  const deductedFromDaily = Math.min(dailyRemainingBefore, billedTotal);
  const overflowToBonus = Math.max(0, billedTotal - deductedFromDaily);
  const deductedFromBonus = Math.min(prevBonusTokens, overflowToBonus);

  const nextTokensUsed = prevTokensUsed + billedTotal;
  const nextPromptUsed = prevPromptUsed + billedPrompt;
  const nextCompletionUsed = prevCompletionUsed + billedCompletion;
  const nextBonusTokens = Math.max(0, prevBonusTokens - deductedFromBonus);

  setBoundedMap(dailyTokenUsageMap, usageKey, {
    userId: cleanUserId,
    dateWib,
    dailyTokenLimit: dailyLimit,
    tokensUsed: nextTokensUsed,
    promptTokensUsed: nextPromptUsed,
    completionTokensUsed: nextCompletionUsed,
    updatedAt: now.toISOString(),
  });
  setBoundedMap(userBonusTokensMap, cleanUserId, nextBonusTokens);

  persistLocalStoreSafe();
  void upsertSupabaseQuotaRow({
    userId: cleanUserId,
    dateWib,
    plan,
    dailyTokenLimit: dailyLimit,
    tokensUsed: nextTokensUsed,
    promptTokensUsed: nextPromptUsed,
    completionTokensUsed: nextCompletionUsed,
    bonusTokens: nextBonusTokens,
    proExpiresAt: userProExpiresAtMap.get(cleanUserId) || null,
  });

  return buildTokenSummary({
    plan,
    dailyLimit,
    tokensUsed: nextTokensUsed,
    promptTokensUsed: nextPromptUsed,
    completionTokensUsed: nextCompletionUsed,
    bonusTokens: nextBonusTokens,
    resetAt,
    lastRequestTokens: {
      promptTokens: billedPrompt,
      completionTokens: billedCompletion,
      totalTokens: billedTotal,
      multiplier,
      source: input.source,
    },
  });
}

export interface AdminQuotaUpdateInput {
  addTokens?: number;
  resetDaily?: boolean;
  plan?: QuotaPlanId;
  proDurationDays?: number;
}

/**
 * Admin operation:
 * - `addTokens`: adds directly to permanent `bonusTokens` (never auto-reset at 00:00 WIB).
 * - `resetDaily`: resets today's `tokensUsed`, `promptTokensUsed`, and `completionTokensUsed` back to 0.
 * - `plan`: updates subscription tier (`free` | `pro`), with optional `proDurationDays`.
 */
export async function adminUpdateUserQuota(
  userId: string,
  patch: AdminQuotaUpdateInput,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  const cleanUserId = (userId || "").trim();
  const current = await loadUserDailyState(cleanUserId, now);

  const nextPlan: QuotaPlanId =
    patch.plan === "free" || patch.plan === "pro" ? patch.plan : current.plan;
  const nextDailyLimit = getDailyTokenLimitForPlan(nextPlan);
  const nextTokensUsed = patch.resetDaily === true ? 0 : current.tokensUsed;
  const nextPromptUsed = patch.resetDaily === true ? 0 : current.promptTokensUsed;
  const nextCompletionUsed = patch.resetDaily === true ? 0 : current.completionTokensUsed;
  const deltaTokens =
    typeof patch.addTokens === "number" && Number.isFinite(patch.addTokens)
      ? Math.trunc(patch.addTokens)
      : 0;
  const nextBonusTokens = Math.max(0, current.bonusTokens + deltaTokens);

  setBoundedMap(userPlanMap, cleanUserId, nextPlan);

  if (nextPlan === "free") {
    userProExpiresAtMap.delete(cleanUserId);
  } else if (
    nextPlan === "pro" &&
    typeof patch.proDurationDays === "number" &&
    Number.isFinite(patch.proDurationDays) &&
    patch.proDurationDays > 0
  ) {
    const existingMs = current.expiresAt ? Date.parse(current.expiresAt) : NaN;
    const baseMs =
      Number.isFinite(existingMs) && existingMs > now.getTime() ? existingMs : now.getTime();
    const nextExpiryIso = new Date(
      baseMs + Math.floor(patch.proDurationDays) * 24 * 60 * 60 * 1000
    ).toISOString();
    setBoundedMap(userProExpiresAtMap, cleanUserId, nextExpiryIso);
  }

  setBoundedMap(userBonusTokensMap, cleanUserId, nextBonusTokens);
  setBoundedMap(dailyTokenUsageMap, makeUsageKey(cleanUserId, current.dateWib), {
    userId: cleanUserId,
    dateWib: current.dateWib,
    dailyTokenLimit: nextDailyLimit,
    tokensUsed: nextTokensUsed,
    promptTokensUsed: nextPromptUsed,
    completionTokensUsed: nextCompletionUsed,
    updatedAt: now.toISOString(),
  });

  persistLocalStoreSafe();
  await upsertSupabaseQuotaRow({
    userId: cleanUserId,
    dateWib: current.dateWib,
    plan: nextPlan,
    dailyTokenLimit: nextDailyLimit,
    tokensUsed: nextTokensUsed,
    promptTokensUsed: nextPromptUsed,
    completionTokensUsed: nextCompletionUsed,
    bonusTokens: nextBonusTokens,
    proExpiresAt: userProExpiresAtMap.get(cleanUserId) || null,
  });

  return getUserQuota(cleanUserId, now);
}

/**
 * Activates Axioma Pro subscription for `durationDays` (default 30 days).
 */
export async function activateProSubscription(
  userId: string,
  durationDays = 30,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  return adminUpdateUserQuota(
    userId,
    {
      plan: "pro",
      proDurationDays: durationDays,
    },
    now
  );
}

/**
 * Adds permanent top-up/bonus tokens to `bonusTokens` (never reset at 00:00 WIB).
 */
export async function addPermanentBonusTokens(
  userId: string,
  tokens: number,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  return adminUpdateUserQuota(
    userId,
    {
      addTokens: Math.max(0, Math.trunc(tokens)),
    },
    now
  );
}
