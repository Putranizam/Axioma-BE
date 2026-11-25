-- ============================================================================
-- Axioma Daily Token Quota System Migration (008)
-- Extends `public.user_daily_quotas` with real token accounting columns
-- without modifying or dropping existing credit columns or user rows.
-- Safe and idempotent to re-run in Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- 1. Add token tracking columns idempotently
ALTER TABLE public.user_daily_quotas
  ADD COLUMN IF NOT EXISTS tokens_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_tokens_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_tokens_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_token_limit INTEGER NOT NULL DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS bonus_tokens INTEGER NOT NULL DEFAULT 0;

-- 2. Add non-negative integrity constraints idempotently
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_daily_quotas_tokens_used_nonneg'
      AND conrelid = 'public.user_daily_quotas'::regclass
  ) THEN
    ALTER TABLE public.user_daily_quotas
      ADD CONSTRAINT user_daily_quotas_tokens_used_nonneg
      CHECK (tokens_used >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_daily_quotas_prompt_tokens_used_nonneg'
      AND conrelid = 'public.user_daily_quotas'::regclass
  ) THEN
    ALTER TABLE public.user_daily_quotas
      ADD CONSTRAINT user_daily_quotas_prompt_tokens_used_nonneg
      CHECK (prompt_tokens_used >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_daily_quotas_completion_tokens_used_nonneg'
      AND conrelid = 'public.user_daily_quotas'::regclass
  ) THEN
    ALTER TABLE public.user_daily_quotas
      ADD CONSTRAINT user_daily_quotas_completion_tokens_used_nonneg
      CHECK (completion_tokens_used >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_daily_quotas_daily_token_limit_nonneg'
      AND conrelid = 'public.user_daily_quotas'::regclass
  ) THEN
    ALTER TABLE public.user_daily_quotas
      ADD CONSTRAINT user_daily_quotas_daily_token_limit_nonneg
      CHECK (daily_token_limit >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_daily_quotas_bonus_tokens_nonneg'
      AND conrelid = 'public.user_daily_quotas'::regclass
  ) THEN
    ALTER TABLE public.user_daily_quotas
      ADD CONSTRAINT user_daily_quotas_bonus_tokens_nonneg
      CHECK (bonus_tokens >= 0);
  END IF;
END
$$;

-- 3. Align existing Pro rows with the default Pro daily token limit if still at Free default
UPDATE public.user_daily_quotas
SET daily_token_limit = 500000
WHERE plan = 'pro'
  AND daily_token_limit = 50000;

-- 4. Column documentation
COMMENT ON COLUMN public.user_daily_quotas.tokens_used IS 'Total billed tokens consumed by the user on usage_date (WIB).';
COMMENT ON COLUMN public.user_daily_quotas.prompt_tokens_used IS 'Total billed prompt (input) tokens consumed on usage_date (WIB).';
COMMENT ON COLUMN public.user_daily_quotas.completion_tokens_used IS 'Total billed completion (AI output) tokens consumed on usage_date (WIB).';
COMMENT ON COLUMN public.user_daily_quotas.daily_token_limit IS 'Daily token quota limit applied to this user on usage_date (50000 free / 500000 pro by default).';
COMMENT ON COLUMN public.user_daily_quotas.bonus_tokens IS 'Permanent bonus/top-up tokens carried across WIB date rollovers (never auto-reset).';

COMMIT;
