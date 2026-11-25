import fs from "fs";
import path from "path";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  DAILY_FREE_CREDITS,
  MODEL_CREDIT_COST,
  PLAN_TIERS,
  QuotaModelKey,
  QuotaPlanId,
} from "../config/quotaConfig";

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7 (Waktu Indonesia Barat)
const UNLIMITED_CREDITS_DISPLAY = 999_999;

export interface UserQuotaSnapshot {
  plan: QuotaPlanId;
  unlimited: boolean;
  remainingCredits: number;
  dailyCredits: number;
  bonusCredits: number;
  dailyLimit: number;
  usedToday: number;
  resetAt: string;
  expiresAt?: string;
  costs: typeof MODEL_CREDIT_COST;
  tiers: typeof PLAN_TIERS;
}

export type QuotaCheckResult =
  | {
      allowed: true;
      plan: QuotaPlanId;
      remaining: number;
      dailyCredits: number;
      bonusCredits: number;
      required: number;
      resetAt: string;
    }
  | {
      allowed: false;
      code: "QUOTA_EXCEEDED";
      plan: QuotaPlanId;
      required: number;
      remaining: number;
      dailyCredits: number;
      bonusCredits: number;
      resetAt: string;
      suggestedModel: "omni";
    };

interface DailyUsageRecord {
  userId: string;
  dateWib: string;
  dailyCredits: number;
  usedCredits: number;
  updatedAt: string;
}

interface PersistedQuotaFile {
  plans: Record<string, QuotaPlanId>;
  proExpiresAt?: Record<string, string>;
  bonusCredits: Record<string, number>;
  dailyUsage: Record<string, DailyUsageRecord>;
}

const DATA_DIR = path.resolve(process.cwd(), ".data");
const QUOTA_STORE_PATH = path.join(DATA_DIR, "axioma-quota.json");
const MAX_QUOTA_CACHE_ENTRIES = 5_000;
const QUOTA_CACHE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const LOCAL_PERSIST_DEBOUNCE_MS = 2_000;

