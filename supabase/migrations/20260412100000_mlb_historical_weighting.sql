-- MLB historical weighting v2 — additive columns for layered model + backtests.
-- Safe to re-run: duplicate_column ignored.

-- Team batting: last-14 window for 25% trend slot (ETL / batch jobs populate).
do $$ begin
  begin
    alter table public.mlb_team_batting_splits add column last_14d_batting_avg numeric(4,3);
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_team_batting_splits add column last_14d_ops numeric(5,3);
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_team_batting_splits add column last_14d_strikeout_rate numeric(4,3);
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_team_batting_splits add column last_14d_sample_pa integer;
  exception when duplicate_column then null;
  end;
end $$;

-- Bullpen: season-quality prior for 50/50 blend with fatigue (0–10, higher = stronger pen; app-validated).
do $$ begin
  begin
    alter table public.mlb_bullpen_fatigue_scores add column season_bullpen_quality_score smallint;
  exception when duplicate_column then null;
  end;
end $$;

-- Historical games: optional weather / context (ingestion).
do $$ begin
  begin
    alter table public.mlb_historical_games add column temperature_f smallint;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_historical_games add column wind_mph smallint;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_historical_games add column wind_direction text;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_historical_games add column splits_context jsonb;
  exception when duplicate_column then null;
  end;
end $$;

-- Snapshot: prediction lineage + full input JSON for backtesting.
do $$ begin
  begin
    alter table public.mlb_prediction_inputs_snapshot add column prediction_version text default '2.0-historical';
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_prediction_inputs_snapshot add column model_inputs_snapshot jsonb;
  exception when duplicate_column then null;
  end;
  begin
    alter table public.mlb_prediction_inputs_snapshot add column edge_notes text;
  exception when duplicate_column then null;
  end;
end $$;
