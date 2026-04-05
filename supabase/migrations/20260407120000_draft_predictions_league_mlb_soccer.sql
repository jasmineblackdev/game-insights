-- Allow Draft Edge rows for MLB and soccer (transfer-window composite) in addition to NFL/NBA.

alter table public.draft_predictions drop constraint if exists draft_predictions_league_check;

alter table public.draft_predictions add constraint draft_predictions_league_check
  check (league in ('nfl', 'nba', 'mlb', 'soccer'));
