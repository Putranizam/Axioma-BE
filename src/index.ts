import dotenv from "dotenv";
dotenv.config();

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI, Content, Part } from "@google/generative-ai";
import multer from "multer";
import {
  detectMagicMimeType,
  countPdfPages,
  extractImageDimensions,
  sanitizeFilename,
  globalUploadLimiter,
  getDailyUserUploadCount,
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_SIZE_BYTES,
  MAX_PDF_PAGES,
  SIGNED_URL_TTL_SECONDS,
} from "./attachments";
import { transcribeAudio, synthesizeSpeech } from "./voice";
import {
  getModelChain,
  isRetryableGeminiError,
  isQuotaOrRateLimitError,
  isZeroQuotaError,
  modelCooldownUntil,
  COOLDOWN_DURATIONS,
} from "./geminiModels";

const app = express();
const PORT = process.env.PORT || 8000;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Disable Express fingerprint header & enable Helmet security headers (#6)
app.disable("x-powered-by");
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Configure reverse proxy trust so req.ip reflects the real client IP behind proxies (#3)
const rawTrustProxy = process.env.TRUST_PROXY;
const trustProxySetting =
  rawTrustProxy !== undefined && rawTrustProxy.trim() !== ""
    ? Number.isNaN(Number(rawTrustProxy))
      ? rawTrustProxy.trim()
      : Number(rawTrustProxy)
    : 1;
app.set("trust proxy", trustProxySetting);

// Centralized Error Reporting (Structured JSON logs + Sentry HTTP intake ready via SENTRY_DSN) (#10)
export interface ErrorReportContext {
  requestId?: string;
  route?: string;
  method?: string;
  userId?: string;
  ip?: string;
  extra?: Record<string, unknown>;
}

function parseSentryDsn(dsn: string): { endpoint: string; publicKey: string } | null {
  try {
    const url = new URL(dsn.trim());
    const publicKey = url.username;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const projectId = pathParts[pathParts.length - 1];
    if (!publicKey || !projectId) return null;
    const basePath = pathParts.slice(0, -1).join("/");
    const prefix = basePath ? `/${basePath}` : "";
    return {
      endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
      publicKey,
    };
  } catch {
    return null;
  }
}

export function reportCentralizedError(err: unknown, context: ErrorReportContext = {}): void {
  const errorObj = err instanceof Error ? err : new Error(String(err));
  const payload = {
    level: "error",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    message: errorObj.message,
    name: errorObj.name,
    stack: errorObj.stack,
    ...context,
  };

  console.error(`[AXIOMA_CENTRAL_ERROR] ${JSON.stringify(payload)}`);

  const sentryDsn = (process.env.SENTRY_DSN || "").trim();
  if (!sentryDsn) return;

  const parsedDsn = parseSentryDsn(sentryDsn);
  if (!parsedDsn) return;

  const sentryEvent = {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: payload.environment,
    server_name: "axioma-backend",
    message: errorObj.message,
    exception: {
      values: [
        {
          type: errorObj.name || "Error",
          value: errorObj.message,
          stacktrace: {
            frames: (errorObj.stack || "")
              .split("\n")
              .slice(1, 15)
              .map((line) => ({ filename: line.trim() })),
          },
        },
      ],
    },
    tags: {
      route: context.route || "unknown",
      method: context.method || "unknown",
    },
    user: {
      id: context.userId,
      ip_address: context.ip,
    },
    extra: context.extra,
  };

  void fetch(parsedDsn.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=axioma-backend/1.0, sentry_key=${parsedDsn.publicKey}`,
    },
    body: JSON.stringify(sentryEvent),
  }).catch(() => {
    // Never fail request flow if external Sentry transport is unreachable
  });
}

// Reject malformed URL percent-encodings (e.g. /api/chats/%00%ff) and null bytes with 400 (#7)
app.use((req: Request, res: Response, next: NextFunction) => {
  try {
    const rawUrl = req.originalUrl || req.url || "";
    const decoded = decodeURIComponent(rawUrl);
    if (decoded.includes("\0")) {
      return res.status(400).json({
        success: false,
        code: "invalid_url",
        error: "Format URL atau parameter permintaan tidak valid.",
      });
    }
  } catch {
    return res.status(400).json({
      success: false,
      code: "invalid_url",
      error: "Format URL atau parameter permintaan tidak valid.",
    });
  }
  next();
});

// Cloudflare Origin Lock (#6):
// If CF_ORIGIN_SECRET is configured, reject requests missing X-Origin-Secret header (except /health & /api/health)
app.use((req: Request, res: Response, next: NextFunction) => {
  const normalizedPath = (req.path || "").replace(/\/+$/, "") || "/";
  if (normalizedPath === "/health" || normalizedPath === "/api/health") {
    return next();
  }

  const activeOriginSecret = (process.env.CF_ORIGIN_SECRET || "").trim();
  if (activeOriginSecret) {
    const originSecretHeader = req.headers["x-origin-secret"];
    if (!originSecretHeader || originSecretHeader !== activeOriginSecret) {
      return res.status(403).json({
        success: false,
        code: "origin_forbidden",
        error: "Akses ditolak: permintaan tidak melalui proxy resmi Cloudflare.",
      });
    }
    (req as any).originLockVerified = true;
  }
  next();
});

// 1. Server Setup: Strict CORS allowlist (#4) & JSON body parsing with 1mb limit (#9)
const rawConfiguredOrigins = [
  process.env.ALLOWED_ORIGINS,
  process.env.FRONTEND_URL,
  process.env.NEXT_PUBLIC_APP_URL,
]
  .filter(Boolean)
  .join(",");

const configuredOrigins = rawConfiguredOrigins
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Origin resmi frontend produksi (Vercel & domain kustom)
const defaultProductionOrigins = [
  "https://axioma.my.id",
  "https://www.axioma.my.id",
  "https://axioma-fe.vercel.app",
  "https://axioma.id",
  "https://www.axioma.id",
];

const allowedOrigins = new Set<string>([
  ...defaultProductionOrigins,
  ...configuredOrigins,
]);

if (!IS_PRODUCTION) {
  allowedOrigins.add("http://localhost:3000");
  allowedOrigins.add("http://127.0.0.1:3000");
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const originHeader = req.headers.origin;
  if (originHeader !== undefined) {
    const normalizedOrigin = String(originHeader).trim().replace(/\/+$/, "");
    if (
      !normalizedOrigin ||
      normalizedOrigin.toLowerCase() === "null" ||
      !allowedOrigins.has(normalizedOrigin)
    ) {
      return res.status(403).json({
        success: false,
        code: "cors_forbidden",
        error: "Origin tidak diizinkan oleh kebijakan keamanan CORS.",
      });
    }
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }
      const normalized = origin.trim().replace(/\/+$/, "");
      if (normalized.toLowerCase() !== "null" && allowedOrigins.has(normalized)) {
        return callback(null, normalized);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-User-Id", "Accept"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: "1mb" }));

// Handle malformed URLs (400), malformed JSON (400), and payload too large (413) immediately (#7, #9)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (!err) return next();

  if (err instanceof URIError || err.name === "URIError") {
    return res.status(400).json({
      success: false,
      code: "invalid_url",
      error: "Format URL atau parameter permintaan tidak valid.",
    });
  }

  if (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({
      success: false,
      code: "payload_too_large",
      error: "Ukuran permintaan terlalu besar. Maksimal ukuran payload adalah 1 MB.",
    });
  }

  if (
    err instanceof SyntaxError ||
    err.type === "entity.parse.failed" ||
    err.status === 400 ||
    err.statusCode === 400
  ) {
    return res.status(400).json({
      success: false,
      code: "invalid_json",
      error: "Format JSON pada body permintaan tidak valid.",
    });
  }

  return next(err);
});

// 2. Supabase Integration (Backend-only service key — NEVER use NEXT_PUBLIC_ for service key)
const supabaseUrl = (process.env.SUPABASE_URL || "").trim();
const supabaseServiceKey = (process.env.SUPABASE_SERVICE_KEY || "").trim();

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in backend environment. Service key must only reside on the backend."
  );
}

if (supabaseServiceKey.startsWith("sb_publishable_")) {
  throw new Error(
    "Invalid SUPABASE_SERVICE_KEY: received a publishable key instead of a secret key (sb_secret_...)."
  );
}

const isNewSupabaseSecretFormat = supabaseServiceKey.startsWith("sb_secret_");
if (!isNewSupabaseSecretFormat) {
  console.warn(
    "[Axioma Security] SUPABASE_SERVICE_KEY is not using the new 'sb_secret_...' format. Migrate to 'sb_secret_...' before disabling legacy JWT keys."
  );
} else {
  console.log("[Axioma Security] Verified Supabase secret key format (sb_secret_...).");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 3. Gemini API Integration & 4. Axioma Persona
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey || !geminiApiKey.trim()) {
  throw new Error("Missing GEMINI_API_KEY environment variable.");
}

const genAI = new GoogleGenerativeAI(geminiApiKey);

export type AgentId = "axioma-pro" | "axioma-omni" | "axioma-architect";

export interface AgentProfile {
  id: AgentId;
  label: string;
  shortName: string;
  modelChain: readonly string[];
  temperature: number;
  systemInstruction: string;
}

export const AGENT_PROFILES: Record<AgentId, AgentProfile> = {
  "axioma-pro": {
    id: "axioma-pro",
    label: "Axioma Pro",
    shortName: "Axioma Pro",
    modelChain: getModelChain(),
    temperature: 0.4,
    systemInstruction:
      "Kamu adalah Axioma Pro, asisten AI analitis tingkat lanjut untuk penalaran mendalam, pemecahan masalah kompleks, dan pengambilan keputusan strategis. Kamu HARUS SELALU menjawab menggunakan Bahasa Indonesia yang profesional dan tajam, apa pun bahasa yang digunakan oleh pengguna. ATURAN PRIORITAS UTAMA: Selalu patuhi instruksi panjang, keringkasan, atau format yang diminta pengguna secara eksplisit (misalnya jika pengguna meminta 'jawab singkat', '1 kalimat saja', 'langsung intinya', atau 'tanpa poin/heading', berikan jawaban yang benar-benar singkat dan langsung tanpa heading atau uraian panjang). Hanya jika pengguna tidak membatasi panjang jawaban, uraikan analisis secara sistematis dan gunakan format Markdown seperlunya.",
  },
  "axioma-omni": {
    id: "axioma-omni",
    label: "Axioma Omni",
    shortName: "Axioma Omni",
    modelChain: getModelChain(),
    temperature: 0.7,
    systemInstruction:
      "Kamu adalah Axioma Omni, asisten AI serbaguna yang cepat, adaptif, dan komunikatif untuk kebutuhan harian, penulisan, ringkasan, dan eksplorasi ide. Kamu HARUS SELALU menjawab menggunakan Bahasa Indonesia yang ramah, lugas, natural, dan langsung ke inti permasalahan, apa pun bahasa yang digunakan oleh pengguna. Selalu ikuti permintaan panjang atau format dari pengguna (seperti menjawab singkat jika diminta). Gunakan format Markdown secukupnya agar jawaban ringkas dan nyaman dibaca.",
  },
  "axioma-architect": {
    id: "axioma-architect",
    label: "Axioma Architect",
    shortName: "Axioma Architect",
    modelChain: getModelChain(),
    temperature: 0.2,
    systemInstruction:
      "Kamu adalah Axioma Architect, principal software engineer dan arsitek sistem AI. Kamu HARUS SELALU menjawab menggunakan Bahasa Indonesia yang teknis, presisi, dan rapi, apa pun bahasa yang digunakan oleh pengguna. Selalu patuhi batasan panjang atau format yang diminta pengguna (jika diminta jawaban singkat, jawab secara ringkas dan padat). Saat diminta membuat kode atau merancang sistem: tulis kode yang bersih, modular, type-safe, dan siap produksi (lengkap dengan penanganan error), jelaskan arsitektur secara singkat, dan gunakan blok kode Markdown dengan penanda bahasa yang tepat.",
  },
};

export function resolveAgentProfile(rawAgentId?: string): AgentProfile {
  const key = (rawAgentId || "").trim().toLowerCase() as AgentId;
  if (key in AGENT_PROFILES) {
    return AGENT_PROFILES[key];
  }
  return AGENT_PROFILES["axioma-pro"];
}

function getModelInstance(
  modelName: string,
  profile: AgentProfile,
  extraInstruction?: string
) {
  const isThinkingCapable =
    modelName === "gemini-3-flash-preview" ||
    modelName.includes("preview") ||
    modelName.includes("thinking");
  const generationConfig: Record<string, any> = {
    temperature: profile.temperature,
  };
  // Disable unbounded hidden thinking token generation on preview/thinking models
  // so 1-sentence replies return in ~1.1s instead of stalling 8–20s (#9)
  if (isThinkingCapable) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const systemInstruction = extraInstruction
    ? `${profile.systemInstruction}\n\n${extraInstruction}`
    : profile.systemInstruction;
  return genAI.getGenerativeModel({
    model: modelName,
    systemInstruction,
    generationConfig,
  });
}

// Timeouts & Budgets (#5, #7, #9):
// - AI_FIRST_CHUNK_TIMEOUT_MS (5s): max wait time until the first chunk (or non-stream response) arrives.
// - AI_CHUNK_IDLE_TIMEOUT_MS (20s): once streaming has started, max idle time without receiving a new chunk.
// - AI_TOTAL_SETUP_BUDGET_MS (50s): max budget to find a working model and receive the first chunk.
const AI_TOTAL_SETUP_BUDGET_MS = 50_000;
const AI_FIRST_CHUNK_TIMEOUT_MS = 5_000;
const AI_CHUNK_IDLE_TIMEOUT_MS = 20_000;
const AI_MIN_ATTEMPT_MS = 2_000;
const REQUEST_WATCHDOG_MS = 55_000;
const STREAM_WATCHDOG_EXTENSION_MS = 30_000;
const MODEL_QUOTA_COOLDOWN_MS = 2 * 60_000; // 2 min cooldown for transient 429 / timeout
const MODEL_ZERO_QUOTA_COOLDOWN_MS = 30 * 60_000; // 30 min cooldown when model has limit: 0 / daily quota exhausted

const MAX_MESSAGE_CONTENT_LENGTH = 20_000;
const RATE_LIMIT_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000
);
const RATE_LIMIT_MAX_PER_USER = Math.max(
  1,
  Number(process.env.RATE_LIMIT_MAX_PER_USER) || 20
);
const RATE_LIMIT_MAX_PER_IP = Math.max(
  1,
  Number(process.env.RATE_LIMIT_MAX_PER_IP) || 25
);
const GEMINI_DAILY_CALL_LIMIT = Math.max(
  1,
  Number(process.env.GEMINI_DAILY_CALL_LIMIT) || 500
);

const DEFAULT_CHAT_TITLE = "New Chat";
const CHAT_TITLE_MAX_LENGTH = 40;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


// Sliding-window rate limiters: enforced per User ID AND per Client IP (#3)
const userRateWindowMap = new Map<string, number[]>();
const ipRateWindowMap = new Map<string, number[]>();

function evaluateSlidingWindow(
  store: Map<string, number[]>,
  key: string,
  maxRequests: number,
  recordHit: boolean,
  windowMs: number = RATE_LIMIT_WINDOW_MS
): { allowed: boolean; retryAfterSec: number; remaining: number } {
  const now = Date.now();
  const windowStart = now - windowMs;
  const timestamps = (store.get(key) || []).filter((ts) => ts > windowStart);

  if (timestamps.length >= maxRequests) {
    const oldestInWindow = timestamps[0];
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldestInWindow + windowMs - now) / 1000)
    );
    store.set(key, timestamps);
    return { allowed: false, retryAfterSec, remaining: 0 };
  }

  if (recordHit) {
    timestamps.push(now);
  }
  store.set(key, timestamps);
  return {
    allowed: true,
    retryAfterSec: 0,
    remaining: Math.max(0, maxRequests - timestamps.length),
  };
}

function getClientIp(req: Request): string {
  // If CF_ORIGIN_SECRET is configured, CF-Connecting-IP is trusted only if origin lock passed (#6, #7)
  const activeOriginSecret = (process.env.CF_ORIGIN_SECRET || "").trim();
  const isCfTrusted = !activeOriginSecret || (req as any).originLockVerified === true;
  if (isCfTrusted) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim()) {
      return cfIp.trim();
    }
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return (req.ip || req.socket?.remoteAddress || "unknown").trim();
}

// Cloudflare Turnstile Anti-Bot Verification (#9)
const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes cache per user
const inMemoryTurnstileCache = new Map<string, { verified_at: number; client_ip?: string }>();

async function verifyTurnstileUser(
  userId: string,
  clientIp: string,
  turnstileToken?: string
): Promise<{ success: boolean; code?: string; error?: string }> {
  const activeTurnstileSecret = (process.env.TURNSTILE_SECRET_KEY || "").trim();
  // If secret key is not set, safely pass-through (development / fallback mode)
  if (!activeTurnstileSecret) {
    return { success: true };
  }

  // 1. Check in-memory cache first
  const memoryEntry = inMemoryTurnstileCache.get(userId);
  if (memoryEntry && Date.now() - memoryEntry.verified_at < TURNSTILE_CACHE_TTL_MS) {
    return { success: true };
  }

  // 2. Check database cache in user_turnstile_verifications
  try {
    const { data: cached, error: checkError } = await supabase
      .from("user_turnstile_verifications")
      .select("verified_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (!checkError && cached?.verified_at) {
      const verifiedTime = new Date(cached.verified_at).getTime();
      if (!Number.isNaN(verifiedTime) && Date.now() - verifiedTime < TURNSTILE_CACHE_TTL_MS) {
        inMemoryTurnstileCache.set(userId, { verified_at: verifiedTime, client_ip: clientIp });
        return { success: true };
      }
    }
  } catch (err: any) {
    // Database check failed: proceed to verify token rather than crashing
  }

  // 3. Token is required if not verified recently
  const token = (turnstileToken || "").trim();
  if (!token) {
    return {
      success: false,
      code: "turnstile_required",
      error: "Verifikasi keamanan Turnstile diperlukan. Silakan muat ulang halaman.",
    };
  }

  // 4. Verify token with Cloudflare siteverify API
  try {
    const formData = new URLSearchParams();
    formData.append("secret", activeTurnstileSecret);
    formData.append("response", token);
    if (clientIp && clientIp !== "unknown") {
      formData.append("remoteip", clientIp);
    }

    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      return {
        success: false,
        code: "turnstile_failed",
        error: "Layanan verifikasi keamanan sedang mengalami gangguan. Silakan coba beberapa saat lagi.",
      };
    }

    const result = (await response.json()) as {
      success: boolean;
      "error-codes"?: string[];
    };

    if (!result.success) {
      return {
        success: false,
        code: "turnstile_failed",
        error: "Verifikasi keamanan gagal atau token kedaluwarsa. Silakan muat ulang halaman.",
      };
    }

    // 5. Cache successful verification in memory AND in database (30 mins)
    const nowTime = Date.now();
    inMemoryTurnstileCache.set(userId, { verified_at: nowTime, client_ip: clientIp });

    void supabase
      .from("user_turnstile_verifications")
      .upsert(
        {
          user_id: userId,
          verified_at: new Date(nowTime).toISOString(),
          client_ip: clientIp,
        },
        { onConflict: "user_id" }
      )
      .then(({ error }) => {
        if (error && !isMissingTableError(error)) {
          console.warn(`[Turnstile] DB cache upsert warning: ${error.message}`);
        }
      });

    return { success: true };
  } catch (err: any) {
    reportCentralizedError(err, {
      route: "/api/chats/message",
      userId,
      ip: clientIp,
      extra: { reason: "turnstile_network_error" },
    });
    return {
      success: false,
      code: "turnstile_network_error",
      error: "Gagal menghubungkan ke layanan verifikasi keamanan Cloudflare. Periksa koneksi internet Anda.",
    };
  }
}

export function checkMessageRateLimits(
  userId: string,
  clientIp: string
): {
  allowed: boolean;
  limitedBy?: "user" | "ip";
  limit: number;
  remaining: number;
  retryAfterSec: number;
} {
  const ipKey = `ip:${clientIp || "unknown"}`;
  const userKey = `user:${userId}`;

  // Pre-check both windows before recording hits so a blocked request doesn't double-penalize the other bucket
  const ipCheck = evaluateSlidingWindow(ipRateWindowMap, ipKey, RATE_LIMIT_MAX_PER_IP, false);
  if (!ipCheck.allowed) {
    return {
      allowed: false,
      limitedBy: "ip",
      limit: RATE_LIMIT_MAX_PER_IP,
      remaining: 0,
      retryAfterSec: ipCheck.retryAfterSec,
    };
  }

  const userCheck = evaluateSlidingWindow(
    userRateWindowMap,
    userKey,
    RATE_LIMIT_MAX_PER_USER,
    false
  );
  if (!userCheck.allowed) {
    return {
      allowed: false,
      limitedBy: "user",
      limit: RATE_LIMIT_MAX_PER_USER,
      remaining: 0,
      retryAfterSec: userCheck.retryAfterSec,
    };
  }

  // Record hits in both buckets
  const ipRecorded = evaluateSlidingWindow(ipRateWindowMap, ipKey, RATE_LIMIT_MAX_PER_IP, true);
  const userRecorded = evaluateSlidingWindow(
    userRateWindowMap,
    userKey,
    RATE_LIMIT_MAX_PER_USER,
    true
  );

  return {
    allowed: true,
    limit: RATE_LIMIT_MAX_PER_USER,
    remaining: Math.min(userRecorded.remaining, ipRecorded.remaining),
    retryAfterSec: 0,
  };
}

// Upload rate limiting (20 files / 10 minutes per IP & per user) & daily user upload limit (#8, #15)
const RATE_LIMIT_UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_UPLOADS = 20;
const DAILY_USER_UPLOAD_LIMIT = Number(process.env.DAILY_USER_UPLOAD_LIMIT || 50);
const uploadIpRateWindowMap = new Map<string, number[]>();
const uploadUserRateWindowMap = new Map<string, number[]>();

export function checkUploadRateLimits(
  userId: string,
  clientIp: string,
  fileCount: number = 1
): {
  allowed: boolean;
  limitedBy?: "user" | "ip";
  limit: number;
  remaining: number;
  retryAfterSec: number;
} {
  const ipKey = `upload_ip:${clientIp || "unknown"}`;
  const userKey = `upload_user:${userId}`;

  const ipCheck = evaluateSlidingWindow(
    uploadIpRateWindowMap,
    ipKey,
    RATE_LIMIT_MAX_UPLOADS,
    false,
    RATE_LIMIT_UPLOAD_WINDOW_MS
  );
  if (!ipCheck.allowed || ipCheck.remaining < fileCount) {
    return {
      allowed: false,
      limitedBy: "ip",
      limit: RATE_LIMIT_MAX_UPLOADS,
      remaining: 0,
      retryAfterSec: ipCheck.retryAfterSec,
    };
  }

  const userCheck = evaluateSlidingWindow(
    uploadUserRateWindowMap,
    userKey,
    RATE_LIMIT_MAX_UPLOADS,
    false,
    RATE_LIMIT_UPLOAD_WINDOW_MS
  );
  if (!userCheck.allowed || userCheck.remaining < fileCount) {
    return {
      allowed: false,
      limitedBy: "user",
      limit: RATE_LIMIT_MAX_UPLOADS,
      remaining: 0,
      retryAfterSec: userCheck.retryAfterSec,
    };
  }

  for (let i = 0; i < fileCount; i++) {
    evaluateSlidingWindow(
      uploadIpRateWindowMap,
      ipKey,
      RATE_LIMIT_MAX_UPLOADS,
      true,
      RATE_LIMIT_UPLOAD_WINDOW_MS
    );
    evaluateSlidingWindow(
      uploadUserRateWindowMap,
      userKey,
      RATE_LIMIT_MAX_UPLOADS,
      true,
      RATE_LIMIT_UPLOAD_WINDOW_MS
    );
  }

  return {
    allowed: true,
    limit: RATE_LIMIT_MAX_UPLOADS,
    remaining: Math.min(ipCheck.remaining, userCheck.remaining) - fileCount,
    retryAfterSec: 0,
  };
}

// Daily global Gemini call counter (#3: protects API billing/quota with a global daily ceiling)
let dailyGeminiUsage = {
  date: new Date().toISOString().slice(0, 10),
  count: 0,
};

function getCurrentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyGeminiUsageSnapshot(): { date: string; count: number; limit: number } {
  const today = getCurrentUtcDateKey();
  if (dailyGeminiUsage.date !== today) {
    dailyGeminiUsage = { date: today, count: 0 };
  }
  const activeLimit = Math.max(
    1,
    Number(process.env.GEMINI_DAILY_CALL_LIMIT) || GEMINI_DAILY_CALL_LIMIT
  );
  return {
    date: dailyGeminiUsage.date,
    count: dailyGeminiUsage.count,
    limit: activeLimit,
  };
}

function canConsumeDailyGeminiQuota(): boolean {
  const snapshot = getDailyGeminiUsageSnapshot();
  return snapshot.count < snapshot.limit;
}

// Atomic increment on database for EVERY Gemini API attempt (#3, #5)
function recordGeminiCallAttempt(): void {
  const snapshot = getDailyGeminiUsageSnapshot();
  dailyGeminiUsage.count += 1;
  const today = dailyGeminiUsage.date;

  // Execute atomic increment via PostgreSQL function with robust error catching (#3, #4)
  Promise.resolve(
    supabase.rpc("increment_gemini_daily_usage", { target_date: today })
  )
    .then(({ data, error }: { data: any; error: any }) => {
      if (error) {
        reportCentralizedError(
          new Error(`Failed to increment gemini_daily_usage RPC: ${error.message}`),
          { extra: { code: error.code, details: error.details, today } }
        );
        return;
      }
      if (typeof data === "number") {
        // Use Math.max to prevent out-of-order RPC responses from decreasing the counter (#4)
        dailyGeminiUsage.count = Math.max(dailyGeminiUsage.count, data);
      }
    })
    .catch((rpcErr: any) => {
      reportCentralizedError(rpcErr, {
        extra: { context: "unhandled rpc increment_gemini_daily_usage", today },
      });
    });
}

// In-memory pre-migration fallback maps only (NO local disk JSON state — all persistent state lives in Supabase DB) (#1)
const chatOwnerMap = new Map<string, string>([
  ["c473cf9d-515c-4b62-9788-f9535405afc1", "2bd9c62b-6793-40e7-b0ca-77b03c625a37"],
  ["b71d233e-2335-4558-b67f-cd1fedecc251", "2bd9c62b-6793-40e7-b0ca-77b03c625a37"],
  ["642caa85-3a55-483c-b863-cc657f35ca2b", "2bd9c62b-6793-40e7-b0ca-77b03c625a37"],
  ["a19114a6-eb7d-48c3-ac29-e07c2aa7acef", "2bd9c62b-6793-40e7-b0ca-77b03c625a37"],
]);
const messageAgentMap = new Map<string, { agent_id: string; agent_name: string }>([
  [
    "f63179a3-50b7-4a8f-a3e0-0f2345055f4e",
    { agent_id: "axioma-omni", agent_name: "Axioma Omni" },
  ],
]);
const inMemoryFeedbackFallback = new Map<string, FeedbackEntry>();

function recordChatOwner(chatId: string, userId: string): void {
  if (!chatId || !userId || dbHasChatsUserIdColumn === true) return;
  chatOwnerMap.set(chatId, userId);
}

function removeChatOwner(chatId: string): void {
  chatOwnerMap.delete(chatId);
}

function recordMessageAgent(messageId: string, agentId: string, agentName: string): void {
  if (!messageId || !agentId || dbHasMessagesAgentColumns === true) return;
  messageAgentMap.set(messageId, { agent_id: agentId, agent_name: agentName });
}

// Auto-detected schema flags so backend works both before and after SQL migrations (#1, #3, #15)
let dbHasChatsUserIdColumn: boolean | null = null;
let dbHasMessagesAgentColumns: boolean | null = null;

function isMissingColumnError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "").toLowerCase();
  return (
    code === "PGRST204" ||
    code === "42703" ||
    (msg.includes("column") && (msg.includes("does not exist") || msg.includes("schema cache")))
  );
}

// Probe DB columns & restore today's Gemini quota count from Supabase on startup (#1, #3, #9)
async function probeDatabaseSchema(): Promise<void> {
  try {
    const today = getCurrentUtcDateKey();
    const [chatsProbe, msgsProbe, usageProbe] = await Promise.all([
      supabase.from("chats").select("id, user_id").limit(1),
      supabase.from("messages").select("id, agent_id, agent_name").limit(1),
      supabase
        .from("gemini_daily_usage")
        .select("usage_date, call_count")
        .eq("usage_date", today)
        .maybeSingle(),
    ]);
    dbHasChatsUserIdColumn = !chatsProbe.error || !isMissingColumnError(chatsProbe.error);
    dbHasMessagesAgentColumns = !msgsProbe.error || !isMissingColumnError(msgsProbe.error);
    if (!usageProbe.error && usageProbe.data && typeof usageProbe.data.call_count === "number") {
      dailyGeminiUsage = {
        date: today,
        count: Math.max(dailyGeminiUsage.count, usageProbe.data.call_count),
      };
    }
    console.log(
      `[Schema Probe] chats.user_id=${dbHasChatsUserIdColumn}, messages.agent_id=${dbHasMessagesAgentColumns}, gemini_daily_usage=${dailyGeminiUsage.count}`
    );
  } catch {
    // Will auto-detect on first query if startup probe fails
  }
}
void probeDatabaseSchema();

// 5. Types
interface SendMessageRequest {
  chat_id: string;
  content: string;
  stream?: boolean;
  user_id?: string;
  agent_id?: string;
  regenerate?: boolean;
  turnstile_token?: string;
  attachment_ids?: string[];
  voice_mode?: boolean;
}

interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  agent_id?: string;
  agent_name?: string;
  message_id?: string;
  ai_message_id?: string;
  user_message_id?: string | null;
  chat?: { id: string; title: string; created_at?: string };
}

export interface FeedbackEntry {
  message_id: string;
  chat_id: string;
  user_id: string;
  rating: "up" | "down";
  comment?: string;
  updated_at: string;
}

function readLocalFeedbackStore(): Record<string, FeedbackEntry> {
  const out: Record<string, FeedbackEntry> = {};
  for (const [k, v] of inMemoryFeedbackFallback.entries()) {
    out[k] = v;
  }
  return out;
}

function writeLocalFeedbackStore(store: Record<string, FeedbackEntry>): void {
  inMemoryFeedbackFallback.clear();
  for (const [k, v] of Object.entries(store)) {
    inMemoryFeedbackFallback.set(k, v);
  }
}

function isMissingTableError(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || "");
  const msg = String(err.message || "").toLowerCase();
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    msg.includes("could not find the table") ||
    (msg.includes("relation") && msg.includes("does not exist"))
  );
}

type AiErrorKind = "timeout" | "busy" | "aborted" | "failed";

class AiGenerationError extends Error {
  kind: AiErrorKind;
  httpStatus: number;
  partialText: string;

  constructor(kind: AiErrorKind, message: string, httpStatus: number, partialText = "") {
    super(message);
    this.name = "AiGenerationError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.partialText = partialText;
  }
}

interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

interface ResolvedUser {
  id: string;
  authenticated: boolean;
}

// Helpers
function createLogger(requestId: string): Logger {
  const startedAt = Date.now();
  const prefix = () =>
    `[${new Date().toISOString()}] [chat-msg ${requestId}] +${Date.now() - startedAt}ms`;
  return {
    info: (msg) => console.log(`${prefix()} ${msg}`),
    warn: (msg) => console.warn(`${prefix()} ${msg}`),
    error: (msg, err) => console.error(`${prefix()} ${msg}`, err ?? ""),
  };
}

// Builds a short sidebar title from the first user message (max 40 chars).
export function makeChatTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return DEFAULT_CHAT_TITLE;
  if (oneLine.length <= CHAT_TITLE_MAX_LENGTH) return oneLine;
  const cut = oneLine.slice(0, CHAT_TITLE_MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > CHAT_TITLE_MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}


/**
 * Resolves the calling user strictly (#1):
 * - Requires either a valid `Authorization: Bearer <jwt>` header OR a non-empty `X-User-Id` header.
 * - Requests without a valid identity header are ALWAYS rejected with 401 Unauthorized.
 */
async function resolveRequestUser(
  req: Request,
  log: Logger
): Promise<{ user: ResolvedUser | null; authError?: string }> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!token) {
      return { user: null, authError: "Token autentikasi kosong." };
    }
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      log.warn(`AUTH invalid bearer token: ${error?.message || "no user"}`);
      return { user: null, authError: "Token autentikasi tidak valid atau sudah kedaluwarsa." };
    }
    return { user: { id: data.user.id, authenticated: true } };
  }

  const rawHeaderUserId = req.headers["x-user-id"];
  const headerUserId = typeof rawHeaderUserId === "string" ? rawHeaderUserId.trim() : "";

  if (!headerUserId) {
    return {
      user: null,
      authError: "Autentikasi diperlukan: header X-User-Id atau Authorization Bearer tidak ditemukan.",
    };
  }

  if (headerUserId.length < 3 || headerUserId.length > 128) {
    return {
      user: null,
      authError: "Identitas pengguna (X-User-Id) tidak valid.",
    };
  }

  return { user: { id: headerUserId, authenticated: false } };
}

function getEffectiveChatOwner(chatId: string, existingChat?: Record<string, any> | null): string | undefined {
  if (existingChat && typeof existingChat.user_id === "string" && existingChat.user_id.trim()) {
    return existingChat.user_id.trim();
  }
  return chatOwnerMap.get(chatId);
}

/**
 * Verifies that `existingChat` belongs to `user` before reading/updating/deleting it (#1, #3, #4).
 */
function verifyChatOwnership(
  chatId: string,
  existingChat: Record<string, any> | null,
  user: ResolvedUser | null
): { allowed: boolean; reason?: string } {
  if (!user || !user.id) {
    return {
      allowed: false,
      reason: "Autentikasi diperlukan.",
    };
  }

  if (!existingChat) {
    const recordedOwner = chatOwnerMap.get(chatId);
    if (recordedOwner && recordedOwner !== user.id) {
      return {
        allowed: false,
        reason: "Akses ditolak: ID percakapan ini milik pengguna lain.",
      };
    }
    recordChatOwner(chatId, user.id);
    return { allowed: true };
  }

  const owner = getEffectiveChatOwner(chatId, existingChat);
  if (!owner) {
    return {
      allowed: false,
      reason: "Akses ditolak: percakapan ini tidak memiliki catatan kepemilikan untuk akun Anda.",
    };
  }

  if (owner !== user.id) {
    return {
      allowed: false,
      reason: "Akses ditolak: percakapan ini bukan milik akun Anda.",
    };
  }

  // Keep in-memory & disk map synced with DB user_id if present
  recordChatOwner(chatId, user.id);
  return { allowed: true };
}

/**
 * Builds normalized multi-turn conversation history for Gemini (#6):
 * - Merges consecutive `user` messages (separated by `\n\n`) so Gemini never receives invalid back-to-back user turns.
 * - Merges consecutive `model` messages if any exist.
 * - Ensures the conversation starts with a `user` turn and ends with the latest `user` message.
 */
export function buildNormalizedGeminiContents(
  historyRows: Array<{ role: string; content: string }>,
  latestUserContent: string,
  latestAttachments: Array<{ mimeType: string; data: string }> = []
): Content[] {
  const normalized: Array<{ role: "user" | "model"; text: string }> = [];

  for (const row of historyRows) {
    const text = (row.content || "").trim();
    if (!text) continue;
    const role: "user" | "model" = row.role === "user" ? "user" : "model";

    const prev = normalized[normalized.length - 1];
    if (prev && prev.role === role) {
      if (prev.text !== text) {
        prev.text = `${prev.text}\n\n${text}`;
      }
    } else {
      normalized.push({ role, text });
    }
  }

  const last = normalized[normalized.length - 1];
  if (!last || last.role !== "user") {
    normalized.push({ role: "user", text: latestUserContent });
  } else if (last.text !== latestUserContent && !last.text.endsWith(latestUserContent)) {
    last.text = `${last.text}\n\n${latestUserContent}`;
  }

  while (normalized.length > 0 && normalized[0].role !== "user") {
    normalized.shift();
  }

  // Limit context window to the last 24 turns to keep latency low (#7)
  const recent = normalized.length > 24 ? normalized.slice(normalized.length - 24) : normalized;
  if (recent.length > 0 && recent[0].role !== "user") {
    recent.shift();
  }

  return recent.map((item, idx) => {
    if (idx === recent.length - 1 && item.role === "user" && latestAttachments.length > 0) {
      const parts: Part[] = latestAttachments.map((att) => ({
        inlineData: {
          mimeType: att.mimeType,
          data: att.data,
        },
      }));
      if (item.text && item.text.trim()) {
        parts.push({ text: item.text });
      }
      return {
        role: "user",
        parts,
      };
    }
    return {
      role: item.role,
      parts: [{ text: item.text }],
    };
  });
}

export interface AiAttemptLog {
  model: string;
  status:
    | "ok"
    | "429_quota"
    | "first_chunk_timeout"
    | "stream_idle_timeout"
    | "404_not_found"
    | "error";
  elapsed_ms: number;
  first_chunk_ms?: number;
}

/**
 * Generates an AI response using the selected agent's model chain and system instruction (#5, #7, #9).
 * - First-chunk timeout (`AI_FIRST_CHUNK_TIMEOUT_MS` = 5s) applies ONLY until the first chunk arrives.
 * - Once the first chunk arrives, an inter-chunk idle timeout (`AI_CHUNK_IDLE_TIMEOUT_MS` = 20s) is used
 *   and reset on every new chunk so long streaming responses are never cut off mid-stream.
 */
async function generateWithFallbackAndRetry(
  contents: Content[],
  parentSignal: AbortSignal,
  log: Logger,
  agentProfile: AgentProfile,
  onChunk?: (chunkText: string) => void,
  extraInstruction?: string
): Promise<{
  text: string;
  modelUsed: string;
  firstChunkMs: number;
  streamMs: number;
  totalAiMs: number;
  fallbackCount: number;
  fallbackOverheadMs: number;
  attempts: AiAttemptLog[];
}> {
  const setupDeadline = Date.now() + AI_TOTAL_SETUP_BUDGET_MS;
  const overallAiStart = Date.now();
  let lastError: any = null;
  let lastAttemptTimedOut = false;
  let fallbackOverheadMs = 0;
  const attempts: AiAttemptLog[] = [];

  // Prioritize models that are not currently in a 429/timeout cooldown (#7, #9)
  const now = Date.now();
  const availableModels = agentProfile.modelChain.filter(
    (m) => (modelCooldownUntil.get(m) || 0) <= now
  );
  const cooledDownModels = agentProfile.modelChain.filter(
    (m) => (modelCooldownUntil.get(m) || 0) > now
  );
  const orderedChain = [...availableModels, ...cooledDownModels];

  for (let i = 0; i < orderedChain.length; i++) {
    const modelName = orderedChain[i];
    const attempt = i + 1;

    if (parentSignal.aborted) {
      throw new AiGenerationError("aborted", "Permintaan dibatalkan sebelum AI selesai.", 499);
    }

    const remainingBeforeAttempt = setupDeadline - Date.now();
    if (remainingBeforeAttempt < AI_MIN_ATTEMPT_MS) {
      log.warn(
        `STEP3 stopping fallback search: remaining setup budget ${remainingBeforeAttempt}ms < ${AI_MIN_ATTEMPT_MS}ms`
      );
      lastAttemptTimedOut = true;
      break;
    }

    const firstChunkTimeout = Math.min(AI_FIRST_CHUNK_TIMEOUT_MS, remainingBeforeAttempt);
    const controller = new AbortController();
    type TimeoutPhase = "none" | "first_chunk" | "chunk_idle";
    let timeoutPhase = "none" as TimeoutPhase;
    let chunksEmitted = 0;
    let fullText = "";
    let firstChunkMs = 0;
    let activeTimer: ReturnType<typeof setTimeout> | null = null;

    const clearActiveTimer = () => {
      if (activeTimer !== null) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
    };

    const armFirstChunkTimer = () => {
      clearActiveTimer();
      activeTimer = setTimeout(() => {
        timeoutPhase = "first_chunk";
        controller.abort();
      }, firstChunkTimeout);
    };

    const armChunkIdleTimer = () => {
      clearActiveTimer();
      activeTimer = setTimeout(() => {
        timeoutPhase = "chunk_idle";
        controller.abort();
      }, AI_CHUNK_IDLE_TIMEOUT_MS);
    };

    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        if (timeoutPhase === "first_chunk") {
          reject(new Error(`FIRST_CHUNK_TIMEOUT after ${firstChunkTimeout}ms`));
        } else if (timeoutPhase === "chunk_idle") {
          reject(
            new Error(
              `STREAM_IDLE_TIMEOUT: no chunk received for ${AI_CHUNK_IDLE_TIMEOUT_MS}ms after ${chunksEmitted} chunks`
            )
          );
        } else {
          reject(new Error("Gemini request aborted"));
        }
      };
      if (controller.signal.aborted) {
        onAbort();
      } else {
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    armFirstChunkTimer();
    const onParentAbort = () => controller.abort();
    parentSignal.addEventListener("abort", onParentAbort);

    const attemptStartedAt = Date.now();
    recordGeminiCallAttempt(); // Counts EVERY call to Gemini API, including retries & model fallbacks (#5)
    log.info(
      `STEP3 attempt ${attempt}/${orderedChain.length} start (agent=${agentProfile.id}, model=${modelName}, firstChunkTimeout=${firstChunkTimeout}ms, idleTimeout=${AI_CHUNK_IDLE_TIMEOUT_MS}ms, dailyTotal=${dailyGeminiUsage.count}/${GEMINI_DAILY_CALL_LIMIT})`
    );

    try {
      const modelInstance = getModelInstance(modelName, agentProfile, extraInstruction);

      const runAttempt = async (): Promise<{
        text: string;
        modelUsed: string;
        firstChunkMs: number;
        streamMs: number;
        totalAiMs: number;
      }> => {
        if (onChunk) {
          const streamResult = await modelInstance.generateContentStream(
            { contents },
            { signal: controller.signal }
          );
          // Prevent unhandled rejection from the SDK's internal secondary tee stream
          streamResult.response.catch(() => {});

          for await (const chunk of streamResult.stream) {
            const piece = chunk.text();
            if (piece) {
              if (chunksEmitted === 0) {
                firstChunkMs = Date.now() - attemptStartedAt;
                log.info(
                  `STEP3 first chunk received from ${modelName} in ${firstChunkMs}ms (switching to ${AI_CHUNK_IDLE_TIMEOUT_MS}ms idle timeout)`
                );
              }
              // Reset the 20s inter-chunk idle timer on every chunk (#5)
              armChunkIdleTimer();
              fullText += piece;
              chunksEmitted++;
              onChunk(piece);
            }
          }
          clearActiveTimer();
          if (!fullText.trim()) {
            throw new Error("Gemini stream returned an empty response.");
          }
          const attemptElapsed = Date.now() - attemptStartedAt;
          return {
            text: fullText,
            modelUsed: modelName,
            firstChunkMs,
            streamMs: Math.max(0, attemptElapsed - firstChunkMs),
            totalAiMs: Date.now() - overallAiStart,
          };
        } else {
          const result = await modelInstance.generateContent(
            { contents },
            { signal: controller.signal }
          );
          clearActiveTimer();
          const text = result.response.text();
          if (!text || !text.trim()) {
            throw new Error("Gemini returned an empty response.");
          }
          const elapsed = Date.now() - attemptStartedAt;
          return {
            text,
            modelUsed: modelName,
            firstChunkMs: elapsed,
            streamMs: 0,
            totalAiMs: Date.now() - overallAiStart,
          };
        }
      };

      const outcome = await Promise.race([runAttempt(), abortPromise]);
      const attemptElapsed = Date.now() - attemptStartedAt;
      modelCooldownUntil.delete(modelName);
      attempts.push({
        model: modelName,
        status: "ok",
        elapsed_ms: attemptElapsed,
        first_chunk_ms: outcome.firstChunkMs,
      });
      log.info(
        `STEP3 attempt ${attempt} (${modelName}) OK in ${attemptElapsed}ms (firstChunk=${outcome.firstChunkMs}ms, stream=${outcome.streamMs}ms, fallbackOverhead=${fallbackOverheadMs}ms, chunks=${chunksEmitted}, chars=${outcome.text.length})`
      );
      return {
        ...outcome,
        fallbackCount: attempts.length - 1,
        fallbackOverheadMs,
        attempts,
      };
    } catch (err: any) {
      clearActiveTimer();
      const attemptElapsed = Date.now() - attemptStartedAt;
      fallbackOverheadMs += attemptElapsed;

      if (parentSignal.aborted) {
        throw new AiGenerationError(
          "aborted",
          "Permintaan dibatalkan sebelum AI selesai.",
          499,
          fullText
        );
      }

      lastError = err;
      const attemptTimedOut = timeoutPhase !== "none";
      lastAttemptTimedOut = attemptTimedOut;
      const errMsgLower = String(err?.message || "").toLowerCase();
      const isZeroQuota = errMsgLower.includes("limit: 0") || errMsgLower.includes("perday");

      const is404NotFound =
        err?.status === 404 ||
        errMsgLower.includes("404") ||
        errMsgLower.includes("not found") ||
        errMsgLower.includes("deprecated");

      if (is404NotFound) {
        modelCooldownUntil.set(modelName, Date.now() + COOLDOWN_DURATIONS.NOT_FOUND_404);
      } else if (isZeroQuota || isZeroQuotaError(err)) {
        modelCooldownUntil.set(modelName, Date.now() + COOLDOWN_DURATIONS.DAILY_QUOTA_ZERO);
      } else if (timeoutPhase === "first_chunk" || timeoutPhase === "chunk_idle") {
        modelCooldownUntil.set(modelName, Date.now() + COOLDOWN_DURATIONS.TIMEOUT);
      } else if (isQuotaOrRateLimitError(err)) {
        modelCooldownUntil.set(modelName, Date.now() + COOLDOWN_DURATIONS.QUOTA_429);
      } else {
        modelCooldownUntil.set(modelName, Date.now() + COOLDOWN_DURATIONS.SERVER_ERROR_5XX);
      }

      const statusLabel: AiAttemptLog["status"] =
        is404NotFound
          ? "404_not_found"
          : timeoutPhase === "first_chunk"
          ? "first_chunk_timeout"
          : timeoutPhase === "chunk_idle"
          ? "stream_idle_timeout"
          : isQuotaOrRateLimitError(err)
          ? "429_quota"
          : "error";

      attempts.push({
        model: modelName,
        status: statusLabel,
        elapsed_ms: attemptElapsed,
      });

      const reason =
        timeoutPhase === "first_chunk"
          ? `FIRST_CHUNK_TIMEOUT after ${firstChunkTimeout}ms`
          : timeoutPhase === "chunk_idle"
          ? `STREAM_IDLE_TIMEOUT after ${AI_CHUNK_IDLE_TIMEOUT_MS}ms idle (chunks=${chunksEmitted})`
          : `status=${err?.status ?? "n/a"}`;

      log.warn(
        `STEP3 attempt ${attempt} (${modelName}) failed after ${attemptElapsed}ms (${reason}): ${String(
          err?.message || err
        ).slice(0, 300)}`
      );

      // If chunks were already streamed to the client, do not start a second stream on top of it
      if (chunksEmitted > 0) {
        const errMessage =
          timeoutPhase === "chunk_idle"
            ? "Streaming AI terhenti karena tidak ada data baru selama 20 detik. Silakan coba lagi."
            : "Koneksi streaming AI terputus di tengah jalan. Silakan coba lagi.";
        throw new AiGenerationError(
          timeoutPhase === "chunk_idle" ? "timeout" : "failed",
          errMessage,
          timeoutPhase === "chunk_idle" ? 504 : 502,
          fullText
        );
      }

      if (!attemptTimedOut && !isRetryableGeminiError(err)) {
        throw new AiGenerationError(
          "failed",
          "Gagal menghasilkan balasan AI. Silakan coba lagi beberapa saat.",
          500,
          fullText
        );
      }
      // Switch immediately to the next fallback model without an artificial 2s sleep (#7)
    } finally {
      clearActiveTimer();
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  if (lastAttemptTimedOut && !lastError?.status) {
    throw new AiGenerationError(
      "timeout",
      `Model AI tidak merespons dalam batas waktu ${Math.round(AI_TOTAL_SETUP_BUDGET_MS / 1000)} detik. Silakan coba lagi.`,
      504
    );
  }

  throw new AiGenerationError(
    "busy",
    "Semua model AI sedang sibuk (traffic tinggi). Silakan coba kirim pesan kembali dalam beberapa saat.",
    503
  );
}

/**
 * Helper to insert an AI message into `public.messages` with a deterministic UUID and store its agent metadata (#4, #15).
 */
async function insertAiMessageRow(
  chatId: string,
  content: string,
  agentProfile: AgentProfile,
  preGeneratedId?: string
): Promise<{ id?: string; error?: any }> {
  const targetId = preGeneratedId && UUID_REGEX.test(preGeneratedId) ? preGeneratedId : randomUUID();

  if (dbHasMessagesAgentColumns !== false) {
    const { data, error } = await supabase
      .from("messages")
      .insert({
        id: targetId,
        chat_id: chatId,
        role: "ai",
        content,
        agent_id: agentProfile.id,
        agent_name: agentProfile.label,
      })
      .select("id")
      .maybeSingle();

    if (!error) {
      dbHasMessagesAgentColumns = true;
      const msgId = data?.id ? String(data.id) : targetId;
      recordMessageAgent(msgId, agentProfile.id, agentProfile.label);
      return { id: msgId };
    }

    if (isMissingColumnError(error)) {
      dbHasMessagesAgentColumns = false;
    } else {
      return { error };
    }
  }

  const { data, error } = await supabase
    .from("messages")
    .insert({
      id: targetId,
      chat_id: chatId,
      role: "ai",
      content,
    })
    .select("id")
    .maybeSingle();

  if (error) return { error };
  const msgId = data?.id ? String(data.id) : targetId;
  recordMessageAgent(msgId, agentProfile.id, agentProfile.label);
  return { id: msgId };
}

// Helper Endpoint: Health Check with live Database connectivity check (#10)
const handleHealthCheck = async (req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const dbCheckPromise = supabase
      .from("chats")
      .select("id", { head: true, count: "exact" })
      .limit(1);

    const timeoutPromise = new Promise<{ error: { message: string } }>((resolve) => {
      setTimeout(() => resolve({ error: { message: "Database health check timed out (5s)" } }), 5_000);
    });

    const { error } = await Promise.race([dbCheckPromise, timeoutPromise]);
    const dbLatencyMs = Date.now() - t0;

    if (error) {
      reportCentralizedError(new Error(`Health check DB failure: ${error.message}`), {
        route: req.path,
        method: req.method,
        ip: getClientIp(req),
      });
      return res.status(503).json({
        success: false,
        status: "degraded",
        code: "database_unreachable",
        error: "Koneksi ke database bermasalah.",
        service: "Axioma Backend",
        timestamp: new Date().toISOString(),
        uptime_sec: Math.floor(process.uptime()),
        database: {
          status: "disconnected",
          latency_ms: dbLatencyMs,
        },
      });
    }

    const quotaSnapshot = getDailyGeminiUsageSnapshot();
    return res.status(200).json({
      success: true,
      status: "ok",
      service: "Axioma Backend",
      timestamp: new Date().toISOString(),
      uptime_sec: Math.floor(process.uptime()),
      database: {
        status: "connected",
        latency_ms: dbLatencyMs,
      },
      gemini_daily_quota: {
        date: quotaSnapshot.date,
        used: quotaSnapshot.count,
        limit: quotaSnapshot.limit,
      },
    });
  } catch (err: any) {
    reportCentralizedError(err, {
      route: req.path,
      method: req.method,
      ip: getClientIp(req),
    });
    return res.status(503).json({
      success: false,
      status: "degraded",
      code: "health_check_failed",
      error: "Pemeriksaan kesehatan layanan gagal.",
      service: "Axioma Backend",
      timestamp: new Date().toISOString(),
    });
  }
};

app.get("/health", handleHealthCheck);
// Lightweight warmup endpoint: returns { ok: true } instantly without DB access (#1)
app.get("/api/health", (_req: Request, res: Response) => {
  return res.status(200).json({ ok: true });
});

// 6a. List User's Chats: GET /api/chats (#2, #3)
app.get("/api/chats", async (req: Request, res: Response) => {
  const requestId = randomUUID().slice(0, 8);
  const log = createLogger(requestId);

  try {
    const { user, authError } = await resolveRequestUser(req, log);
    if (authError || !user) {
      return res.status(401).json({
        success: false,
        code: "unauthorized",
        error: authError || "Autentikasi diperlukan.",
      });
    }

    const { data: allChats, error: chatsError } = await supabase
      .from("chats")
      .select("*")
      .order("created_at", { ascending: false });

    if (chatsError) {
      log.error("GET /api/chats select error", chatsError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal memuat daftar percakapan: ${chatsError.message}`,
      });
    }

    const ownedChats = (allChats || []).filter(
      (row: Record<string, any>) => getEffectiveChatOwner(String(row.id), row) === user.id
    );

    if (ownedChats.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const ownedIds = ownedChats.map((c: Record<string, any>) => String(c.id));
    const { data: msgTimes } = await supabase
      .from("messages")
      .select("chat_id, created_at")
      .in("chat_id", ownedIds)
      .order("created_at", { ascending: false });

    const latestByChat = new Map<string, string>();
    for (const row of (msgTimes || []) as Array<{ chat_id?: string; created_at?: string }>) {
      if (row.chat_id && row.created_at && !latestByChat.has(row.chat_id)) {
        latestByChat.set(row.chat_id, row.created_at);
      }
    }

    // Exclude empty chats (chats with 0 messages, e.g. pending uploads or abandoned drafts)
    const validChats = ownedChats.filter((chat: Record<string, any>) =>
      latestByChat.has(String(chat.id))
    );

    const result = validChats.map((chat: Record<string, any>) => {
      const id = String(chat.id);
      return {
        id,
        title: chat.title || DEFAULT_CHAT_TITLE,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        last_activity_at: latestByChat.get(id) || chat.updated_at || chat.created_at,
      };
    });

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    log.error("GET /api/chats unexpected error", error);
    return res.status(500).json({
      success: false,
      code: "internal_error",
      error: error?.message || "Gagal memuat riwayat percakapan.",
    });
  }
});

