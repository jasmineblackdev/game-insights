-- Draft Edge: prediction cards (NFL-first). Served via `draft-edge` Edge Function.

create table public.draft_predictions (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  year int not null,
  league text not null check (league in ('nfl', 'nba')),
  card_kind text not null check (
    card_kind in ('exact_pick', 'position_ou', 'round_yes_no', 'team_position', 'position_first')
  ),
  pick_number int,
  player_id text not null,
  player_name text not null,
  position text not null,
  college text,
  predicted_team text,
  predicted_team_abbr text,
  probability numeric,
  prob_low numeric,
  prob_high numeric,
  confidence text not null check (confidence in ('HIGH', 'MED', 'LOW')),
  grade text not null,
  tier text,
  reason_1 text not null default '',
  reason_2 text not null default '',
  risk_factor text not null default '',
  ou_line numeric,
  ou_prediction text check (ou_prediction is null or ou_prediction in ('OVER', 'UNDER')),
  projected_pick int,
  round_prediction text check (round_prediction is null or round_prediction in ('yes', 'no')),
  team_target_abbr text,
  team_need_position text,
  first_position_label text,
  mover_note text,
  tags text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create index draft_predictions_year_league_idx on public.draft_predictions (year, league);

alter table public.draft_predictions enable row level security;

create policy draft_predictions_select_public on public.draft_predictions for select using (true);

grant select on public.draft_predictions to anon, authenticated;

-- Seed NFL 2026 (mirrors `DRAFT_EDGE_MOCK_NFL`; extend via admin / ETL)
insert into public.draft_predictions (
  external_id, year, league, card_kind, pick_number, player_id, player_name, position, college,
  predicted_team, predicted_team_abbr, probability, prob_low, prob_high, confidence, grade, tier,
  reason_1, reason_2, risk_factor, ou_line, ou_prediction, projected_pick, round_prediction,
  team_target_abbr, team_need_position, first_position_label, mover_note, tags
) values
  (
    'de_nfl_exact_001', 2026, 'nfl', 'exact_pick', 1, 'travis_hunter', 'Travis Hunter', 'CB / WR', 'Colorado',
    'Cleveland Browns', 'CLE', 72, 62, 82, 'HIGH', 'A+', 'Elite',
    'Two-way impact profile matches Cleveland''s need for a culture-shifting talent at #1.',
    'Consensus big board + premium CB scarcity align with early lock signals.',
    'Trade-back rumors if another team overpays — probability is team-specific, not player-specific.',
    null, null, null, null, null, null, null, null,
    array['top10', 'round1', 'high_confidence']
  ),
  (
    'de_nfl_exact_002', 2026, 'nfl', 'exact_pick', 2, 'shedeur_sanders', 'Shedeur Sanders', 'QB', 'Colorado',
    'New York Giants', 'NYG', 58, 45, 70, 'HIGH', 'A-', 'Blue chip',
    'NYG timeline and QB room point to taking the highest-floor passer in the class.',
    'Market mocks cluster Sanders to NYG or JAX; positional value keeps him in the top 3.',
    'Smokescreens from teams trading up for QB could shuffle slots 2–4 quickly.',
    null, null, null, null, null, null, null,
    'Mock consensus shifted NYG-QB linkage +8 pts over last 10 days.',
    array['top10', 'round1', 'high_confidence', 'mover']
  ),
  (
    'de_nfl_ou_001', 2026, 'nfl', 'position_ou', null, 'shedeur_sanders', 'Shedeur Sanders', 'QB', 'Colorado',
    null, null, null, 55, 78, 'MED', 'A-', 'Blue chip',
    'Multiple QB-needy teams in the top 5 cap downside for a slide past 5.',
    'Strong production profile and pro-ready traits reduce “fall out of top 10” scenarios.',
    'Heavy trade activity at the top could push a run earlier or compress QB landing spots.',
    5.5, 'UNDER', 3, null, null, null, null,
    'Draft position prop line steamed toward Under after combine interviews.',
    array['position_props', 'top10', 'mover']
  ),
  (
    'de_nfl_round_001', 2026, 'nfl', 'round_yes_no', null, 'will_johnson', 'Will Johnson', 'CB', 'Michigan',
    null, null, 81, null, null, 'HIGH', 'A', 'Elite',
    'Clean medical + length/speed profile typical of top-20 locks.',
    'Corner run risk in the teens still leaves multiple paths to Round 1.',
    'Injury rechecks or off-field noise could trigger a short slide.',
    null, null, null, 'yes', null, null, null, null,
    array['round1', 'high_confidence', 'position_props']
  ),
  (
    'de_nfl_team_pos_001', 2026, 'nfl', 'team_position', null, 'rj_harvey', 'RJ Harvey', 'RB', 'UCF',
    'Dallas Cowboys', 'DAL', 38, null, null, 'MED', 'B+', 'Starter upside',
    'Dallas has prioritized explosive skill players when OL is stable.',
    'Scheme fit as zone/gap hybrid complements existing WR room.',
    'RB positional value often pushes talent to Day 2 — Round 1 RB is inherently volatile.',
    null, null, null, null, 'DAL', 'RB', null, null,
    array['team_needs', 'position_props', 'round1']
  ),
  (
    'de_nfl_pos_first_001', 2026, 'nfl', 'position_first', null, 'tetairoa_mcmillan', 'Tetairoa McMillan', 'WR', 'Arizona',
    null, null, 44, 32, 56, 'MED', 'A', 'Blue chip',
    'WR class depth is strong but McMillan''s size/separation grade as the first off the board in most models.',
    'QB and Edge pushes create a narrow window for WR1 to be the first non-QB skill pick.',
    'Team trading up for OT/Edge could leapfrog the first WR.',
    null, null, null, null, null, null, 'WR', null,
    array['position_props', 'top10']
  ),
  (
    'de_nfl_exact_003', 2026, 'nfl', 'exact_pick', 3, 'abdul_carter', 'Abdul Carter', 'EDGE', 'Penn State',
    'Jacksonville Jaguars', 'JAX', 51, 40, 63, 'HIGH', 'A', 'Elite',
    'Jacksonville''s pass-rush profile benefits from a high-floor edge who can play early downs.',
    'Athletic testing matches the premium traits teams pay for in the top 5.',
    'If a QB run goes 1-2-3, Carter could slide one slot — monitor trade calls.',
    null, null, null, null, null, null, null, null,
    array['top10', 'round1', 'high_confidence']
  ),
  (
    'de_nfl_ou_002', 2026, 'nfl', 'position_ou', null, 'travis_hunter', 'Travis Hunter', 'CB / WR', 'Colorado',
    null, null, 55, null, null, 'LOW', 'A+', 'Elite',
    'Unique usage makes “true position” props noisy — draft slot variance is wider than typical prospects.',
    'Still the class''s highest-ceiling talent, so floor remains inside the top 5 in most sims.',
    'Historic outlier prospect — model uncertainty is higher than grades suggest.',
    1.5, 'UNDER', 1, null, null, null, null, null,
    array['position_props', 'top10']
  ),
  (
    'de_nfl_team_need_002', 2026, 'nfl', 'team_position', null, 'will_campbell', 'Will Campbell', 'OT', 'LSU',
    'Las Vegas Raiders', 'LV', 35, null, null, 'MED', 'A-', 'Blue chip',
    'Las Vegas''s OL investment cycle points to OT early if Carter/Hunter are gone.',
    'Campbell''s tape vs SEC speed rushers maps to NFL left tackle trials.',
    'Teams ahead may also target OT — board fall-through is possible.',
    null, null, null, null, 'LV', 'OT', null, null,
    array['team_needs', 'round1', 'top10']
  ),
  (
    'de_nfl_round_002', 2026, 'nfl', 'round_yes_no', null, 'quinn_ewers', 'Quinn Ewers', 'QB', 'Texas',
    null, null, 42, null, null, 'LOW', 'B', 'Development',
    'Tools are intriguing but inconsistency drives a wider round distribution than top QB prospects.',
    'Teams without immediate QB need may push him into Day 2 in many simulations.',
    'Late-process hype or a team falling in love could vault him into Round 1.',
    null, null, null, 'no', null, null, null, null,
    array['position_props']
  );
