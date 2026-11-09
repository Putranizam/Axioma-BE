import dotenv from "dotenv";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Load .env from backend folder if not already loaded
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export interface TestEnvConfig {
  supabaseUrl: string;
  supabaseKey: string;
  supabaseAdmin: SupabaseClient;
  isCustomTestProject: boolean;
}

export function initTestEnv(scriptName = "Test Suite"): TestEnvConfig {
  // 1. Tolak mutlak jika NODE_ENV=production
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `[SECURITY ERROR] ${scriptName} menolak dijalankan saat NODE_ENV=production! ` +
      `Pastikan pengujian hanya dijalankan pada lingkungan development atau test.`
    );
  }

  const prodUrl = (process.env.SUPABASE_URL || "").trim();
  const testUrl = (process.env.SUPABASE_URL_TEST || "").trim();
  const testKey = (
    process.env.SUPABASE_SERVICE_KEY_TEST ||
    process.env.SUPABASE_SERVICE_ROLE_KEY_TEST ||
    ""
  ).trim();

  // 2. Jika SUPABASE_URL_TEST ditentukan, tolak jika sama persis dengan SUPABASE_URL produksi
  if (testUrl && prodUrl) {
    const normalize = (u: string) => u.toLowerCase().replace(/\/+$/, "");
    if (normalize(testUrl) === normalize(prodUrl)) {
      throw new Error(
        `[SECURITY ERROR] ${scriptName} ditolak: SUPABASE_URL_TEST sama dengan SUPABASE_URL produksi (${prodUrl})! ` +
        `Pengujian terisolasi harus menggunakan URL project Supabase pengujian yang berbeda.`
      );
    }
  }

  let effectiveUrl = prodUrl;
  let effectiveKey = (
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    ""
  ).trim();
  let isCustomTestProject = false;

  if (testUrl) {
    if (!testKey) {
      throw new Error(
        `[CONFIGURATION ERROR] SUPABASE_URL_TEST ditentukan (${testUrl}), namun SUPABASE_SERVICE_KEY_TEST tidak ada.`
      );
    }
    effectiveUrl = testUrl;
    effectiveKey = testKey;
    isCustomTestProject = true;

    // Override env agar backend/src/index.ts menggunakan database test ini
    process.env.SUPABASE_URL = effectiveUrl;
    process.env.SUPABASE_SERVICE_KEY = effectiveKey;
  }

  // Set NODE_ENV ke test
  process.env.NODE_ENV = "test";

  if (!effectiveUrl || !effectiveKey) {
    throw new Error(
      `[CONFIGURATION ERROR] Kredensial Supabase untuk testing belum lengkap. ` +
      `Sediakan SUPABASE_URL & SUPABASE_SERVICE_KEY atau SUPABASE_URL_TEST & SUPABASE_SERVICE_KEY_TEST.`
    );
  }

  const supabaseAdmin = createClient(effectiveUrl, effectiveKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`[Axioma TestEnv] Initialized for ${scriptName}`);
  console.log(`[Axioma TestEnv] Target Supabase URL: ${effectiveUrl} (isolated test project: ${isCustomTestProject ? "YES" : "NO (local/dev)"})`);

  return {
    supabaseUrl: effectiveUrl,
    supabaseKey: effectiveKey,
    supabaseAdmin,
    isCustomTestProject,
  };
}

export const defaultTestEnv = initTestEnv("Axioma Test Suite");
export const supabaseAdmin = defaultTestEnv.supabaseAdmin;
export const supabaseUrl = defaultTestEnv.supabaseUrl;
export const supabaseKey = defaultTestEnv.supabaseKey;
export const isCustomTestProject = defaultTestEnv.isCustomTestProject;