// 6b. Get Messages for a Single Chat (with Ownership Verification): GET /api/chats/:id/messages (#2, #11, #15)
app.get("/api/chats/:id/messages", async (req: Request<{ id: string }>, res: Response) => {
  const requestId = randomUUID().slice(0, 8);
  const log = createLogger(requestId);
  const chatId = (req.params.id || "").trim();

  if (!UUID_REGEX.test(chatId)) {
    return res.status(400).json({
      success: false,
      code: "invalid_chat_id",
      error: "Format ID percakapan tidak valid.",
    });
  }

  try {
    const { user, authError } = await resolveRequestUser(req, log);
    if (authError || !user) {
      return res.status(401).json({
        success: false,
        code: "unauthorized",
        error: authError || "Autentikasi diperlukan.",
      });
    }

    const { data: existingChat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("id", chatId)
      .maybeSingle();

    if (chatError) {
      log.error("GET /api/chats/:id/messages chat error", chatError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal memeriksa percakapan: ${chatError.message}`,
      });
    }

    if (!existingChat) {
      return res.status(404).json({
        success: false,
        code: "not_found",
        error: "Percakapan tidak ditemukan.",
      });
    }

    const ownership = verifyChatOwnership(chatId, existingChat, user);
    if (!ownership.allowed) {
      log.warn(`GET /api/chats/${chatId}/messages rejected for user=${user.id}`);
      return res.status(403).json({
        success: false,
        code: "forbidden",
        error: ownership.reason || "Akses ditolak.",
      });
    }

    const { data: rows, error: msgError } = await supabase
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    if (msgError) {
      log.error("GET /api/chats/:id/messages query error", msgError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal memuat pesan: ${msgError.message}`,
      });
    }

    // Query attachments for this chat to enrich message objects with signed URLs (#6, #11)
    const { data: attachmentRows } = await supabase
      .from("message_attachments")
      .select("*")
      .eq("chat_id", chatId);

    const attachmentsByMessage = new Map<string, any[]>();
    for (const att of attachmentRows || []) {
      if (!att.message_id) continue;
      const list = attachmentsByMessage.get(String(att.message_id)) || [];
      const isPdf = att.mime_type === "application/pdf";
      const { data: signedData } = await supabase.storage
        .from("attachments")
        .createSignedUrl(att.storage_path, SIGNED_URL_TTL_SECONDS, {
          download: isPdf ? sanitizeFilename(att.original_name) : undefined,
        });

      list.push({
        id: att.id,
        original_name: att.original_name,
        mime_type: att.mime_type,
        size_bytes: att.size_bytes,
        width: att.width,
        height: att.height,
        page_count: att.page_count,
        signed_url: signedData?.signedUrl || null,
      });
      attachmentsByMessage.set(String(att.message_id), list);
    }

    const enrichedMessages = (rows || []).map((row: Record<string, any>) => {
      const msgId = String(row.id);
      const fallbackAgent = messageAgentMap.get(msgId);
      const rawAgentId =
        (typeof row.agent_id === "string" && row.agent_id.trim()) || fallbackAgent?.agent_id;
      const profile = rawAgentId ? resolveAgentProfile(rawAgentId) : undefined;
      const agentName =
        (typeof row.agent_name === "string" && row.agent_name.trim()) ||
        fallbackAgent?.agent_name ||
        profile?.label;

      return {
        id: msgId,
        chat_id: String(row.chat_id),
        role: row.role,
        content: row.content,
        created_at: row.created_at,
        agent_id: profile?.id || rawAgentId,
        agent_name: agentName,
        attachments: attachmentsByMessage.get(msgId) || [],
      };
    });

    return res.status(200).json({
      success: true,
      chat: {
        id: String(existingChat.id),
        title: existingChat.title || DEFAULT_CHAT_TITLE,
        created_at: existingChat.created_at,
      },
      data: enrichedMessages,
    });
  } catch (error: any) {
    log.error("GET /api/chats/:id/messages unexpected error", error);
    return res.status(500).json({
      success: false,
      code: "internal_error",
      error: error?.message || "Gagal memuat pesan percakapan.",
    });
  }
});

