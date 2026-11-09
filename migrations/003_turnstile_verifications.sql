-- =============================================================================
-- 003_turnstile_verifications.sql — Cache Verifikasi Cloudflare Turnstile
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_turnstile_verifications (
  user_id TEXT PRIMARY KEY,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_turnstile_verified_at 
  ON public.user_turnstile_verifications(verified_at DESC);

COMMIT;

