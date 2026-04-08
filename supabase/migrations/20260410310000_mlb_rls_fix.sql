-- Fix: mlb_model RLS policies
-- The prior migration used "CREATE POLICY IF NOT EXISTS" which is PostgreSQL 17+
-- syntax and fails on Supabase's PostgreSQL 15. This migration re-applies the
-- RLS policies using PG-15-compatible exception-based idempotency.

do $$ declare
  tbl text;
begin
  foreach tbl in array array[
    'mlb_historical_games',
    'mlb_pitcher_game_logs',
    'mlb_hitter_game_logs',
    'mlb_bullpen_usage',
    'mlb_team_batting_splits',
    'mlb_pitcher_recent_form',
    'mlb_bullpen_fatigue_scores',
    'mlb_lineup_strength_scores',
    'mlb_prediction_inputs_snapshot'
  ] loop
    -- Idempotent: enable RLS (safe to run multiple times)
    execute format('alter table public.%I enable row level security', tbl);

    -- Drop + recreate policies — safe because tables are service-role-write only
    execute format('drop policy if exists "public read %1$I" on public.%1$I', tbl);
    execute format(
      'create policy "public read %1$I" on public.%1$I for select using (true)',
      tbl
    );

    execute format('drop policy if exists "service write %1$I" on public.%1$I', tbl);
    execute format(
      'create policy "service write %1$I" on public.%1$I for insert with check (auth.role() = ''service_role'')',
      tbl
    );
  end loop;
end $$;