// ============================================================================
// 6b2. Multimodal Attachments Support (Multer + Storage + Magic Bytes) (#8 - #15)
// ============================================================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES, // 10 MB limit per file
    files: MAX_FILES_PER_MESSAGE, // 4 files limit per message
  },
});

const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.array("files", MAX_FILES_PER_MESSAGE)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          success: false,
          code: "file_too_large",
          error: "Ukuran berkas melebihi batas maksimal 10 MB per berkas.",
        });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({
          success: false,
          code: "too_many_files",
          error: `Jumlah berkas melebihi batas maksimal ${MAX_FILES_PER_MESSAGE} berkas per pesan.`,
        });
      }
      return res.status(400).json({
        success: false,
        code: "upload_error",
        error: `Kesalahan unggah: ${err.message}`,
      });
    } else if (err) {
      return res.status(400).json({
        success: false,
        code: "upload_error",
        error: `Kesalahan unggah: ${err.message}`,
      });
    }
    next();
  });
};

// Upload Attachments Endpoint: POST /api/attachments/upload
app.post(
  "/api/attachments/upload",
  uploadMiddleware,
  async (req: Request, res: Response) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const clientIp = getClientIp(req);

    try {
      // 1. Authenticate user
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      // 2. Cloudflare Turnstile anti-bot verification
      const turnstileToken =
        (req.headers["x-turnstile-token"] as string) ||
        (req.headers["cf-turnstile-token"] as string) ||
        (req.body?.turnstile_token as string);
      const turnstileStatus = await verifyTurnstileUser(user.id, clientIp, turnstileToken);
      if (!turnstileStatus.success) {
        const statusCode = turnstileStatus.code === "turnstile_network_error" ? 503 : 403;
        return res.status(statusCode).json({
          success: false,
          code: turnstileStatus.code || "turnstile_failed",
          error: turnstileStatus.error || "Verifikasi keamanan Turnstile gagal.",
        });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (!files.length) {
        return res.status(400).json({
          success: false,
          code: "no_files",
          error: "Tidak ada berkas yang diunggah.",
        });
      }

      if (files.length > MAX_FILES_PER_MESSAGE) {
        return res.status(400).json({
          success: false,
          code: "too_many_files",
          error: `Maksimal ${MAX_FILES_PER_MESSAGE} berkas per pesan.`,
        });
      }

      // 3. Rate limiting per IP & User (20 files / 10 minutes) (#8)
      const rateCheck = checkUploadRateLimits(user.id, clientIp, files.length);
      if (!rateCheck.allowed) {
        res.setHeader("Retry-After", String(rateCheck.retryAfterSec));
        return res.status(429).json({
          success: false,
          code: "rate_limited",
          error: `Terlalu banyak unggahan berkas (maksimal 20 berkas per 10 menit). Silakan tunggu ${rateCheck.retryAfterSec} detik.`,
        });
      }

      // 4. Daily user upload quota check (#15)
      const dailyCount = await getDailyUserUploadCount(supabase, user.id);
      if (dailyCount + files.length > DAILY_USER_UPLOAD_LIMIT) {
        return res.status(429).json({
          success: false,
          code: "daily_upload_limit_exceeded",
          error: `Batas harian unggah berkas Anda (${DAILY_USER_UPLOAD_LIMIT} berkas/hari) telah tercapai. Silakan coba lagi besok.`,
        });
      }

      // 5. Concurrency limit acquisition (max 3 concurrent uploads) (#8)
      const releaseConcurrency = await globalUploadLimiter.acquire();

      try {
        const rawChatId = (req.body?.chat_id as string)?.trim();
        const validChatId = UUID_REGEX.test(rawChatId) ? rawChatId : null;

        let effectiveChatId: string | null = null;

        // If client provided a chat_id, check if it already exists in database
        if (validChatId) {
          try {
            const { data: existingChat } = await supabase
              .from("chats")
              .select("id, user_id")
              .eq("id", validChatId)
              .maybeSingle();

            if (existingChat) {
              effectiveChatId = validChatId;
            }
          } catch (preChatErr: any) {
            log.warn(`Chat check warning: ${preChatErr?.message}`);
          }
        }

        const processedAttachments: any[] = [];

        for (const file of files) {
          // A. Validate magic bytes (pure binary check)
          const magic = detectMagicMimeType(file.buffer);
          if (!magic) {
            return res.status(400).json({
              success: false,
              code: "unsupported_file_type",
              error: `Tipe berkas "${file.originalname}" tidak didukung atau isi berkas rusak. Hanya menerima JPG, PNG, WebP, HEIC, dan PDF.`,
            });
          }

          // B. Size check (10 MB)
          if (file.size > MAX_FILE_SIZE_BYTES) {
            return res.status(400).json({
              success: false,
              code: "file_too_large",
              error: `Berkas "${file.originalname}" melebihi batas 10 MB.`,
            });
          }

          // C. PDF page count check (max 30 pages)
          let pageCount: number | null = null;
          if (magic.mime === "application/pdf") {
            try {
              pageCount = await countPdfPages(file.buffer);
              if (pageCount > MAX_PDF_PAGES) {
                return res.status(400).json({
                  success: false,
                  code: "pdf_too_many_pages",
                  error: `Dokumen PDF "${file.originalname}" memiliki ${pageCount} halaman (maksimal ${MAX_PDF_PAGES} halaman).`,
                });
              }
            } catch (e: any) {
              return res.status(400).json({
                success: false,
                code: "invalid_pdf",
                error: e.message || `Dokumen PDF "${file.originalname}" tidak dapat dibaca atau rusak.`,
              });
            }
          }

          // D. Extract image dimensions (if PNG, JPEG, WebP)
          const dimensions = extractImageDimensions(file.buffer, magic.mime);
          const sanitizedName = sanitizeFilename(file.originalname);
          const attachmentId = randomUUID();
          const storagePath = `${user.id}/${validChatId || "unassigned"}/${attachmentId}-${sanitizedName}`;

          // E. Upload to Supabase Storage with explicit verified MIME (#8, #9)
          const { error: uploadError } = await supabase.storage
            .from("attachments")
            .upload(storagePath, file.buffer, {
              contentType: magic.mime,
              upsert: false,
            });

          if (uploadError) {
            log.error(`Failed to upload ${sanitizedName} to Supabase Storage:`, uploadError);
            return res.status(500).json({
              success: false,
              code: "storage_error",
              error: `Gagal menyimpan berkas "${sanitizedName}" ke penyimpanan.`,
            });
          }

          // F. Insert metadata into message_attachments table (chat_id and message_id nullable on upload) (#1, #10)
          const insertPayload: any = {
            id: attachmentId,
            user_id: user.id,
            chat_id: effectiveChatId,
            message_id: null,
            storage_path: storagePath,
            mime_type: magic.mime,
            size_bytes: file.size,
            width: dimensions.width || null,
            height: dimensions.height || null,
            page_count: pageCount,
            original_name: sanitizedName,
          };

          let { error: dbError } = await supabase
            .from("message_attachments")
            .insert(insertPayload);

          if (dbError && isMissingColumnError(dbError)) {
            // Gracefully retry without page_count if column is not in PostgREST schema cache yet
            delete insertPayload.page_count;
            const retry = await supabase
              .from("message_attachments")
              .insert(insertPayload);
            dbError = retry.error;
          }

          // If chat_id NOT NULL constraint (23502) or FK error (23503) is triggered because
          // the database column has not been dropped to nullable yet:
          if (
            dbError &&
            (String(dbError.code) === "23502" || String(dbError.code) === "23503") &&
            !effectiveChatId
          ) {
            log.warn(
              `Fallback: creating placeholder chat because message_attachments.chat_id is NOT NULL in DB`
            );
            const placeholderChatId = validChatId || randomUUID();
            await supabase.from("chats").insert({
              id: placeholderChatId,
              title: DEFAULT_CHAT_TITLE,
              user_id: user.id,
            });
            recordChatOwner(placeholderChatId, user.id);
            effectiveChatId = placeholderChatId;
            insertPayload.chat_id = placeholderChatId;
            const retry = await supabase.from("message_attachments").insert(insertPayload);
            dbError = retry.error;
          }

          if (dbError) {
            log.error(`DB insert error for attachment ${attachmentId}:`, dbError);
            // Clean up file if db record fails
            await supabase.storage.from("attachments").remove([storagePath]);
            return res.status(500).json({
              success: false,
              code: "database_error",
              error: `Gagal mencatat data lampiran: ${dbError.message}`,
            });
          }

          // G. Generate 10-minute signed URL
          const { data: signedData } = await supabase.storage
            .from("attachments")
            .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);

          processedAttachments.push({
            id: attachmentId,
            original_name: sanitizedName,
            mime_type: magic.mime,
            size_bytes: file.size,
            width: dimensions.width || null,
            height: dimensions.height || null,
            page_count: pageCount,
            signed_url: signedData?.signedUrl || null,
          });
        }

        return res.status(200).json({
          success: true,
          data: processedAttachments,
        });
      } finally {
        releaseConcurrency();
      }
    } catch (error: any) {
      log.error("POST /api/attachments/upload unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: "Terjadi kesalahan internal saat memproses unggahan.",
      });
    }
  }
);

