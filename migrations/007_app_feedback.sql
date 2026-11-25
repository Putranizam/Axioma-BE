-- =============================================================================
-- 007_app_feedback.sql — Tabel Masukan & Laporan Bug Pengguna Axioma
-- Aman dijalankan berulang (idempoten: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- Seluruh akses ditulis oleh Backend (service_role) melalui POST /api/feedback.
-- Akses langsung dari client (anon / authenticated) ditutup sepenuhnya via RLS.
-- =============================================================================

BEGIN;

-- 1. Tabel Masukan Aplikasi (public.app_feedback)
CREATE TABLE IF NOT EXISTS public.app_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT,
  category TEXT NOT NULL DEFAULT 'Lainnya',
  message TEXT NOT NULL CHECK (char_length(trim(message)) >= 3 AND char_length(message) <= 4000),
  user_name TEXT,
  user_email TEXT,
  device_info TEXT,
  client_ip TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pastikan kolom tersedia bila tabel pernah dibuat sebagian
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Lainnya';
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS user_name TEXT;
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS user_email TEXT;
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS client_ip TEXT;
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. Indeks Performa
CREATE INDEX IF NOT EXISTS idx_app_feedback_created_at
  ON public.app_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_feedback_category
  ON public.app_feedback (category);

CREATE INDEX IF NOT EXISTS idx_app_feedback_user_id
  ON public.app_feedback (user_id)
  WHERE user_id IS NOT NULL;

-- 3. Penguncian Row Level Security (RLS) & Hak Akses Khusus service_role
ALTER TABLE public.app_feedback ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'app_feedback'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.app_feedback FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.app_feedback TO service_role;

CREATE POLICY service_role_all_app_feedback
  ON public.app_feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. Pastikan tabel tidak dipublikasikan ke Supabase Realtime
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'app_feedback'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.app_feedback;
  END IF;
END $$;

COMMIT;
