-- Extend recommended_parlays.source to recognize the DraftKings
-- manual-execution path. Drops the existing CHECK constraint and
-- re-adds it with the new value included.

alter table recommended_parlays
  drop constraint if exists recommended_parlays_source_check;

alter table recommended_parlays
  add constraint recommended_parlays_source_check
  check (source in (
    'app_recommended',
    'user_manual',
    'app_recommended_and_placed',
    'draftkings_manual'
  ));