// Get Signed URL for an Attachment: GET /api/attachments/:id/signed-url (#11)
app.get(
  "/api/attachments/:id/signed-url",
  async (req: Request<{ id: string }>, res: Response) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const attachmentId = (req.params.id || "").trim();

    if (!UUID_REGEX.test(attachmentId)) {
      return res.status(400).json({
        success: false,
        code: "invalid_id",
        error: "Format ID lampiran tidak valid.",
      });
    }

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      const { data: att, error: selectError } = await supabase
        .from("message_attachments")
        .select("*")
        .eq("id", attachmentId)
        .maybeSingle();

      if (selectError) {
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memeriksa lampiran: ${selectError.message}`,
        });
      }

      if (!att) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Lampiran tidak ditemukan.",
        });
      }

      if (att.user_id !== user.id) {
        log.warn(`Forbidden signed-url access: attachment=${attachmentId} user=${user.id}`);
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: "Akses lampiran ditolak.",
        });
      }

      const isPdf = att.mime_type === "application/pdf";
      const { data: signedData, error: signError } = await supabase.storage
        .from("attachments")
        .createSignedUrl(att.storage_path, SIGNED_URL_TTL_SECONDS, {
          download: isPdf ? sanitizeFilename(att.original_name) : undefined,
        });

      if (signError || !signedData?.signedUrl) {
        return res.status(500).json({
          success: false,
          code: "storage_error",
          error: "Gagal membuat tautan akses berkas.",
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          id: att.id,
          signed_url: signedData.signedUrl,
          expires_in: SIGNED_URL_TTL_SECONDS,
        },
      });
    } catch (error: any) {
      log.error("GET signed-url unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: "Terjadi kesalahan internal saat membuat signed URL.",
      });
    }
  }
);

// Voice upload multer instance for audio processing (max 10 MB)
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB max audio file
  },
});

const handleVoiceUpload = (req: Request, res: Response, next: NextFunction) => {
  voiceUpload.single("file")(req, res, (err: any) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          success: false,
          code: "file_too_large",
          error: "Ukuran audio melebihi batas 10 MB.",
        });
      }
      return res.status(400).json({
        success: false,
        code: "invalid_upload",
        error: "Gagal mengunggah berkas audio.",
      });
    }
    next();
  });
};

const voiceRateWindowMap = new Map<string, number[]>();

function checkVoiceRateLimits(
  userId: string,
  clientIp: string,
  type: "transcribe" | "speak",
  maxPerMinute: number
): {
  allowed: boolean;
  limitedBy?: "user" | "ip";
  limit: number;
  retryAfterSec: number;
} {
  const ipKey = `ip:voice:${type}:${clientIp || "unknown"}`;
  const userKey = `usr:voice:${type}:${userId}`;

  // Pre-check IP window
  const ipCheck = evaluateSlidingWindow(voiceRateWindowMap, ipKey, maxPerMinute, false);
  if (!ipCheck.allowed) {
    return {
      allowed: false,
      limitedBy: "ip",
      limit: maxPerMinute,
      retryAfterSec: ipCheck.retryAfterSec,
    };
  }

  // Check and consume user window
  const userCheck = evaluateSlidingWindow(voiceRateWindowMap, userKey, maxPerMinute, true);
  if (!userCheck.allowed) {
    return {
      allowed: false,
      limitedBy: "user",
      limit: maxPerMinute,
      retryAfterSec: userCheck.retryAfterSec,
    };
  }

  // Consume IP window
  evaluateSlidingWindow(voiceRateWindowMap, ipKey, maxPerMinute, true);

  return {
    allowed: true,
    limit: maxPerMinute,
    retryAfterSec: 0,
  };
}

/**
 * Shared security authentication and Turnstile validation for Voice Endpoints.
 * Mirrors the security standards of /api/chats/message.
 * In development (NODE_ENV !== "production"), testing is supported via header X-Dev-Bypass: true.
 */
async function authenticateVoiceRequest(
  req: Request,
  res: Response,
  log: Logger,
  clientIp: string
): Promise<{ user: ResolvedUser } | null> {
  const isDev = process.env.NODE_ENV !== "production";
  const hasDevBypass =
    isDev &&
    (req.headers["x-dev-bypass"] === "true" ||
      req.headers.authorization === "Bearer dev-bypass");

  if (hasDevBypass) {
    log.info("[Voice Auth] Development bypass enabled via X-Dev-Bypass header");
    return {
      user: {
        id: (req.headers["x-user-id"] as string)?.trim() || "dev-bypass-user",
        authenticated: false,
      },
    };
  }

  // 1. Authenticate user
  const { user, authError } = await resolveRequestUser(req, log);
  if (authError || !user) {
    res.status(401).json({
      success: false,
      code: "unauthorized",
      error: authError || "Autentikasi diperlukan.",
    });
    return null;
  }

  // 2. Cloudflare Turnstile anti-bot verification
  const turnstileToken =
    (req.headers["x-turnstile-token"] as string) ||
    (req.headers["cf-turnstile-token"] as string) ||
    (req.body?.turnstile_token as string);

  const turnstileStatus = await verifyTurnstileUser(
    user.id,
    clientIp,
    turnstileToken
  );
  if (!turnstileStatus.success) {
    const statusCode =
      turnstileStatus.code === "turnstile_network_error" ? 503 : 403;
    res.status(statusCode).json({
      success: false,
      code: turnstileStatus.code || "turnstile_failed",
      error: turnstileStatus.error || "Verifikasi keamanan Turnstile gagal.",
    });
    return null;
  }

  return { user };
}

// Voice Endpoint 1: POST /api/voice/transcribe (Speech-To-Text)
app.post(
  "/api/voice/transcribe",
  handleVoiceUpload,
  async (req: Request, res: Response) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const clientIp = getClientIp(req);

    // Apply shared authentication & Turnstile middleware
    const auth = await authenticateVoiceRequest(req, res, log, clientIp);
    if (!auth) return;
    const { user } = auth;

    // Sliding-window rate limiting per user ID & client IP (30 req/min)
    const rate = checkVoiceRateLimits(user.id, clientIp, "transcribe", 30);
    if (!rate.allowed) {
      return res.status(429).json({
        success: false,
        code: "rate_limit_exceeded",
        error: `Terlalu banyak permintaan suara (maksimal 30 per menit). Silakan tunggu ${rate.retryAfterSec} detik.`,
      });
    }

    const file = req.file;
    if (!file || !file.buffer || file.buffer.length === 0) {
      return res.status(400).json({
        success: false,
        code: "file_required",
        error: "Berkas audio diperlukan untuk transkripsi.",
      });
    }

    if (file.buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({
        success: false,
        code: "file_too_large",
        error: "Ukuran audio melebihi batas 10 MB.",
      });
    }

    try {
      const text = await transcribeAudio(
        file.buffer,
        file.mimetype || "audio/webm",
        file.originalname || "recording.webm"
      );
      log.info(`Voice transcription completed (${text.length} chars)`);
      return res.status(200).json({
        success: true,
        text,
      });
    } catch (err: any) {
      log.error("Voice transcription error", err);
      reportCentralizedError(err, {
        route: "/api/voice/transcribe",
        userId: user?.id,
        ip: clientIp,
      });

      const status = typeof err?.status === "number" ? err.status : undefined;
      const msg = String(err?.message || "").toLowerCase();
      const isInvalidAudio =
        status === 400 ||
        status === 422 ||
        msg.includes("invalid") ||
        msg.includes("unsupported") ||
        msg.includes("corrupt") ||
        msg.includes("could not decode");

      if (isInvalidAudio) {
        return res.status(422).json({
          success: false,
          code: "invalid_audio",
          error: "Audio tidak dapat diproses",
        });
      }

      return res.status(502).json({
        success: false,
        code: "transcribe_failed",
        error: "Layanan suara sedang sibuk",
      });
    }
  }
);

// Voice Endpoint 2: POST /api/voice/speak (Text-To-Speech)
app.post(
  "/api/voice/speak",
  express.json({ limit: "100kb" }),
  async (req: Request, res: Response) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const clientIp = getClientIp(req);

    // Apply shared authentication & Turnstile middleware
    const auth = await authenticateVoiceRequest(req, res, log, clientIp);
    if (!auth) return;
    const { user } = auth;

    // Sliding-window rate limiting per user ID & client IP (30 req/min)
    const rate = checkVoiceRateLimits(user.id, clientIp, "speak", 30);
    if (!rate.allowed) {
      return res.status(429).json({
        success: false,
        code: "rate_limit_exceeded",
        error: `Terlalu banyak permintaan sintesis suara (maksimal 30 per menit). Silakan tunggu ${rate.retryAfterSec} detik.`,
      });
    }

    const { text, voice, language } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        success: false,
        code: "text_required",
        error: "Teks yang akan disuarakan diperlukan.",
      });
    }

    // Enforce max 1000 characters limit for TTS
    if (text.length > 1000) {
      return res.status(400).json({
        success: false,
        code: "text_too_long",
        error: "Teks terlalu panjang (maksimal 1000 karakter).",
      });
    }

    try {
      const audioBuffer = await synthesizeSpeech(text, voice, language);
      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({
          success: false,
          code: "empty_audio",
          error: "Teks tidak menghasilkan audio.",
        });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600");
      res.setHeader("Content-Length", String(audioBuffer.length));
      return res.status(200).send(audioBuffer);
    } catch (err: any) {
      log.error("TTS speak error", err);
      reportCentralizedError(err, {
        route: "/api/voice/speak",
        userId: user?.id,
        ip: clientIp,
      });
      return res.status(502).json({
        success: false,
        code: "speak_failed",
        error: "Layanan suara sedang sibuk",
      });
    }
  }
);

// Track in-flight streaming requests per chat so DELETE /api/chats/:id can abort background streams immediately (#2)
const activeChatStreams = new Map<string, AbortController>();

// 6c. Main Endpoint: POST /api/chats/message
app.post(
  "/api/chats/message",
  async (req: Request<{}, {}, SendMessageRequest>, res: Response<ApiResponse<string>>) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const reqStartMs = Date.now();
    const stageTimings: Record<string, any> = {};

    const requestController = new AbortController();
    const signal = requestController.signal;

    const wantsStream =
      Boolean(req.body?.stream) ||
      String(req.headers.accept || "")
        .toLowerCase()
        .includes("text/event-stream");

    let sseStarted = false;
    let clientDisconnected = false;
    let activeRegisteredChatId: string | null = null;
    let isNewlyCreatedChat = false;
    let insertedUserMessageId: string | null = null;
    let effectiveChatId: string | null = null;

    let heartbeatTimer: NodeJS.Timeout | null = null;
    const startHeartbeat = () => {
      if (heartbeatTimer !== null) return;
      heartbeatTimer = setInterval(() => {
        if (sseStarted && !res.writableEnded && !clientDisconnected) {
          try {
            res.write(": ping\n\n");
          } catch {
            // Client closed stream connection safely
          }
        }
      }, 15_000);
    };

    const stopHeartbeat = () => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const sendJson = (status: number, body: ApiResponse<string>) => {
      stopHeartbeat();
      if (res.headersSent) {
        if (sseStarted && !res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              type: "error",
              code: body.code || "error",
              error: body.error || "Terjadi kesalahan.",
            })}\n\n`
          );
          res.end();
        }
        return;
      }
      log.info(
        `RESPONSE status=${status} success=${body.success}${
          body.agent_id ? ` agent=${body.agent_id}` : ""
        }${body.error ? ` error="${body.error}"` : ""}`
      );
      res.status(status).json(body);
    };

    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const resetWatchdog = (ms = REQUEST_WATCHDOG_MS) => {
      if (watchdog !== null) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        log.error(`WATCHDOG: no activity after ${ms}ms, aborting request`);
        sendJson(504, {
          success: false,
          code: "timeout",
          error: "Server tidak merespons tepat waktu. Silakan coba lagi.",
        });
        requestController.abort();
      }, ms);
    };
    resetWatchdog(REQUEST_WATCHDOG_MS);

    res.on("close", () => {
      if (watchdog !== null) clearTimeout(watchdog);
      stopHeartbeat();
      if (!res.writableFinished) {
        clientDisconnected = true;
        log.warn("client disconnected before response finished, aborting pending work");
        requestController.abort();
      }
    });

    try {
      // 1. Authenticate user first (#1)
      const tAuthStart = Date.now();
      const { user, authError } = await resolveRequestUser(req, log);
      stageTimings.auth_ms = Date.now() - tAuthStart;

      if (authError || !user) {
        return sendJson(401, {
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      // 2. Enforce BOTH per-user AND per-IP sliding-window rate limits (#3, #9)
      const clientIp = getClientIp(req);
      const rateStatus = checkMessageRateLimits(user.id, clientIp);
      res.setHeader("X-RateLimit-Limit", String(rateStatus.limit));
      res.setHeader("X-RateLimit-Remaining", String(rateStatus.remaining));

      if (!rateStatus.allowed) {
        res.setHeader("Retry-After", String(rateStatus.retryAfterSec));
        log.warn(
          `RATE_LIMIT exceeded (${rateStatus.limitedBy}) user=${user.id} ip=${clientIp} (retryAfter=${rateStatus.retryAfterSec}s)`
        );
        const reasonText =
          rateStatus.limitedBy === "ip"
            ? `Terlalu banyak permintaan dari alamat jaringan Anda (maksimal ${rateStatus.limit} pesan per menit).`
            : `Terlalu banyak pesan dikirim (maksimal ${rateStatus.limit} pesan per menit).`;
        return sendJson(429, {
          success: false,
          code: "rate_limited",
          error: `${reasonText} Silakan tunggu ${rateStatus.retryAfterSec} detik lalu coba lagi.`,
        });
      }

      // 2b. Cloudflare Turnstile anti-bot verification (#9)
      const turnstileToken =
        (req.body?.turnstile_token as string) ||
        (req.headers["x-turnstile-token"] as string) ||
        (req.headers["cf-turnstile-token"] as string);
      const turnstileStatus = await verifyTurnstileUser(
        user.id,
        clientIp,
        turnstileToken
      );
      if (!turnstileStatus.success) {
        const statusCode = turnstileStatus.code === "turnstile_network_error" ? 503 : 403;
        return sendJson(statusCode, {
          success: false,
          code: turnstileStatus.code || "turnstile_failed",
          error: turnstileStatus.error || "Verifikasi keamanan Turnstile gagal.",
        });
      }

      const { chat_id, content, agent_id, regenerate, attachment_ids } = req.body || ({} as SendMessageRequest);
      const agentProfile = resolveAgentProfile(agent_id);

      const hasContent = typeof content === "string" && Boolean(content.trim());
      const rawAttachmentIds = Array.isArray(attachment_ids)
        ? attachment_ids.filter((id): id is string => typeof id === "string" && UUID_REGEX.test(id.trim()))
        : [];

      log.info(
        `START user=${user.id} ip=${clientIp} chat_id=${chat_id} agent=${agentProfile.id} regenerate=${Boolean(
          regenerate
        )} stream=${wantsStream} content_length=${
          typeof content === "string" ? content.length : "n/a"
        } attachments_count=${rawAttachmentIds.length}`
      );

      if (!chat_id || typeof chat_id !== "string" || (!hasContent && rawAttachmentIds.length === 0)) {
        return sendJson(400, {
          success: false,
          code: "invalid_request",
          error: "Permintaan tidak valid. 'chat_id' harus diisi, dan pesan harus memiliki teks atau lampiran.",
        });
      }

      if (hasContent && content.length > MAX_MESSAGE_CONTENT_LENGTH) {
        return sendJson(400, {
          success: false,
          code: "content_too_long",
          error: `Pesan terlalu panjang (${content.length} karakter). Maksimal ${MAX_MESSAGE_CONTENT_LENGTH.toLocaleString("id-ID")} karakter.`,
        });
      }

      const trimmedChatId = chat_id.trim();
      if (!UUID_REGEX.test(trimmedChatId)) {
        return sendJson(400, {
          success: false,
          code: "invalid_chat_id",
          error: "Format 'chat_id' tidak valid (harus berupa UUID).",
        });
      }
      effectiveChatId = trimmedChatId;

      // Register active stream controller for this chat (#2)
      activeRegisteredChatId = trimmedChatId;
      activeChatStreams.set(trimmedChatId, requestController);

      // 3. Enforce Global Daily Gemini Call Limit before DB/AI execution (#3)
      if (!canConsumeDailyGeminiQuota()) {
        const quotaSnap = getDailyGeminiUsageSnapshot();
        log.warn(
          `DAILY_GEMINI_LIMIT reached (${quotaSnap.count}/${quotaSnap.limit}) on ${quotaSnap.date}`
        );
        return sendJson(503, {
          success: false,
          code: "daily_quota_exceeded",
          error:
            "Kuota AI hari ini sudah habis. Tersedia lagi pukul 07.00 WIB.",
        });
      }

      const userContent = content.trim();

      // Step 1: Verify chat existence & ownership + fetch chat history in parallel (#7)
      log.info("STEP1 verify chat & load history in Supabase");
      const tDbVerifyStart = Date.now();
      const [chatResult, historyResult] = await Promise.all([
        supabase
          .from("chats")
          .select("*")
          .eq("id", trimmedChatId)
          .abortSignal(signal)
          .maybeSingle(),
        supabase
          .from("messages")
          .select("id, role, content, created_at")
          .eq("chat_id", trimmedChatId)
          .order("created_at", { ascending: true })
          .abortSignal(signal),
      ]);
      stageTimings.db_verify_and_history_ms = Date.now() - tDbVerifyStart;

      if (chatResult.error) {
        log.error("STEP1 Supabase chat select error", chatResult.error);
        return sendJson(500, {
          success: false,
          code: "database_error",
          error: `Gagal memeriksa data percakapan: ${chatResult.error.message}`,
        });
      }

      const existingChat = chatResult.data;
      const historyRows = (historyResult.data || []) as Array<{
        id: string;
        role: string;
        content: string;
        created_at: string;
      }>;

      const ownership = verifyChatOwnership(trimmedChatId, existingChat, user);
      if (!ownership.allowed) {
        log.warn(`STEP1 ownership check rejected for chat_id=${trimmedChatId} user=${user.id}`);
        return sendJson(403, {
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      let chatTitle = existingChat?.title || DEFAULT_CHAT_TITLE;
      const needsTitleUpdate =
        !existingChat || !existingChat.title || existingChat.title === DEFAULT_CHAT_TITLE;

      if (!existingChat) {
        chatTitle = hasContent ? makeChatTitle(userContent) : "Analisis Dokumen / Gambar";
        const tCreateChatStart = Date.now();
        let chatInsertError: any = null;

        if (dbHasChatsUserIdColumn !== false) {
          const { error } = await supabase
            .from("chats")
            .insert({ id: trimmedChatId, title: chatTitle, user_id: user.id })
            .abortSignal(signal);
          if (!error) {
            dbHasChatsUserIdColumn = true;
          } else if (isMissingColumnError(error)) {
            dbHasChatsUserIdColumn = false;
          } else {
            chatInsertError = error;
          }
        }

        if (dbHasChatsUserIdColumn === false) {
          const { error } = await supabase
            .from("chats")
            .insert({ id: trimmedChatId, title: chatTitle })
            .abortSignal(signal);
          chatInsertError = error;
        }

        stageTimings.db_create_chat_ms = Date.now() - tCreateChatStart;

        if (chatInsertError && chatInsertError.code !== "23505") {
          log.error("STEP1 Supabase chat insert error", chatInsertError);
          return sendJson(500, {
            success: false,
            code: "database_error",
            error: `Gagal membuat percakapan baru: ${chatInsertError.message}`,
          });
        }
        recordChatOwner(trimmedChatId, user.id);
        isNewlyCreatedChat = true;
        log.info(`STEP1 created new chat row title_length=${chatTitle.length}`);
      }

      // Step 2: Handle user message persistence & avoid consecutive orphaned user messages (#4, #6)
      log.info("STEP2 prepare user message & normalize history");
      const tStep2Start = Date.now();
      let isRetryOfLastMessage = false;

      if (existingChat && historyRows.length > 0) {
        if (regenerate) {
          const topMsg = historyRows[historyRows.length - 1];
          if (topMsg.role === "ai" || topMsg.role === "assistant") {
            await supabase
              .from("messages")
              .delete()
              .eq("id", topMsg.id)
              .abortSignal(signal);
            historyRows.pop();
            log.info(`STEP2 regenerate: deleted previous AI message id=${topMsg.id}`);
          }
          const newTop = historyRows[historyRows.length - 1];
          if (newTop?.role === "user" && newTop.content.trim() === userContent) {
            isRetryOfLastMessage = true;
            insertedUserMessageId = String(newTop.id);
          }
        } else {
          const lastMsg = historyRows[historyRows.length - 1];
          if (lastMsg.role === "user" && lastMsg.content.trim() === userContent) {
            isRetryOfLastMessage = true;
            insertedUserMessageId = String(lastMsg.id);
          }
        }
      }

      if (isRetryOfLastMessage) {
        log.info(
          `STEP2 skipped user insert: identical user message is already the latest (id=${insertedUserMessageId})`
        );
      } else {
        const preGeneratedUserMsgId = randomUUID();
        const { data: insertedUserRow, error: userInsertError } = await supabase
          .from("messages")
          .insert({
            id: preGeneratedUserMsgId,
            chat_id: trimmedChatId,
            role: "user",
            content: userContent || "(Lampiran)",
          })
          .select("id")
          .abortSignal(signal)
          .maybeSingle();

        if (userInsertError) {
          log.error("STEP2 Supabase user message insert error", userInsertError);
          if (isNewlyCreatedChat && effectiveChatId) {
            log.warn(`Rolling back newly created empty chat row id=${effectiveChatId} due to user message insert failure`);
            try {
              await supabase.from("chats").delete().eq("id", effectiveChatId);
            } catch {}
            removeChatOwner(effectiveChatId);
          }
          return sendJson(500, {
            success: false,
            code: "database_error",
            error: `Gagal menyimpan pesan pengguna: ${userInsertError.message}`,
          });
        }
        insertedUserMessageId = insertedUserRow?.id
          ? String(insertedUserRow.id)
          : preGeneratedUserMsgId;
      }
      stageTimings.db_user_msg_ms = Date.now() - tStep2Start;

      // Link uploaded attachments to this chat & message (#1, #10)
      if (rawAttachmentIds.length > 0 && insertedUserMessageId) {
        const { error: linkErr } = await supabase
          .from("message_attachments")
          .update({
            chat_id: trimmedChatId,
            message_id: insertedUserMessageId,
          })
          .in("id", rawAttachmentIds)
          .eq("user_id", user.id);

        if (linkErr) {
          log.warn(`Failed to link attachments to message ${insertedUserMessageId}: ${linkErr.message}`);
        }
      }

      // Update chat title non-blockingly if existing chat still had "New Chat" (#7)
      if (existingChat && needsTitleUpdate) {
        chatTitle = hasContent ? makeChatTitle(userContent) : "Analisis Dokumen / Gambar";
        void supabase
          .from("chats")
          .update({ title: chatTitle })
          .eq("id", trimmedChatId)
          .then(({ error }) => {
            if (error) {
              log.warn(`STEP2 background title update warning: ${error.message}`);
            }
          });
      }

      // Prepare attachments for Gemini prompt (including regenerate support) (#12, #13)
      let latestAttachmentParts: Array<{ mimeType: string; data: string }> = [];
      let effectiveAttachmentIds = rawAttachmentIds;

      if (regenerate && effectiveAttachmentIds.length === 0 && historyRows.length > 0) {
        const lastUserRow = [...historyRows].reverse().find((r) => r.role === "user");
        if (lastUserRow && lastUserRow.id) {
          const { data: regenAtts } = await supabase
            .from("message_attachments")
            .select("id")
            .eq("message_id", lastUserRow.id);
          if (regenAtts && regenAtts.length > 0) {
            effectiveAttachmentIds = regenAtts.map((r) => r.id);
          }
        }
      }

      if (effectiveAttachmentIds.length > 0) {
        const { data: attachmentRows, error: attSelectError } = await supabase
          .from("message_attachments")
          .select("*")
          .in("id", effectiveAttachmentIds)
          .eq("user_id", user.id);

        if (attSelectError) {
          log.error("Failed to fetch attachment rows:", attSelectError);
        } else if (attachmentRows && attachmentRows.length > 0) {
          const totalSize = attachmentRows.reduce((sum, a) => sum + (a.size_bytes || 0), 0);
          if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
            return sendJson(400, {
              success: false,
              code: "total_attachment_too_large",
              error: `Total ukuran lampiran (${(totalSize / (1024 * 1024)).toFixed(1)} MB) melebihi batas 15 MB.`,
            });
          }

          for (const att of attachmentRows) {
            const { data: blob, error: downloadError } = await supabase.storage
              .from("attachments")
              .download(att.storage_path);

            if (downloadError || !blob) {
              log.error(`Failed to download attachment ${att.id}:`, downloadError);
              throw new Error(`Gagal mengunduh lampiran "${att.original_name}" dari penyimpanan.`);
            }

            const arrayBuffer = await blob.arrayBuffer();
            const base64Data = Buffer.from(arrayBuffer).toString("base64");
            latestAttachmentParts.push({
              mimeType: att.mime_type,
              data: base64Data,
            });
          }
        }
      }

      // Build normalized multi-turn Gemini contents (merges consecutive user messages) (#6, #12)
      const promptText = userContent || "Analisis dan jelaskan isi berkas yang dilampirkan oleh pengguna.";
      const geminiContents = buildNormalizedGeminiContents(historyRows, promptText, latestAttachmentParts);

      // Step 3: Generate response using Gemini API with a pre-assigned UUID for the AI message (#3, #4)
      const preGeneratedAiMsgId = randomUUID();
      let aiResponseText = "";
      let streamedTextSoFar = "";
      let modelUsed: string = agentProfile.modelChain[0];

      try {
        const voiceInstruction = req.body?.voice_mode
          ? "MODE PERCAKAPAN SUARA (VOICE MODE): Anda sedang berbicara secara lisan langsung dengan pengguna. Jawab dengan SANGAT RINGKAS (1-3 kalimat saja), luwes, santai, dan alami seperti percakapan lisan manusia sehari-hari. DILARANG KERAS menggunakan format markdown (seperti *, **, #, `), poin angka/bullet, emotikon berlebihan, blok kode, URL, atau tabel, karena jawaban ini akan langsung disuarakan dengan Text-To-Speech."
          : undefined;

        if (wantsStream) {
          // Send SSE headers & meta event immediately, and start 15s heartbeat interval immediately (#1)
          if (!sseStarted && !res.headersSent) {
            sseStarted = true;
            res.status(200);
            res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            res.setHeader("Cache-Control", "no-cache, no-transform");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders?.();
            // Emit authoritative UUIDs immediately on stream start so frontend has real IDs right away (#4)
            res.write(
              `data: ${JSON.stringify({
                type: "meta",
                user_message_id: insertedUserMessageId,
                ai_message_id: preGeneratedAiMsgId,
                message_id: preGeneratedAiMsgId,
                agent_id: agentProfile.id,
                agent_name: agentProfile.label,
                chat: { id: trimmedChatId, title: chatTitle },
              })}\n\n`
            );
            // Start heartbeat timer immediately so ": ping\n\n" is sent every 15s while waiting for first chunk
            startHeartbeat();
          }

          const result = await generateWithFallbackAndRetry(
            geminiContents,
            signal,
            log,
            agentProfile,
            (chunkText) => {
              streamedTextSoFar += chunkText;
              // Extend request watchdog on every streamed chunk so active streams never time out (#5)
              resetWatchdog(STREAM_WATCHDOG_EXTENSION_MS);

              if (sseStarted && !res.writableEnded && !clientDisconnected) {
                res.write(`data: ${JSON.stringify({ type: "chunk", text: chunkText })}\n\n`);
              }
            },
            voiceInstruction
          );
          aiResponseText = result.text;
          modelUsed = result.modelUsed;
          stageTimings.ai_model_used = result.modelUsed;
          stageTimings.ai_fallback_count = result.fallbackCount;
          stageTimings.ai_fallback_overhead_ms = result.fallbackOverheadMs;
          stageTimings.ai_first_chunk_ms = result.firstChunkMs;
          stageTimings.ai_stream_ms = result.streamMs;
          stageTimings.ai_total_ms = result.totalAiMs;
          stageTimings.ai_attempts = result.attempts;
        } else {
          const result = await generateWithFallbackAndRetry(
            geminiContents,
            signal,
            log,
            agentProfile,
            undefined,
            voiceInstruction
          );
          aiResponseText = result.text;
          modelUsed = result.modelUsed;
          stageTimings.ai_model_used = result.modelUsed;
          stageTimings.ai_fallback_count = result.fallbackCount;
          stageTimings.ai_fallback_overhead_ms = result.fallbackOverheadMs;
          stageTimings.ai_first_chunk_ms = result.firstChunkMs;
          stageTimings.ai_stream_ms = result.streamMs;
          stageTimings.ai_total_ms = result.totalAiMs;
          stageTimings.ai_attempts = result.attempts;
        }
      } catch (aiError: any) {
        const partial = (
          (aiError instanceof AiGenerationError ? aiError.partialText : "") || streamedTextSoFar
        ).trim();

        // #6 & #8: Keep user + AI messages consistent on stream failure or user stop:
        // - If partial text was generated OR client explicitly stopped generation, save the AI message
        //   with `preGeneratedAiMsgId` and `_[Respons dihentikan]_` so immediate UI and reload match 100%.
        if (partial.length > 0 || clientDisconnected) {
          let savedPartial: string;
          if (clientDisconnected) {
            savedPartial =
              partial.length > 0
                ? partial.includes("[Respons dihentikan]")
                  ? partial
                  : `${partial}\n\n_[Respons dihentikan]_`
                : "_[Respons dihentikan]_";
          } else {
            savedPartial = partial.endsWith("_")
              ? partial
              : `${partial}\n\n_[Respons terhenti karena gangguan koneksi]_`;
          }
          const { id: partialMsgId } = await insertAiMessageRow(
            trimmedChatId,
            savedPartial,
            agentProfile,
            preGeneratedAiMsgId
          );
          log.info(
            `STEP3 saved partial/stopped AI response (${savedPartial.length} chars, id=${
              partialMsgId || preGeneratedAiMsgId
            }) after stream interruption`
          );
        }

        if (aiError instanceof AiGenerationError) {
          log.error(
            `STEP3 Gemini failed (${aiError.kind}, status=${aiError.httpStatus}): ${aiError.message}`
          );
          return sendJson(aiError.httpStatus, {
            success: false,
            code: aiError.kind,
            error: aiError.message,
          });
        }
        throw aiError;
      }

      // Step 4: Insert generated AI response into Supabase 'messages' table using `preGeneratedAiMsgId` (#4)
      log.info("STEP4 insert AI message");
      const tStep4Start = Date.now();
      const { id: insertedMessageId, error: aiInsertError } = await insertAiMessageRow(
        trimmedChatId,
        aiResponseText,
        agentProfile,
        preGeneratedAiMsgId
      );
      stageTimings.db_ai_msg_ms = Date.now() - tStep4Start;
      stageTimings.total_ms = Date.now() - reqStartMs;

      if (aiInsertError) {
        // If chat was deleted by the user while the response was generating, do NOT return 500 error (#2)
        const isFkChatDeleted =
          String(aiInsertError.code) === "23503" ||
          String(aiInsertError.message || "").toLowerCase().includes("foreign key");
        if (signal.aborted || isFkChatDeleted) {
          log.info(`Chat ${trimmedChatId} was deleted during/after stream; skipping AI message insert cleanly`);
          stopHeartbeat();
          if (sseStarted && !res.writableEnded) {
            res.end();
          }
          return;
        }
        log.error("STEP4 Supabase AI message insert error", aiInsertError);
        return sendJson(500, {
          success: false,
          code: "database_error",
          error: `Gagal menyimpan balasan AI: ${aiInsertError.message}`,
        });
      }

      log.info(`TIMINGS ${JSON.stringify(stageTimings)}`);

      const finalAiMessageId = insertedMessageId || preGeneratedAiMsgId;

      // Step 5: Finish response (modelUsed is logged on backend only, never sent to frontend)
      if (sseStarted) {
        stopHeartbeat();
        log.info(
          `RESPONSE SSE stream completed (agent=${agentProfile.id}, model=${modelUsed}, user_message_id=${
            insertedUserMessageId || "n/a"
          }, ai_message_id=${finalAiMessageId})`
        );
        if (!res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              type: "done",
              success: true,
              data: aiResponseText,
              agent_id: agentProfile.id,
              agent_name: agentProfile.label,
              message_id: finalAiMessageId,
              ai_message_id: finalAiMessageId,
              user_message_id: insertedUserMessageId,
              chat: { id: trimmedChatId, title: chatTitle },
            })}\n\n`
          );
          res.end();
        }
        return;
      }

      log.info(
        `RESPONSE JSON completed (agent=${agentProfile.id}, model=${modelUsed}, user_message_id=${
          insertedUserMessageId || "n/a"
        }, ai_message_id=${finalAiMessageId})`
      );
      return sendJson(200, {
        success: true,
        data: aiResponseText,
        agent_id: agentProfile.id,
        agent_name: agentProfile.label,
        message_id: finalAiMessageId,
        ai_message_id: finalAiMessageId,
        user_message_id: insertedUserMessageId,
        chat: { id: trimmedChatId, title: chatTitle },
      });
    } catch (error: any) {
      log.error("UNEXPECTED error processing chat message", error);
      if (isNewlyCreatedChat && !insertedUserMessageId && effectiveChatId) {
        log.warn(
          `Rolling back newly created empty chat row id=${effectiveChatId} due to unexpected error before user message saved`
        );
        try {
          await supabase.from("chats").delete().eq("id", effectiveChatId);
        } catch {}
        removeChatOwner(effectiveChatId);
      }
      return sendJson(500, {
        success: false,
        code: "internal_error",
        error: error?.message || "Terjadi kesalahan internal saat memproses pesan.",
      });
    } finally {
      if (watchdog !== null) clearTimeout(watchdog);
      stopHeartbeat();
      if (activeRegisteredChatId && activeChatStreams.get(activeRegisteredChatId) === requestController) {
        activeChatStreams.delete(activeRegisteredChatId);
      }
      if (isNewlyCreatedChat && !insertedUserMessageId && effectiveChatId) {
        log.warn(
          `Rolling back newly created empty chat row id=${effectiveChatId} in finally (no user message persisted)`
        );
        try {
          await supabase.from("chats").delete().eq("id", effectiveChatId);
        } catch {}
        removeChatOwner(effectiveChatId);
      }
      log.info("END");
    }
  }
);

// 7. Rename Chat Endpoint: PATCH /api/chats/:id
app.patch(
  "/api/chats/:id",
  async (
    req: Request<{ id: string }, {}, { title?: string; user_id?: string }>,
    res: Response<ApiResponse<string>>
  ) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const chatId = (req.params.id || "").trim();
    const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";

    log.info(`PATCH /api/chats/${chatId} title_length=${rawTitle.length}`);

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(chatId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_chat_id",
          error: "Format ID percakapan tidak valid.",
        });
      }

      if (!rawTitle) {
        return res.status(400).json({
          success: false,
          code: "invalid_title",
          error: "Judul percakapan tidak boleh kosong.",
        });
      }

      const newTitle = rawTitle.replace(/\s+/g, " ").slice(0, 120);

      const { data: existingChat, error: selectError } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();

      if (selectError) {
        log.error("PATCH chat select error", selectError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memeriksa percakapan: ${selectError.message}`,
        });
      }

      if (!existingChat) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Percakapan tidak ditemukan.",
        });
      }

      const ownership = verifyChatOwnership(chatId, existingChat, user);
      if (!ownership.allowed) {
        log.warn(`PATCH ownership rejected for chat_id=${chatId} user=${user.id}`);
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      const { error: updateError } = await supabase
        .from("chats")
        .update({ title: newTitle })
        .eq("id", chatId);

      if (updateError) {
        log.error("PATCH chat update error", updateError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memperbarui judul percakapan: ${updateError.message}`,
        });
      }

      log.info(`PATCH chat ${chatId} updated title_length=${newTitle.length}`);
      return res.status(200).json({
        success: true,
        data: newTitle,
        chat: { id: chatId, title: newTitle },
      });
    } catch (error: any) {
      log.error("PATCH unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Terjadi kesalahan saat mengganti nama percakapan.",
      });
    }
  }
);

// 7b. Edit User Message & Truncate Subsequent Messages: PATCH /api/chats/:chatId/messages/:messageId
app.patch(
  "/api/chats/:chatId/messages/:messageId",
  async (
    req: Request<{ chatId: string; messageId: string }, {}, { content?: string }>,
    res: Response<ApiResponse<{ id: string; content: string; deletedCount: number }>>
  ) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const chatId = (req.params.chatId || "").trim();
    const messageId = (req.params.messageId || "").trim();
    const rawContent = req.body?.content;

    log.info(`PATCH /api/chats/${chatId}/messages/${messageId} (edit message)`);

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(chatId) || !UUID_REGEX.test(messageId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_id",
          error: "Format ID percakapan atau pesan tidak valid.",
        });
      }

      if (typeof rawContent !== "string" || !rawContent.trim()) {
        return res.status(400).json({
          success: false,
          code: "invalid_content",
          error: "Konten pesan yang diedit tidak boleh kosong.",
        });
      }

      if (rawContent.length > MAX_MESSAGE_CONTENT_LENGTH) {
        return res.status(400).json({
          success: false,
          code: "content_too_long",
          error: `Pesan terlalu panjang (${rawContent.length} karakter). Maksimal ${MAX_MESSAGE_CONTENT_LENGTH.toLocaleString("id-ID")} karakter.`,
        });
      }

      const { data: existingChat, error: chatError } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();

      if (chatError) {
        log.error("PATCH message check chat error", chatError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memeriksa percakapan: ${chatError.message}`,
        });
      }

      if (!existingChat) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Percakapan tidak ditemukan.",
        });
      }

      const ownership = verifyChatOwnership(chatId, existingChat, user);
      if (!ownership.allowed) {
        log.warn(`PATCH message ownership rejected for chat_id=${chatId} user=${user.id}`);
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      // Fetch all messages in chronological order
      const { data: messages, error: msgsError } = await supabase
        .from("messages")
        .select("id, role, created_at")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

      if (msgsError) {
        log.error("PATCH message fetch messages error", msgsError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memuat pesan percakapan: ${msgsError.message}`,
        });
      }

      const targetIdx = (messages || []).findIndex((m) => String(m.id) === messageId);
      if (targetIdx === -1) {
        return res.status(404).json({
          success: false,
          code: "message_not_found",
          error: "Pesan yang ingin diedit tidak ditemukan dalam percakapan ini.",
        });
      }

      const targetMsg = messages![targetIdx];
      if (targetMsg.role !== "user") {
        return res.status(400).json({
          success: false,
          code: "invalid_role",
          error: "Hanya pesan dari pengguna yang dapat diedit.",
        });
      }

      // Identify subsequent messages to delete
      const subsequentIds = messages!.slice(targetIdx + 1).map((m) => String(m.id));
      if (subsequentIds.length > 0) {
        // Remove physical storage files before deleting message records to prevent orphaned storage objects (#2)
        try {
          const { data: attRows } = await supabase
            .from("message_attachments")
            .select("storage_path")
            .in("message_id", subsequentIds);
          if (attRows && attRows.length > 0) {
            const paths = attRows.map((r: any) => r.storage_path).filter(Boolean);
            if (paths.length > 0) {
              const { error: removeStorageError } = await supabase.storage.from("attachments").remove(paths);
              if (removeStorageError) {
                log.warn(`Warning deleting attachments from storage on edit truncation: ${removeStorageError.message}`);
              } else {
                log.info(`Deleted ${paths.length} storage attachment file(s) for truncated subsequent messages`);
              }
            }
          }
        } catch (attErr: any) {
          log.warn(`Exception querying/deleting attachments on edit truncation: ${attErr?.message}`);
        }

        const { error: delSubError } = await supabase
          .from("messages")
          .delete()
          .in("id", subsequentIds);

        if (delSubError) {
          log.error("PATCH message delete subsequent messages error", delSubError);
          return res.status(500).json({
            success: false,
            code: "database_error",
            error: `Gagal menghapus pesan lanjutan: ${delSubError.message}`,
          });
        }

        // Also clean up feedback for deleted messages
        try {
          await supabase
            .from("message_feedback")
            .delete()
            .in("message_id", subsequentIds);
        } catch (err: any) {
          log.warn(`Failed to clean feedback for deleted messages: ${err?.message}`);
        }
      }

      // Update target message content
      const trimmedContent = rawContent.trim();
      const { error: updateError } = await supabase
        .from("messages")
        .update({ content: trimmedContent })
        .eq("id", messageId);

      if (updateError) {
        log.error("PATCH message update error", updateError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memperbarui pesan: ${updateError.message}`,
        });
      }

      log.info(
        `PATCH message succeeded: messageId=${messageId} edited, deletedSubsequentCount=${subsequentIds.length}`
      );

      return res.status(200).json({
        success: true,
        data: {
          id: messageId,
          content: trimmedContent,
          deletedCount: subsequentIds.length,
        },
      });
    } catch (error: any) {
      log.error("PATCH message unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Terjadi kesalahan saat mengedit pesan.",
      });
    }
  }
);