// Fast in-memory cache keyed by `${userId}:${YYYY-MM-DD_WIB}`
const dailyUsageMap = new Map<string, DailyUsageRecord>();
const userPlanMap = new Map<string, QuotaPlanId>();
const userProExpiresAtMap = new Map<string, string>();
const userBonusCreditsMap = new Map<string, number>();

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries = MAX_QUOTA_CACHE_ENTRIES): void {
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
  for (const [key, rec] of dailyUsageMap.entries()) {
    if (rec.dateWib !== todayWib) {
      dailyUsageMap.delete(key);
    }
  }
  for (const map of [dailyUsageMap, userPlanMap, userProExpiresAtMap, userBonusCreditsMap] as Array<Map<string, unknown>>) {
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

/**
 * Binds the initialized Supabase client so quota tracking automatically persists to
 * `public.user_daily_quotas`, probing connectivity at startup and logging active storage mode.
 */
export function bindQuotaSupabaseClient(client: SupabaseClient | null): void {
  supabaseRef = client;
  supabaseQuotaTableAvailable = null;

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
        .select("user_id")
        .limit(1);
      if (error) {
        const msg = String(error.message || "").toLowerCase();
        if (
          error.code === "42P01" ||
          error.code === "PGRST205" ||
          msg.includes("does not exist") ||
          msg.includes("could not find the table")
        ) {
          supabaseQuotaTableAvailable = false;
          console.warn(
            "[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — tabel public.user_daily_quotas belum dibuat di Supabase"
          );
          return;
        }
        console.warn(
          `[QuotaService] Storage: Local JSON fallback (.data/axioma-quota.json) — probe Supabase gagal: ${error.message}`
        );
        return;
      }
      supabaseQuotaTableAvailable = true;
      console.log("[QuotaService] Storage: Supabase (public.user_daily_quotas)");
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
    const parsed = JSON.parse(raw) as Partial<PersistedQuotaFile>;

    if (parsed.plans && typeof parsed.plans === "object") {
      for (const [uid, plan] of Object.entries(parsed.plans)) {
        if (plan === "free" || plan === "pro") {
          userPlanMap.set(uid, plan);
        }
      }
    }

    if (parsed.proExpiresAt && typeof parsed.proExpiresAt === "object") {
      for (const [uid, iso] of Object.entries(parsed.proExpiresAt)) {
        if (typeof iso === "string" && iso.trim() && Number.isFinite(Date.parse(iso))) {
          userProExpiresAtMap.set(uid, iso.trim());
        }
      }
    }

    if (parsed.bonusCredits && typeof parsed.bonusCredits === "object") {
      for (const [uid, credits] of Object.entries(parsed.bonusCredits)) {
        if (typeof credits === "number" && Number.isFinite(credits) && credits >= 0) {
          userBonusCreditsMap.set(uid, Math.floor(credits));
        }
      }
    }

    const todayWib = getWibDateKey();
    if (parsed.dailyUsage && typeof parsed.dailyUsage === "object") {
      for (const [key, rec] of Object.entries(parsed.dailyUsage)) {
        if (!rec || typeof rec !== "object" || rec.dateWib !== todayWib) {
          continue;
        }
        const rawRec = rec as Partial<DailyUsageRecord>;
        let hydratedDailyCredits: number | null = null;
        if (
          typeof rawRec.dailyCredits === "number" &&
          Number.isFinite(rawRec.dailyCredits) &&
          rawRec.dailyCredits >= 0
        ) {
          hydratedDailyCredits = Math.min(
            DAILY_FREE_CREDITS,
            Math.floor(rawRec.dailyCredits)
          );
        } else if (
          typeof rawRec.usedCredits === "number" &&
          Number.isFinite(rawRec.usedCredits) &&
          rawRec.usedCredits >= 0
        ) {
          hydratedDailyCredits = Math.max(
            0,
            DAILY_FREE_CREDITS - Math.floor(rawRec.usedCredits)
          );
        }

        if (hydratedDailyCredits !== null) {
          dailyUsageMap.set(key, {
            userId: String(rawRec.userId || key.split(":")[0] || ""),
            dateWib: todayWib,
            dailyCredits: hydratedDailyCredits,
            usedCredits: Math.max(0, DAILY_FREE_CREDITS - hydratedDailyCredits),
            updatedAt: String(rawRec.updatedAt || new Date().toISOString()),
          });
        }
      }
    }
  } catch (err: any) {
    console.warn("[quotaService] Local quota store hydration warning (falling back to in-memory):", err?.message || err);
  }
}

async function flushLocalStoreAsync(): Promise<void> {
  if (localPersistInFlight) {
    localPersistQueuedAgain = true;
    return;
  }
  // Skip local JSON persistence completely when Supabase DB is active
  if (supabaseRef && supabaseQuotaTableAvailable === true) {
    return;
  }

  localPersistInFlight = true;
  try {
    cleanupQuotaMaps();

    await fs.promises.mkdir(DATA_DIR, { recursive: true });

    const payload: PersistedQuotaFile = {
      plans: Object.fromEntries(userPlanMap.entries()),
      proExpiresAt: Object.fromEntries(userProExpiresAtMap.entries()),
      bonusCredits: Object.fromEntries(userBonusCreditsMap.entries()),
      dailyUsage: Object.fromEntries(dailyUsageMap.entries()),
    };

    const tmpPath = `${QUOTA_STORE_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload), "utf-8");
    await fs.promises.rename(tmpPath, QUOTA_STORE_PATH);
  } catch (err: any) {
    // Never break request flow if filesystem is read-only (e.g., serverless/container); in-memory Map remains active
    console.warn("[quotaService] Local quota persist skipped (in-memory active):", err?.message || err);
  } finally {
    localPersistInFlight = false;
    if (localPersistQueuedAgain) {
      localPersistQueuedAgain = false;
      void flushLocalStoreAsync();
    }
  }
}

function persistLocalStoreSafe(_now: Date = new Date()): void {
  // When Supabase DB is active, quota state is persisted in `public.user_daily_quotas` — skip local disk writes
  if (supabaseRef && supabaseQuotaTableAvailable === true) {
    return;
  }
  // Debounced non-blocking async write for local JSON fallback mode
  if (pendingLocalPersistTimer !== null) {
    return;
  }
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
  dailyCredits?: number;
  usedCredits?: number;
  bonusCredits?: number;
  proExpiresAt?: string | null;
  updatedAt?: string;
} | null> {
  if (!supabaseRef || supabaseQuotaTableAvailable === false) {
    return null;
  }

  try {
    const { data, error } = await supabaseRef
      .from("user_daily_quotas")
      .select("plan, daily_credits, used_credits, bonus_credits, pro_expires_at, updated_at")
      .eq("user_id", userId)
      .eq("usage_date", dateWib)
      .maybeSingle();

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        msg.includes("does not exist") ||
        msg.includes("could not find the table")
      ) {
        supabaseQuotaTableAvailable = false;
      }
      return null;
    }

    supabaseQuotaTableAvailable = true;
    if (data) {
      const usedVal =
        typeof data.used_credits === "number"
          ? Math.max(0, Math.floor(data.used_credits))
          : 0;
      const dailyVal =
        typeof data.daily_credits === "number"
          ? Math.min(DAILY_FREE_CREDITS, Math.max(0, Math.floor(data.daily_credits)))
          : Math.max(0, DAILY_FREE_CREDITS - usedVal);

      return {
        hasTodayRow: true,
        plan: data.plan === "pro" ? "pro" : "free",
        dailyCredits: dailyVal,
        usedCredits: usedVal,
        bonusCredits:
          typeof data.bonus_credits === "number"
            ? Math.max(0, Math.floor(data.bonus_credits))
            : 0,
        proExpiresAt:
          typeof data.pro_expires_at === "string" && data.pro_expires_at.trim()
            ? data.pro_expires_at.trim()
            : null,
        updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
      };
    }

    // No row yet for today's WIB date: carry forward permanent `plan`, `bonus_credits`, and `pro_expires_at`
    // from the user's most recent previous row while resetting daily allowance to 30 (`usedCredits = 0`).
    const { data: latestPrev, error: prevError } = await supabaseRef
      .from("user_daily_quotas")
      .select("plan, bonus_credits, pro_expires_at, updated_at")
      .eq("user_id", userId)
      .order("usage_date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prevError || !latestPrev) return null;

    return {
      hasTodayRow: false,
      plan: latestPrev.plan === "pro" ? "pro" : "free",
      dailyCredits: DAILY_FREE_CREDITS,
      usedCredits: 0,
      bonusCredits:
        typeof latestPrev.bonus_credits === "number"
          ? Math.max(0, Math.floor(latestPrev.bonus_credits))
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

async function upsertSupabaseQuotaRow(
  userId: string,
  dateWib: string,
  plan: QuotaPlanId,
  dailyCredits: number,
  usedCredits: number,
  bonusCredits: number,
  proExpiresAt?: string | null
): Promise<void> {
  if (!supabaseRef || supabaseQuotaTableAvailable === false) {
    return;
  }
  try {
    const { error } = await supabaseRef.from("user_daily_quotas").upsert(
      {
        user_id: userId,
        usage_date: dateWib,
        plan,
        daily_credits: Math.min(DAILY_FREE_CREDITS, Math.max(0, Math.floor(dailyCredits))),
        used_credits: Math.max(0, Math.floor(usedCredits)),
        bonus_credits: Math.max(0, Math.floor(bonusCredits)),
        pro_expires_at: proExpiresAt || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,usage_date" }
    );
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (
        error.code === "42P01" ||
        error.code === "PGRST205" ||
        msg.includes("does not exist") ||
        msg.includes("could not find the table")
      ) {
        supabaseQuotaTableAvailable = false;
      }
    }
  } catch {
    // Best-effort DB sync; local persistent store + Map remain authoritative
  }
}

async function loadUserDailyState(
  userId: string,
  now: Date = new Date()
): Promise<{
  plan: QuotaPlanId;
  dailyCredits: number;
  usedToday: number;
  bonusCredits: number;
  dateWib: string;
  expiresAt?: string;
}> {
  hydrateLocalStoreOnce();

  const cleanUserId = (userId || "").trim() || "anonymous";
  const dateWib = getWibDateKey(now);
  const usageKey = makeUsageKey(cleanUserId, dateWib);

  // Check optional DB row if table is available (preserving permanent bonusCredits across WIB day rollover)
  const dbRow = await readSupabaseQuotaRow(cleanUserId, dateWib);
  if (dbRow) {
    const existingLocal = dailyUsageMap.get(usageKey);
    const localUpdatedMs = existingLocal ? Date.parse(existingLocal.updatedAt) || 0 : 0;
    const dbUpdatedMs = dbRow.updatedAt ? Date.parse(dbRow.updatedAt) || 0 : 0;

    if (dbRow.plan && (!userPlanMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)) {
      setBoundedMap(userPlanMap, cleanUserId, dbRow.plan);
    }
    if (
      typeof dbRow.bonusCredits === "number" &&
      (!userBonusCreditsMap.has(cleanUserId) || dbUpdatedMs > localUpdatedMs)
    ) {
      setBoundedMap(userBonusCreditsMap, cleanUserId, Math.max(0, dbRow.bonusCredits));
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
      const dbDaily =
        typeof dbRow.dailyCredits === "number"
          ? Math.min(DAILY_FREE_CREDITS, Math.max(0, dbRow.dailyCredits))
          : Math.max(0, DAILY_FREE_CREDITS - Math.max(0, dbRow.usedCredits ?? 0));
      const dbUsed = Math.max(0, DAILY_FREE_CREDITS - dbDaily);
      setBoundedMap(dailyUsageMap, usageKey, {
        userId: cleanUserId,
        dateWib,
        dailyCredits: dbDaily,
        usedCredits: dbUsed,
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
      persistLocalStoreSafe(now);
    }
  }

  const existingDailyRecord = dailyUsageMap.get(usageKey);
  const dailyCredits = existingDailyRecord
    ? Math.max(0, Math.min(DAILY_FREE_CREDITS, existingDailyRecord.dailyCredits))
    : DAILY_FREE_CREDITS;
  const usedToday = Math.max(0, DAILY_FREE_CREDITS - dailyCredits);
  const bonusCredits = Math.max(0, userBonusCreditsMap.get(cleanUserId) ?? 0);

  return { plan, dailyCredits, usedToday, bonusCredits, dateWib, expiresAt };
}

/**
 * Returns the active quota status for `userId` with separate daily free credits (auto-reset 00:00 WIB)
 * and permanent top-up/admin `bonusCredits` (never reset on date rollover).
 */
export async function getUserQuota(
  userId: string,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  const { plan, dailyCredits, usedToday, bonusCredits, expiresAt } =
    await loadUserDailyState(userId, now);
  const resetAt = getNextWibMidnightIso(now);
  const unlimited = plan === "pro";
  const effectiveDailyCredits = unlimited ? DAILY_FREE_CREDITS : dailyCredits;
  const remainingCredits = unlimited
    ? UNLIMITED_CREDITS_DISPLAY
    : effectiveDailyCredits + bonusCredits;

  return {
    plan,
    unlimited,
    remainingCredits,
    dailyCredits: effectiveDailyCredits,
    bonusCredits,
    dailyLimit: DAILY_FREE_CREDITS,
    usedToday,
    resetAt,
    ...(unlimited && expiresAt ? { expiresAt } : {}),
    costs: MODEL_CREDIT_COST,
    tiers: PLAN_TIERS,
  };
}

export interface PreflightUserQuotaState {
  userId: string;
  plan: QuotaPlanId;
  dailyCredits: number;
  usedToday: number;
  bonusCredits: number;
  dateWib: string;
  expiresAt?: string;
}

/**
 * Loads user's daily quota state without consuming credits yet.
 * Useful to run in parallel with Turnstile & chat/history lookup before committing deduction.
 */
export async function prefetchUserQuotaState(
  userId: string,
  now: Date = new Date()
): Promise<PreflightUserQuotaState> {
  const cleanUserId = (userId || "").trim() || "anonymous";
  const loaded = await loadUserDailyState(cleanUserId, now);
  return {
    userId: cleanUserId,
    ...loaded,
  };
}

/**
 * Synchronously validates and deducts credits using a prefetched quota state (0ms DB latency).
 * Persists asynchronously to Supabase (`upsertSupabaseQuotaRow`) and debounced local fallback if needed.
 */
export function consumeQuotaFromPreflight(
  preflight: PreflightUserQuotaState,
  modelKey: QuotaModelKey,
  now: Date = new Date()
): QuotaCheckResult {
  const cleanUserId = preflight.userId;
  const cost = MODEL_CREDIT_COST[modelKey] ?? MODEL_CREDIT_COST.pro;
  const resetAt = getNextWibMidnightIso(now);
  const { plan, dateWib } = preflight;

  // Guard against concurrent requests updating in-memory balances while preflight was in flight
  const usageKey = makeUsageKey(cleanUserId, dateWib);
  const latestDailyRecord = dailyUsageMap.get(usageKey);
  const dailyCredits = latestDailyRecord
    ? Math.min(preflight.dailyCredits, Math.max(0, Math.min(DAILY_FREE_CREDITS, latestDailyRecord.dailyCredits)))
    : preflight.dailyCredits;
  const latestBonus = userBonusCreditsMap.get(cleanUserId);
  const bonusCredits =
    typeof latestBonus === "number"
      ? Math.min(preflight.bonusCredits, Math.max(0, latestBonus))
      : preflight.bonusCredits;

  if (plan === "pro") {
    return {
      allowed: true,
      plan: "pro",
      remaining: UNLIMITED_CREDITS_DISPLAY,
      dailyCredits: DAILY_FREE_CREDITS,
      bonusCredits,
      required: cost,
      resetAt,
    };
  }

  const totalAvailable = dailyCredits + bonusCredits;

  if (totalAvailable < cost) {
    return {
      allowed: false,
      code: "QUOTA_EXCEEDED",
      plan,
      required: cost,
      remaining: totalAvailable,
      dailyCredits,
      bonusCredits,
      resetAt,
      suggestedModel: "omni",
    };
  }

  // Consume from daily free allowance (`dailyCredits`) first, then permanent `bonusCredits`
  const consumeFromDaily = Math.min(dailyCredits, cost);
  const consumeFromBonus = cost - consumeFromDaily;
  const nextDailyCredits = Math.max(0, dailyCredits - consumeFromDaily);
  const nextUsedToday = Math.max(0, DAILY_FREE_CREDITS - nextDailyCredits);
  const nextBonusCredits = Math.max(0, bonusCredits - consumeFromBonus);
  const nextRemaining = nextDailyCredits + nextBonusCredits;

  setBoundedMap(dailyUsageMap, usageKey, {
    userId: cleanUserId,
    dateWib,
    dailyCredits: nextDailyCredits,
    usedCredits: nextUsedToday,
    updatedAt: now.toISOString(),
  });
  setBoundedMap(userBonusCreditsMap, cleanUserId, nextBonusCredits);

  persistLocalStoreSafe(now);
  void upsertSupabaseQuotaRow(
    cleanUserId,
    dateWib,
    plan,
    nextDailyCredits,
    nextUsedToday,
    nextBonusCredits,
    userProExpiresAtMap.get(cleanUserId) || null
  );

  return {
    allowed: true,
    plan,
    remaining: nextRemaining,
    dailyCredits: nextDailyCredits,
    bonusCredits: nextBonusCredits,
    required: cost,
    resetAt,
  };
}

/**
 * Checks whether `userId` has enough credits for `modelKey` and deducts atomically when allowed.
 * - `plan === "pro"` is always permitted without deducting `dailyCredits` or `bonusCredits`.
 * - Free users consume `dailyCredits` first, then take any remainder from permanent `bonusCredits`.
 * - Rejects with `QUOTA_EXCEEDED` when `dailyCredits + bonusCredits < cost`.
 */
export async function checkAndConsumeQuota(
  userId: string,
  modelKey: QuotaModelKey,
  now: Date = new Date()
): Promise<QuotaCheckResult> {
  const preflight = await prefetchUserQuotaState(userId, now);
  return consumeQuotaFromPreflight(preflight, modelKey, now);
}

export interface AdminQuotaUpdateInput {
  addCredits?: number;
  resetDaily?: boolean;
  plan?: QuotaPlanId;
  proDurationDays?: number;
}

/**
 * Admin operation:
 * - `addCredits`: adds directly to permanent `bonusCredits` (never modifies `dailyCredits`).
 * - `resetDaily`: resets only `dailyCredits` back to `DAILY_FREE_CREDITS` (30) without touching `bonusCredits`.
 * - `plan`: updates subscription tier (`free` | `pro`), with optional `proDurationDays` (e.g. 30 days).
 */
export async function adminUpdateUserQuota(
  userId: string,
  patch: AdminQuotaUpdateInput,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  const cleanUserId = (userId || "").trim();
  const { plan: currentPlan, dailyCredits, bonusCredits, dateWib, expiresAt: currentExpiresAt } =
    await loadUserDailyState(cleanUserId, now);

  const nextPlan: QuotaPlanId =
    patch.plan === "free" || patch.plan === "pro" ? patch.plan : currentPlan;
  const nextDailyCredits =
    patch.resetDaily === true ? DAILY_FREE_CREDITS : dailyCredits;
  const nextUsedToday = Math.max(0, DAILY_FREE_CREDITS - nextDailyCredits);
  const deltaCredits =
    typeof patch.addCredits === "number" && Number.isFinite(patch.addCredits)
      ? Math.trunc(patch.addCredits)
      : 0;
  const nextBonusCredits = Math.max(0, bonusCredits + deltaCredits);

  userPlanMap.set(cleanUserId, nextPlan);

  if (nextPlan === "free") {
    userProExpiresAtMap.delete(cleanUserId);
  } else if (
    nextPlan === "pro" &&
    typeof patch.proDurationDays === "number" &&
    Number.isFinite(patch.proDurationDays) &&
    patch.proDurationDays > 0
  ) {
    const existingMs = currentExpiresAt ? Date.parse(currentExpiresAt) : NaN;
    const baseMs =
      Number.isFinite(existingMs) && existingMs > now.getTime()
        ? existingMs
        : now.getTime();
    const nextExpiryIso = new Date(
      baseMs + Math.floor(patch.proDurationDays) * 24 * 60 * 60 * 1000
    ).toISOString();
    userProExpiresAtMap.set(cleanUserId, nextExpiryIso);
  }

  userBonusCreditsMap.set(cleanUserId, nextBonusCredits);
  dailyUsageMap.set(makeUsageKey(cleanUserId, dateWib), {
    userId: cleanUserId,
    dateWib,
    dailyCredits: nextDailyCredits,
    usedCredits: nextUsedToday,
    updatedAt: now.toISOString(),
  });

  persistLocalStoreSafe(now);
  await upsertSupabaseQuotaRow(
    cleanUserId,
    dateWib,
    nextPlan,
    nextDailyCredits,
    nextUsedToday,
    nextBonusCredits,
    userProExpiresAtMap.get(cleanUserId) || null
  );

  return getUserQuota(cleanUserId, now);
}

/**
 * Activates Axioma Pro subscription for `durationDays` (default 30 days).
 * Extends cleanly from existing future expiration if the user is already Pro.
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
 * Adds permanent top-up/bonus credits to `bonusCredits` (never reset at 00:00 WIB).
 */
export async function addPermanentBonusCredits(
  userId: string,
  credits: number,
  now: Date = new Date()
): Promise<UserQuotaSnapshot> {
  return adminUpdateUserQuota(
    userId,
    {
      addCredits: Math.max(0, Math.trunc(credits)),
    },
    now
  );
}
