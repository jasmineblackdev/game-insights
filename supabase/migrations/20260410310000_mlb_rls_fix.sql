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

    -- Drop + recreate — policy names are "public read {table}" (single identifier via %I)
    execute format('drop policy if exists %I on public.%I', 'public read ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for select using (true)',
      'public read ' || tbl,
      tbl
    );

    execute format('drop policy if exists %I on public.%I', 'service write ' || tbl, tbl);
    execute format(
      'create policy %I on public.%I for insert with check (auth.role() = ''service_role'')',
      'service write ' || tbl,
      tbl
    );
  end loop;
end $$;