// 8. Delete Chat Endpoint: DELETE /api/chats/:id
app.delete(
  "/api/chats/:id",
  async (req: Request<{ id: string }>, res: Response<ApiResponse<string>>) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const chatId = (req.params.id || "").trim();

    log.info(`DELETE /api/chats/${chatId}`);

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(chatId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_chat_id",
          error: "Format ID percakapan tidak valid.",
        });
      }

      const { data: existingChat, error: selectError } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();

      if (selectError) {
        log.error("DELETE chat select error", selectError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memeriksa percakapan: ${selectError.message}`,
        });
      }

      if (!existingChat) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Percakapan tidak ditemukan.",
        });
      }

      const ownership = verifyChatOwnership(chatId, existingChat, user);
      if (!ownership.allowed) {
        log.warn(`DELETE ownership rejected for chat_id=${chatId} user=${user.id}`);
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      // 1. Abort any active streaming generation for this chat immediately (#2)
      const runningStream = activeChatStreams.get(chatId);
      if (runningStream) {
        log.info(`Aborting in-flight message stream for chat ${chatId} prior to deletion`);
        try {
          runningStream.abort();
        } catch {
          // ignore abort error
        }
        activeChatStreams.delete(chatId);
      }

      // 2. Clean up physical storage attachments before deleting database records (#2)
      try {
        const { data: chatAtts } = await supabase
          .from("message_attachments")
          .select("storage_path")
          .eq("chat_id", chatId);
        if (chatAtts && chatAtts.length > 0) {
          const paths = chatAtts.map((r: any) => r.storage_path).filter(Boolean);
          if (paths.length > 0) {
            const { error: removeStorageError } = await supabase.storage.from("attachments").remove(paths);
            if (removeStorageError) {
              log.warn(`Warning deleting attachments from storage for chat ${chatId}: ${removeStorageError.message}`);
            } else {
              log.info(`Deleted ${paths.length} storage attachment file(s) for chat ${chatId}`);
            }
          }
        }
      } catch (attErr: any) {
        log.warn(`Exception deleting attachments for chat ${chatId}: ${attErr?.message}`);
      }

      // 3. Clean up message feedback rows first to prevent foreign key errors and orphan data (#2)
      const { error: deleteFbError } = await supabase
        .from("message_feedback")
        .delete()
        .eq("chat_id", chatId);
      if (deleteFbError && !isMissingTableError(deleteFbError)) {
        log.warn(`DELETE /api/chats/${chatId} feedback cleanup warning: ${deleteFbError.message}`);
      }

      // 4. Delete chat messages
      const { error: deleteMessagesError } = await supabase
        .from("messages")
        .delete()
        .eq("chat_id", chatId);

      if (deleteMessagesError) {
        log.error("DELETE messages error", deleteMessagesError);
        // Retry message deletion after feedback cleanup
        await supabase.from("message_feedback").delete().eq("chat_id", chatId);
        await supabase.from("messages").delete().eq("chat_id", chatId);
      }

      // 4. Delete the chat row itself
      let { error: deleteChatError } = await supabase
        .from("chats")
        .delete()
        .eq("id", chatId);

      // If a message was inserted concurrently right before chat delete (foreign key violation 23503),
      // re-clean and retry deletion so the chat is completely deleted without 500 errors (#2)
      if (
        deleteChatError &&
        (String(deleteChatError.code) === "23503" ||
          String(deleteChatError.message || "").toLowerCase().includes("foreign key"))
      ) {
        log.warn(`Concurrent insert detected during DELETE chat ${chatId}; re-cleaning messages and retrying...`);
        await supabase.from("message_feedback").delete().eq("chat_id", chatId);
        await supabase.from("messages").delete().eq("chat_id", chatId);
        const retry = await supabase.from("chats").delete().eq("id", chatId);
        deleteChatError = retry.error;
      }

      if (deleteChatError) {
        log.error("DELETE chat error", deleteChatError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal menghapus percakapan: ${deleteChatError.message}`,
        });
      }

      removeChatOwner(chatId);

      // Clean up local fallback feedback store
      const localStore = readLocalFeedbackStore();
      let localChanged = false;
      for (const [msgId, entry] of Object.entries(localStore)) {
        if (entry.chat_id === chatId) {
          delete localStore[msgId];
          localChanged = true;
        }
      }
      if (localChanged) {
        writeLocalFeedbackStore(localStore);
      }

      log.info(`DELETE chat ${chatId} and its messages succeeded`);

      return res.status(200).json({
        success: true,
        data: chatId,
      });
    } catch (error: any) {
      log.error("DELETE unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Terjadi kesalahan saat menghapus percakapan.",
      });
    }
  }
);

