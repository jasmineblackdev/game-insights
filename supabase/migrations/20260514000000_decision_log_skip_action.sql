-- ============================================================
-- decision_log — extend action CHECK constraint with 'skip'.
--
-- Phase 3 of the consolidation introduced decision_log with
-- actions { shown, followed, overridden, ignored }. The hand-off
-- from Today's Decision → Paper Bets adds a fifth action:
--   skip  → AI verdict was SKIP and the user did not override.
--           Logged automatically when a SKIP card renders, so the
--           "user-followed-the-skip" rate is measurable distinctly
--           from "user never opened the page".
-- ============================================================

alter table public.decision_log
  drop constraint if exists decision_log_action_check;

alter table public.decision_log
  add constraint decision_log_action_check
  check (action in (
    'shown',
    'followed',
    'overridden',
    'ignored',
    'skip'
  ));
