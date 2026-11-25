import { Request, Response, NextFunction, RequestHandler } from "express";

export type AxiomaRateLimitTier = "chat" | "heavy";

interface BurstBucket {
  count: number;
  resetAtMs: number;
}

interface DailyBucket {
  dayKey: string;
  count: number;
}

const ONE_MINUTE_MS = 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

const burstBuckets = new Map<string, BurstBucket>();
const dailyChatBuckets = new Map<string, DailyBucket>();
const dailyHeavyBuckets = new Map<string, DailyBucket>();

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

/**
 * Current calendar day key in WIB (UTC+7) so daily beta quotas reset cleanly at 00:00 WIB.
 */
function getCurrentWibDayKey(nowMs: number): string {
  const wibDate = new Date(nowMs + WIB_OFFSET_MS);
  const y = wibDate.getUTCFullYear();
  const m = String(wibDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wibDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Exact seconds remaining until next 00:00 WIB midnight.
 */
function getSecondsUntilNextWibMidnight(nowMs: number): number {
  const wibMs = nowMs + WIB_OFFSET_MS;
  const msIntoDay = ((wibMs % 86_400_000) + 86_400_000) % 86_400_000;
  const remainingMs = 86_400_000 - msIntoDay;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function resolveRequesterKey(req: Request): string {
  // 1. Prefer explicit userId from header or parsed request body if provided
  const headerUserId = req.headers["x-user-id"];
  const rawHeaderId = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId;
  const bodyObj = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : null;
  const rawBodyId =
    typeof bodyObj?.userId === "string"
      ? bodyObj.userId
      : typeof bodyObj?.user_id === "string"
      ? bodyObj.user_id
      : undefined;

  const candidateUserId = (rawHeaderId || rawBodyId || "").trim();
  if (candidateUserId && candidateUserId.length <= 128) {
    return `user:${candidateUserId}`;
  }

  // 2. Fallback to client IP (Cloudflare & reverse proxy aware)
  const activeOriginSecret = (process.env.CF_ORIGIN_SECRET || "").trim();
  const isCfTrusted = !activeOriginSecret || (req as any).originLockVerified === true;
  if (isCfTrusted) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim()) {
      return `ip:${cfIp.trim()}`;
    }
  }

  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp =
    typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : Array.isArray(forwarded)
      ? forwarded[0]?.split(",")[0]?.trim()
      : "";
  const ip = forwardedIp || req.ip || req.socket?.remoteAddress || "unknown";
  return `ip:${ip}`;
}

function pruneStaleBuckets(nowMs: number, currentDayKey: string): void {
  if (burstBuckets.size > MAX_TRACKED_KEYS) {
    for (const [key, bucket] of burstBuckets.entries()) {
      if (bucket.resetAtMs <= nowMs) {
        burstBuckets.delete(key);
      }
    }
  }
  if (dailyChatBuckets.size > MAX_TRACKED_KEYS) {
    for (const [key, bucket] of dailyChatBuckets.entries()) {
      if (bucket.dayKey !== currentDayKey) {
        dailyChatBuckets.delete(key);
      }
    }
  }
  if (dailyHeavyBuckets.size > MAX_TRACKED_KEYS) {
    for (const [key, bucket] of dailyHeavyBuckets.entries()) {
      if (bucket.dayKey !== currentDayKey) {
        dailyHeavyBuckets.delete(key);
      }
    }
  }
}

// Background cleanup every 10 minutes without blocking graceful process exit
const cleanupTimer = setInterval(() => {
  const nowMs = Date.now();
  const dayKey = getCurrentWibDayKey(nowMs);
  for (const [key, bucket] of burstBuckets.entries()) {
    if (bucket.resetAtMs <= nowMs) {
      burstBuckets.delete(key);
    }
  }
  for (const [key, bucket] of dailyChatBuckets.entries()) {
    if (bucket.dayKey !== dayKey) {
      dailyChatBuckets.delete(key);
    }
  }
  for (const [key, bucket] of dailyHeavyBuckets.entries()) {
    if (bucket.dayKey !== dayKey) {
      dailyHeavyBuckets.delete(key);
    }
  }
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

const FRIENDLY_RATE_LIMIT_MESSAGE =
  "Kuota pemakaian sementara tercapai. Coba lagi beberapa saat lagi atau besok.";

/**
 * Lightweight in-memory per-minute burst + daily quota middleware for Axioma Beta.
 *
 * Tiers:
 * - "chat": 15 req/min (RATE_LIMIT_PER_MIN) & 60 req/day (DAILY_CHAT_LIMIT)
 * - "heavy" (PDF / Vision / Studio): 15 req/min (RATE_LIMIT_PER_MIN) & 10 req/day (DAILY_HEAVY_LIMIT)
 *
 * Bypassed automatically when NODE_ENV === "development" AND ENABLE_DEV_RATE_LIMIT !== "true".
 */
export function axiomaRateLimiter(tier: AxiomaRateLimitTier = "chat"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      process.env.NODE_ENV === "development" &&
      process.env.ENABLE_DEV_RATE_LIMIT !== "true"
    ) {
      return next();
    }

    const nowMs = Date.now();
    const dayKey = getCurrentWibDayKey(nowMs);
    pruneStaleBuckets(nowMs, dayKey);

    const maxPerMin = parsePositiveIntEnv(process.env.RATE_LIMIT_PER_MIN, 15);
    const maxDaily =
      tier === "heavy"
        ? parsePositiveIntEnv(process.env.DAILY_HEAVY_LIMIT, 10)
        : parsePositiveIntEnv(process.env.DAILY_CHAT_LIMIT, 60);

    const requesterKey = resolveRequesterKey(req);

    // 1. Check per-minute burst window
    let burst = burstBuckets.get(requesterKey);
    if (!burst || burst.resetAtMs <= nowMs) {
      burst = { count: 0, resetAtMs: nowMs + ONE_MINUTE_MS };
    }

    if (burst.count >= maxPerMin) {
      const retryAfterSeconds = Math.max(1, Math.ceil((burst.resetAtMs - nowMs) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: "RATE_LIMIT_EXCEEDED",
        message: FRIENDLY_RATE_LIMIT_MESSAGE,
        error: FRIENDLY_RATE_LIMIT_MESSAGE,
        retryAfterSeconds,
      });
    }

    // 2. Check daily tier quota (auto-resets on day rollover)
    const dailyMap = tier === "heavy" ? dailyHeavyBuckets : dailyChatBuckets;
    let daily = dailyMap.get(requesterKey);
    if (!daily || daily.dayKey !== dayKey) {
      daily = { dayKey, count: 0 };
    }

    if (daily.count >= maxDaily) {
      const retryAfterSeconds = getSecondsUntilNextWibMidnight(nowMs);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        success: false,
        code: "RATE_LIMIT_EXCEEDED",
        message: FRIENDLY_RATE_LIMIT_MESSAGE,
        error: FRIENDLY_RATE_LIMIT_MESSAGE,
        retryAfterSeconds,
      });
    }

    // Commit increments only after both checks pass
    burst.count += 1;
    burstBuckets.set(requesterKey, burst);

    daily.count += 1;
    dailyMap.set(requesterKey, daily);

    res.setHeader("X-RateLimit-Limit-Min", String(maxPerMin));
    res.setHeader("X-RateLimit-Remaining-Min", String(Math.max(0, maxPerMin - burst.count)));
    res.setHeader("X-RateLimit-Limit-Day", String(maxDaily));
    res.setHeader("X-RateLimit-Remaining-Day", String(Math.max(0, maxDaily - daily.count)));

    return next();
  };
}

/**
 * Helper for automated tests to clear in-memory rate-limit counters.
 */
export function resetAxiomaRateLimitStore(): void {
  burstBuckets.clear();
  dailyChatBuckets.clear();
  dailyHeavyBuckets.clear();
}