// 9. Delete All Chats Endpoint: DELETE /api/chats (#1, #3)
app.delete("/api/chats", async (req: Request, res: Response<ApiResponse<{ deletedCount: number }>>) => {
  const requestId = randomUUID().slice(0, 8);
  const log = createLogger(requestId);
  log.info("DELETE /api/chats (delete all chats for user)");

  try {
    const { user, authError } = await resolveRequestUser(req, log);
    if (authError || !user) {
      return res.status(401).json({
        success: false,
        code: "unauthorized",
        error: authError || "Autentikasi diperlukan.",
      });
    }

    const { data: allChats, error: chatsError } = await supabase.from("chats").select("*");
    if (chatsError) {
      log.error("DELETE /api/chats select error", chatsError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal membaca daftar percakapan: ${chatsError.message}`,
      });
    }

    // Strictly delete ONLY chats explicitly owned by `user.id` (#3)
    const targetChatIds = (allChats || [])
      .filter((row: Record<string, any>) => getEffectiveChatOwner(String(row.id), row) === user.id)
      .map((row: Record<string, any>) => String(row.id));

    if (targetChatIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: { deletedCount: 0 },
      });
    }

    // Clean up physical attachments from storage for all target chats (#2)
    try {
      const { data: allAtts } = await supabase
        .from("message_attachments")
        .select("storage_path")
        .in("chat_id", targetChatIds);
      if (allAtts && allAtts.length > 0) {
        const paths = allAtts.map((r: any) => r.storage_path).filter(Boolean);
        if (paths.length > 0) {
          const { error: removeStorageError } = await supabase.storage.from("attachments").remove(paths);
          if (removeStorageError) {
            log.warn(`Warning deleting attachments from storage on delete all chats: ${removeStorageError.message}`);
          } else {
            log.info(`Deleted ${paths.length} storage attachment file(s) across deleted chats`);
          }
        }
      }
    } catch (attErr: any) {
      log.warn(`Exception deleting attachments for all chats: ${attErr?.message}`);
    }

    // Attempt to remove feedback from DB if table exists
    const { error: fbDeleteErr } = await supabase
      .from("message_feedback")
      .delete()
      .in("chat_id", targetChatIds);
    if (fbDeleteErr && !isMissingTableError(fbDeleteErr)) {
      log.warn(`DELETE /api/chats feedback cleanup warning: ${fbDeleteErr.message}`);
    }

    // Clean up local fallback feedback store
    const localStore = readLocalFeedbackStore();
    let localChanged = false;
    for (const [msgId, entry] of Object.entries(localStore)) {
      if (targetChatIds.includes(entry.chat_id)) {
        delete localStore[msgId];
        localChanged = true;
      }
    }
    if (localChanged) {
      writeLocalFeedbackStore(localStore);
    }

    const { error: msgDeleteError } = await supabase
      .from("messages")
      .delete()
      .in("chat_id", targetChatIds);

    if (msgDeleteError) {
      log.error("DELETE /api/chats messages delete error", msgDeleteError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal menghapus pesan: ${msgDeleteError.message}`,
      });
    }

    const { error: chatDeleteError } = await supabase
      .from("chats")
      .delete()
      .in("id", targetChatIds);

    if (chatDeleteError) {
      log.error("DELETE /api/chats chats delete error", chatDeleteError);
      return res.status(500).json({
        success: false,
        code: "database_error",
        error: `Gagal menghapus daftar percakapan: ${chatDeleteError.message}`,
      });
    }

    for (const id of targetChatIds) {
      removeChatOwner(id);
    }

    log.info(`DELETE /api/chats deleted ${targetChatIds.length} chats owned by user=${user.id}`);
    return res.status(200).json({
      success: true,
      data: { deletedCount: targetChatIds.length },
    });
  } catch (error: any) {
    log.error("DELETE /api/chats unexpected error", error);
    return res.status(500).json({
      success: false,
      code: "internal_error",
      error: error?.message || "Terjadi kesalahan saat menghapus semua percakapan.",
    });
  }
});

