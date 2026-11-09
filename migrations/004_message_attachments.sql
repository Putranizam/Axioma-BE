-- =============================================================================
-- 004_message_attachments.sql — Metadata Lampiran Multimodal Pesan Axioma
-- =============================================================================

BEGIN;

-- 1. Buat tabel message_attachments
-- chat_id dan message_id bersifat NULLABLE saat upload awal (pre-upload),
-- lalu dikaitkan secara atomik saat pesan dikirimkan.
CREATE TABLE IF NOT EXISTS public.message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES public.chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  page_count INTEGER,
  original_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indeks untuk performa query & relasi
CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id 
  ON public.message_attachments(message_id);

CREATE INDEX IF NOT EXISTS idx_message_attachments_chat_id 
  ON public.message_attachments(chat_id);

CREATE INDEX IF NOT EXISTS idx_message_attachments_user_id 
  ON public.message_attachments(user_id);

-- Indeks untuk pembersihan berkas yatim (diunggah tapi batal dikirim > 24 jam)
CREATE INDEX IF NOT EXISTS idx_message_attachments_orphan 
  ON public.message_attachments(created_at) 
  WHERE message_id IS NULL;

-- 3. Constraint batas ukuran file (10 MB) dan jumlah halaman PDF (maks. 30)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_attachments_limits_chk'
  ) THEN
    ALTER TABLE public.message_attachments
      ADD CONSTRAINT message_attachments_limits_chk
      CHECK (
        size_bytes > 0 
        AND size_bytes <= 10485760 
        AND (page_count IS NULL OR page_count <= 30)
      );
  END IF;
END $$;

COMMIT;

