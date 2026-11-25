-- =============================================================================
-- 006_quota_and_billing.sql — Skema Kuota Kredit Harian & Saldo Permanen Axioma
-- Aman dijalankan berulang (idempoten: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- Cocok 100% dengan src/services/quotaService.ts dan siap disambungkan ke webhook
-- payment gateway otomatis di rilis berikutnya.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabel Kuota Kredit Harian & Saldo Permanen (public.user_daily_quotas)
--    - daily_credits : sisa kuota gratis harian (default 30, reset per tanggal WIB)
--    - used_credits  : kredit harian terpakai pada usage_date (WIB)
--    - bonus_credits : saldo permanen dari Top-Up (tidak pernah ter-reset)
--    - pro_expires_at: masa aktif langganan Axioma Pro (30 hari saat aktif)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_daily_quotas (
  user_id TEXT NOT NULL,
  usage_date DATE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  daily_credits INTEGER NOT NULL DEFAULT 30 CHECK (daily_credits >= 0),
  used_credits INTEGER NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  bonus_credits INTEGER NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  pro_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, usage_date)
);

-- Pastikan seluruh kolom tersedia jika tabel sebelumnya sudah dibuat sebagian
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS daily_credits INTEGER NOT NULL DEFAULT 30;
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS used_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS bonus_credits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS pro_expires_at TIMESTAMPTZ;
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_user_daily_quotas_usage_date
  ON public.user_daily_quotas (usage_date DESC);

CREATE INDEX IF NOT EXISTS idx_user_daily_quotas_user_latest
  ON public.user_daily_quotas (user_id, usage_date DESC);

CREATE INDEX IF NOT EXISTS idx_user_daily_quotas_plan
  ON public.user_daily_quotas (plan);

-- -----------------------------------------------------------------------------
-- 2. Penguncian Row Level Security (RLS) & Hak Akses Khusus service_role
--    Akses langsung dari client (anon / authenticated) ditutup sepenuhnya.
-- -----------------------------------------------------------------------------
ALTER TABLE public.user_daily_quotas ENABLE ROW LEVEL SECURITY;

-- Hapus policy lama jika ada agar tidak bentrok saat dijalankan ulang
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_daily_quotas'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- Cabut seluruh hak akses dari PUBLIC, anon, dan authenticated
REVOKE ALL ON TABLE public.user_daily_quotas FROM PUBLIC, anon, authenticated;

-- Berikan izin penuh hanya kepada service_role (Backend Axioma)
GRANT ALL ON TABLE public.user_daily_quotas TO service_role;

-- Policy eksplisit khusus service_role (memenuhi audit Supabase Security Advisor)
CREATE POLICY service_role_all_user_daily_quotas
  ON public.user_daily_quotas
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Pastikan tabel tidak dipublikasikan ke Supabase Realtime
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'user_daily_quotas'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.user_daily_quotas;
  END IF;
END $$;

COMMIT;