// 10. Get Feedback for a Chat: GET /api/chats/:id/feedback (#1, #4)
app.get(
  "/api/chats/:id/feedback",
  async (
    req: Request<{ id: string }>,
    res: Response<ApiResponse<Record<string, { rating: "up" | "down"; comment?: string }>>>
  ) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const chatId = (req.params.id || "").trim();

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(chatId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_chat_id",
          error: "Format ID percakapan tidak valid.",
        });
      }

      const { data: existingChat, error: selectError } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();

      if (selectError) {
        log.error("GET feedback chat select error", selectError);
        return res.status(500).json({
          success: false,
          code: "database_error",
          error: `Gagal memeriksa percakapan: ${selectError.message}`,
        });
      }

      if (!existingChat) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Percakapan tidak ditemukan.",
        });
      }

      const ownership = verifyChatOwnership(chatId, existingChat, user);
      if (!ownership.allowed) {
        log.warn(`GET feedback ownership rejected for chat_id=${chatId} user=${user.id}`);
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      const resultMap: Record<string, { rating: "up" | "down"; comment?: string }> = {};

      // Read from local fallback first so any pre-migration entries are available
      const localStore = readLocalFeedbackStore();
      for (const entry of Object.values(localStore)) {
        if (entry.chat_id === chatId && entry.user_id === user.id) {
          resultMap[entry.message_id] = {
            rating: entry.rating,
            comment: entry.comment,
          };
        }
      }

      // Query Supabase `message_feedback` table if it exists
      const { data, error } = await supabase
        .from("message_feedback")
        .select("message_id, rating, comment, user_id")
        .eq("chat_id", chatId)
        .eq("user_id", user.id);

      if (error) {
        if (!isMissingTableError(error)) {
          log.warn(`GET feedback Supabase query warning: ${error.message}`);
        }
      } else if (Array.isArray(data)) {
        for (const row of data) {
          if (row.message_id && (row.rating === "up" || row.rating === "down")) {
            resultMap[String(row.message_id)] = {
              rating: row.rating,
              comment: row.comment || undefined,
            };
          }
        }
      }

      return res.status(200).json({
        success: true,
        data: resultMap,
      });
    } catch (error: any) {
      log.error("GET feedback unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Gagal memuat feedback pesan.",
      });
    }
  }
);

