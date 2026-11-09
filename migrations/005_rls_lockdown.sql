-- =============================================================================
-- 005_rls_lockdown.sql — Penguncian Row Level Security (RLS) & Hak Akses
-- Seluruh akses data database Axioma hanya diizinkan melalui Backend (service_role).
-- Akses langsung dari client (anon / authenticated) ditutup sepenuhnya.
-- =============================================================================

BEGIN;

-- 1. Aktifkan Row Level Security (RLS) pada semua tabel
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gemini_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_turnstile_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;

-- 2. Hapus semua policy publik yang mungkin tersisa
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'chats', 
        'messages', 
        'message_feedback', 
        'gemini_daily_usage', 
        'user_turnstile_verifications',
        'message_attachments'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- 3. Cabut semua hak akses dari role anon dan authenticated
REVOKE ALL ON TABLE public.chats FROM anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.message_feedback FROM anon, authenticated;
REVOKE ALL ON TABLE public.gemini_daily_usage FROM anon, authenticated;
REVOKE ALL ON TABLE public.user_turnstile_verifications FROM anon, authenticated;
REVOKE ALL ON TABLE public.message_attachments FROM anon, authenticated;

-- 4. Berikan izin penuh hanya kepada service_role (backend Axioma)
GRANT ALL ON TABLE public.chats TO service_role;
GRANT ALL ON TABLE public.messages TO service_role;
GRANT ALL ON TABLE public.message_feedback TO service_role;
GRANT ALL ON TABLE public.gemini_daily_usage TO service_role;
GRANT ALL ON TABLE public.user_turnstile_verifications TO service_role;
GRANT ALL ON TABLE public.message_attachments TO service_role;

-- 5. Nonaktifkan publikasi Supabase Realtime untuk tabel percakapan
--    (Mencegah penyadapan stream database via WebSocket client)
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

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'message_attachments'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.message_attachments;
  END IF;
END $$;

COMMIT;

