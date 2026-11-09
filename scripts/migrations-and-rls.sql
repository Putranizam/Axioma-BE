-- =============================================================================
-- AXIOMA SUPABASE MIGRATION, BACKFILL & RLS LOCKDOWN SCRIPT
-- Sifat Skrip : 100% IDEMPOTENT (Aman dijalankan berulang kali tanpa menghapus data)
-- Mencakup:
--   Bagian 1 : Penambahan kolom `user_id` pada `public.chats` + Backfill data lama
--   Bagian 2 : Penambahan kolom `agent_id` & `agent_name` pada `public.messages` + Backfill
--   Bagian 3 : Pembuatan tabel `public.message_feedback` (FK ON DELETE CASCADE)
--   Bagian 4 : Pembuatan tabel `public.gemini_daily_usage` (Persistensi kuota harian AI)
--   Bagian 5 : Pengaktifan Row Level Security (RLS) pada seluruh tabel
--   Bagian 6 : Penghapusan policy publik & pencabutan hak akses `anon` / `authenticated`
--   Bagian 7 : Penonaktifan publikasi Supabase Realtime untuk tabel percakapan
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- BAGIAN 1: Kolom Kepemilikan `user_id` pada `public.chats` & Backfill
-- -----------------------------------------------------------------------------
ALTER TABLE public.chats
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_chats_user_id
  ON public.chats(user_id);

-- Backfill kepemilikan dari catatan lokal (`chat-owners.json`) ke database
-- Hanya mengisi baris yang `user_id`-nya masih NULL agar aman dijalankan ulang.
UPDATE public.chats
SET user_id = '2bd9c62b-6793-40e7-b0ca-77b03c625a37'
WHERE id IN (
  'c473cf9d-515c-4b62-9788-f9535405afc1',
  'b71d233e-2335-4558-b67f-cd1fedecc251',
  '642caa85-3a55-483c-b863-cc657f35ca2b',
  'a19114a6-eb7d-48c3-ac29-e07c2aa7acef'
)
AND user_id IS NULL;

-- -----------------------------------------------------------------------------
-- BAGIAN 2: Kolom `agent_id` & `agent_name` pada `public.messages` & Backfill
-- -----------------------------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS agent_id TEXT,
  ADD COLUMN IF NOT EXISTS agent_name TEXT;

-- Backfill pesan AI yang memakai mode Axioma Omni (dari `message-agents.json`)
UPDATE public.messages
SET
  agent_id = 'axioma-omni',
  agent_name = 'Axioma Omni'
WHERE id = 'f63179a3-50b7-4a8f-a3e0-0f2345055f4e'
  AND (agent_id IS NULL OR agent_name IS NULL);

-- Backfill pesan AI lainnya yang belum memiliki label agen menjadi Axioma Pro
UPDATE public.messages
SET
  agent_id = COALESCE(agent_id, 'axioma-pro'),
  agent_name = COALESCE(agent_name, 'Axioma Pro')
WHERE role IN ('ai', 'assistant')
  AND (agent_id IS NULL OR agent_name IS NULL);

-- -----------------------------------------------------------------------------
-- BAGIAN 3: Tabel `public.message_feedback` (Masukan 👍/👎 per Pesan)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.message_feedback (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  comment TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_chat_id
  ON public.message_feedback(chat_id);

-- -----------------------------------------------------------------------------
-- BAGIAN 4: Tabel & Fungsi Atomik Kuota Harian Gemini
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gemini_daily_usage (
  usage_date DATE PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.increment_gemini_daily_usage(target_date DATE DEFAULT CURRENT_DATE)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_count INTEGER;
BEGIN
  INSERT INTO public.gemini_daily_usage (usage_date, call_count, updated_at)
  VALUES (target_date, 1, NOW())
  ON CONFLICT (usage_date)
  DO UPDATE SET
    call_count = public.gemini_daily_usage.call_count + 1,
    updated_at = NOW()
  RETURNING call_count INTO new_count;

  RETURN new_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_gemini_daily_usage(DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_gemini_daily_usage(DATE) FROM anon;
REVOKE ALL ON FUNCTION public.increment_gemini_daily_usage(DATE) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_gemini_daily_usage(DATE) TO service_role;

-- -----------------------------------------------------------------------------
-- BAGIAN 5: Aktifkan Row Level Security (RLS) pada Seluruh Tabel
-- -----------------------------------------------------------------------------
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gemini_daily_usage ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BAGIAN 6: Hapus Semua Policy Publik & Cabut Hak Akses `anon` serta `authenticated`
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('chats', 'messages', 'message_feedback', 'gemini_daily_usage', 'user_turnstile_verifications')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

REVOKE ALL ON TABLE public.chats FROM anon;
REVOKE ALL ON TABLE public.messages FROM anon;
REVOKE ALL ON TABLE public.message_feedback FROM anon;
REVOKE ALL ON TABLE public.gemini_daily_usage FROM anon;

REVOKE ALL ON TABLE public.chats, public.messages, public.message_feedback, public.gemini_daily_usage FROM authenticated;

-- -----------------------------------------------------------------------------
-- BAGIAN 7: Matikan Supabase Realtime untuk Tabel Percakapan
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chats'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.chats;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.messages;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- BAGIAN 8: Tabel Verifikasi Cloudflare Turnstile (Anti-Bot Per User 30 Menit)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_turnstile_verifications (
  user_id TEXT PRIMARY KEY,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_turnstile_verified_at
  ON public.user_turnstile_verifications(verified_at);

ALTER TABLE public.user_turnstile_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_turnstile_verifications FROM anon;
REVOKE ALL ON TABLE public.user_turnstile_verifications FROM authenticated;
GRANT ALL ON TABLE public.user_turnstile_verifications TO service_role;

COMMIT;