// 11. Save / Update Message Feedback: POST /api/messages/:id/feedback (#1, #4)
app.post(
  "/api/messages/:id/feedback",
  async (
    req: Request<
      { id: string },
      {},
      { chat_id?: string; rating?: "up" | "down"; comment?: string; user_id?: string }
    >,
    res: Response<ApiResponse<FeedbackEntry>>
  ) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const messageId = (req.params.id || "").trim();
    const { chat_id, rating, comment } = req.body || {};

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(messageId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_message_id",
          error: "Format ID pesan tidak valid (harus berupa UUID).",
        });
      }

      if (rating !== "up" && rating !== "down") {
        return res.status(400).json({
          success: false,
          code: "invalid_rating",
          error: "Rating harus bernilai 'up' atau 'down'.",
        });
      }

      // Look up the message in `messages` to find its authoritative `chat_id`
      const { data: msgRow } = await supabase
        .from("messages")
        .select("id, chat_id")
        .eq("id", messageId)
        .maybeSingle();

      const resolvedChatId =
        (msgRow?.chat_id ? String(msgRow.chat_id) : "") ||
        (typeof chat_id === "string" ? chat_id.trim() : "");

      if (!resolvedChatId || !UUID_REGEX.test(resolvedChatId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_chat_id",
          error: "Format ID percakapan tidak valid (harus berupa UUID).",
        });
      }

      const { data: existingChat } = await supabase
        .from("chats")
        .select("*")
        .eq("id", resolvedChatId)
        .maybeSingle();

      if (!existingChat) {
        return res.status(404).json({
          success: false,
          code: "not_found",
          error: "Percakapan untuk pesan ini tidak ditemukan.",
        });
      }

      const ownership = verifyChatOwnership(resolvedChatId, existingChat, user);
      if (!ownership.allowed) {
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: ownership.reason || "Akses ditolak.",
        });
      }

      if (typeof comment === "string" && comment.length > 1000) {
        return res.status(400).json({
          success: false,
          code: "comment_too_long",
          error: "Komentar masukan maksimal 1.000 karakter.",
        });
      }

      const trimmedComment =
        typeof comment === "string" && comment.trim()
          ? comment.trim()
          : undefined;

      const entry: FeedbackEntry = {
        message_id: messageId,
        chat_id: resolvedChatId,
        user_id: user.id,
        rating,
        comment: trimmedComment,
        updated_at: new Date().toISOString(),
      };

      const { error: dbError } = await supabase.from("message_feedback").upsert(
        {
          message_id: messageId,
          chat_id: resolvedChatId,
          user_id: user.id,
          rating,
          comment: trimmedComment || null,
          updated_at: entry.updated_at,
        },
        { onConflict: "message_id" }
      );

      if (dbError && !isMissingTableError(dbError)) {
        log.warn(`POST feedback Supabase upsert warning (using local store): ${dbError.message}`);
      }

      const localStore = readLocalFeedbackStore();
      localStore[messageId] = entry;
      writeLocalFeedbackStore(localStore);

      log.info(
        `POST /api/messages/${messageId}/feedback saved rating=${rating} user=${user.id}`
      );

      return res.status(200).json({
        success: true,
        data: entry,
      });
    } catch (error: any) {
      log.error("POST feedback unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Gagal menyimpan feedback pesan.",
      });
    }
  }
);

// 12. Remove Message Feedback: DELETE /api/messages/:id/feedback (#1, #4)
app.delete(
  "/api/messages/:id/feedback",
  async (req: Request<{ id: string }>, res: Response<ApiResponse<string>>) => {
    const requestId = randomUUID().slice(0, 8);
    const log = createLogger(requestId);
    const messageId = (req.params.id || "").trim();

    try {
      const { user, authError } = await resolveRequestUser(req, log);
      if (authError || !user) {
        return res.status(401).json({
          success: false,
          code: "unauthorized",
          error: authError || "Autentikasi diperlukan.",
        });
      }

      if (!UUID_REGEX.test(messageId)) {
        return res.status(400).json({
          success: false,
          code: "invalid_message_id",
          error: "Format ID pesan tidak valid (harus berupa UUID).",
        });
      }

      const localStore = readLocalFeedbackStore();
      const localEntry = localStore[messageId];

      const { data: msgRow } = await supabase
        .from("messages")
        .select("id, chat_id")
        .eq("id", messageId)
        .maybeSingle();

      const resolvedChatId = msgRow?.chat_id
        ? String(msgRow.chat_id)
        : localEntry?.chat_id || "";

      if (resolvedChatId) {
        const { data: existingChat } = await supabase
          .from("chats")
          .select("*")
          .eq("id", resolvedChatId)
          .maybeSingle();

        const ownership = verifyChatOwnership(resolvedChatId, existingChat, user);
        if (!ownership.allowed) {
          return res.status(403).json({
            success: false,
            code: "forbidden",
            error: ownership.reason || "Akses ditolak.",
          });
        }
      } else if (localEntry && localEntry.user_id !== user.id) {
        return res.status(403).json({
          success: false,
          code: "forbidden",
          error: "Akses ditolak: feedback ini bukan milik Anda.",
        });
      }

      const { error: dbError } = await supabase
        .from("message_feedback")
        .delete()
        .eq("message_id", messageId)
        .eq("user_id", user.id);

      if (dbError && !isMissingTableError(dbError)) {
        log.warn(`DELETE feedback Supabase warning: ${dbError.message}`);
      }

      if (messageId in localStore) {
        delete localStore[messageId];
        writeLocalFeedbackStore(localStore);
      }

      log.info(`DELETE /api/messages/${messageId}/feedback removed by user=${user.id}`);
      return res.status(200).json({
        success: true,
        data: messageId,
      });
    } catch (error: any) {
      log.error("DELETE feedback unexpected error", error);
      return res.status(500).json({
        success: false,
        code: "internal_error",
        error: error?.message || "Gagal menghapus feedback pesan.",
      });
    }
  }
);

// Catch-all 404 Handler (Replaces Express default HTML "Cannot GET ..." with JSON) (#6)
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    code: "not_found",
    error: "Endpoint tidak ditemukan.",
  });
});

// Global Error Handler with Centralized Error Reporting (#10)
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  reportCentralizedError(err, {
    route: req.originalUrl || req.url,
    method: req.method,
    ip: getClientIp(req),
  });
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({
    success: false,
    code: "internal_error",
    error: "Terjadi kesalahan internal pada server.",
  });
});

// Process-level crash guards (#6):
// - unhandledRejection: log error terpusat tanpa mematikan server.
// - uncaughtException: log error terpusat, beri waktu maksimal 2 detik untuk flush Sentry, lalu process.exit(1)
//   agar orchestrator hosting (Railway, Docker, PM2, systemd, Kubernetes) me-restart pod dalam keadaan bersih.
process.on("unhandledRejection", (reason: unknown) => {
  reportCentralizedError(reason, {
    extra: { context: "process.unhandledRejection" },
  });
});

let isShuttingDownFromUncaught = false;
process.on("uncaughtException", (error: Error) => {
  if (isShuttingDownFromUncaught) return;
  isShuttingDownFromUncaught = true;

  console.error("[FATAL] Uncaught exception detected. Reporting and exiting cleanly...");
  reportCentralizedError(error, {
    extra: { context: "process.uncaughtException", willExit: true },
  });

  // Beri jeda 2 detik agar transport fetch Sentry sempat terkirim, lalu keluar dengan exit code 1
  const exitTimer = setTimeout(() => {
    process.exit(1);
  }, 2000);

  // Unref timer agar tidak menahan proses jika seluruh handle I/O sudah selesai
  exitTimer.unref();
});

// Orphan Attachment Cleaner Routine (#2)
// Removes attachments uploaded over 24 hours ago that were never attached to a sent message.
async function cleanupOrphanAttachments(log: ReturnType<typeof createLogger>) {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: orphans, error } = await supabase
      .from("message_attachments")
      .select("id, storage_path")
      .is("message_id", null)
      .lt("created_at", oneDayAgo);

    if (error) {
      if (!isMissingTableError(error)) {
        log.warn(`Orphan attachments query error: ${error.message}`);
      }
      return;
    }

    if (orphans && orphans.length > 0) {
      const paths = orphans.map((o: any) => o.storage_path).filter(Boolean);
      const ids = orphans.map((o: any) => o.id);
      log.info(`Found ${orphans.length} orphan attachment(s) older than 24h. Cleaning up...`);
      if (paths.length > 0) {
        await supabase.storage.from("attachments").remove(paths);
      }
      await supabase.from("message_attachments").delete().in("id", ids);
      log.info(`Cleaned up ${orphans.length} orphan attachment(s) from storage and database.`);
    }
  } catch (err: any) {
    log.warn(`cleanupOrphanAttachments exception: ${err?.message}`);
  }
}

export { app, cleanupOrphanAttachments };

if (process.env.NODE_ENV !== "test") {
  const startupLogger = createLogger("startup");
  // Run orphan cleaner 30 seconds after server startup, then every 6 hours
  setTimeout(() => {
    cleanupOrphanAttachments(startupLogger);
    const orphanInterval = setInterval(() => {
      cleanupOrphanAttachments(startupLogger);
    }, 6 * 60 * 60 * 1000);
    orphanInterval.unref();
  }, 30000).unref();

  app.listen(PORT, () => {
    console.log(`[Axioma Backend] Server listening on port ${PORT}`);
  });
}
