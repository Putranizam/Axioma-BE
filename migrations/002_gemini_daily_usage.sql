-- =============================================================================
-- 002_gemini_daily_usage.sql — Pelacakan Kuota Harian Panggilan AI Gemini
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.gemini_daily_usage (
  usage_date DATE PRIMARY KEY,
  call_count INTEGER NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fungsi atomik PostgreSQL untuk menambah counter kuota harian
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

COMMIT;

