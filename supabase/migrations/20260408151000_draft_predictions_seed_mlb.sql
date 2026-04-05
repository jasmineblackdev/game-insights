-- Seed MLB 2026 Draft Edge cards (mirrors `DRAFT_EDGE_MOCK_MLB`).

insert into public.draft_predictions (
  external_id, year, league, card_kind, pick_number, player_id, player_name, position, college,
  predicted_team, predicted_team_abbr, probability, prob_low, prob_high, confidence, grade, tier,
  reason_1, reason_2, risk_factor, ou_line, ou_prediction, projected_pick, round_prediction,
  team_target_abbr, team_need_position, first_position_label, mover_note, tags
) values
  (
    'de_mlb_exact_001', 2026, 'mlb', 'exact_pick', 1, 'tyler_brennan', 'Tyler Brennan', 'RHP', 'LSU',
    'Washington Nationals', 'WSH', 61, 50, 72, 'HIGH', 'A+', 'Frontline upside',
    $$College ace profile with plus velo and improved secondaries fits the modern 1-1 archetype.$$,
    $$Team need models at the top favor pitching after last year's bat-heavy class in many orgs.$$,
    $$Bonus demand or a last-minute medical review could trigger a brief negotiation slide.$$,
    null, null, null, null, null, null, null, null,
    array['top10', 'round1', 'high_confidence']
  ),
  (
    'de_mlb_exact_002', 2026, 'mlb', 'exact_pick', 2, 'marcus_vega', 'Marcus Vega', 'SS', 'Texas',
    'Seattle Mariners', 'SEA', 48, 36, 60, 'HIGH', 'A', 'Elite stick',
    $$Seattle's pipeline lean and big-market timeline point to a premium shortstop who can move fast.$$,
    $$Defensive certainty at SS reduces variance vs toolsy outfielders in the 2–4 cluster.$$,
    $$If an underslot college bat deal emerges, Seattle could pivot for pool flexibility.$$,
    null, null, null, null, null, null, null,
    $$SEA–SS linkage rose after area scout notes emphasized quick-to-AAA profile.$$,
    array['top10', 'round1', 'high_confidence', 'mover']
  ),
  (
    'de_mlb_ou_001', 2026, 'mlb', 'position_ou', null, 'ethan_parks', 'Ethan Parks', 'OF', 'Florida',
    null, null, null, 48, 71, 'MED', 'A-', 'Five-tool',
    $$Athletic outfielders with SEC performance tend to land inside the top 8 unless bonus games emerge.$$,
    $$Multiple teams picking 3–7 have outfield as a stated depth-chart gap in public intel.$$,
    $$College bat cold streaks in postseason play can move draft slot props quickly.$$,
    7.5, 'UNDER', 5, null, null, null, null,
    $$O/U 7.5 steamed Under after PG showcase week.$$,
    array['position_props', 'top10', 'mover']
  ),
  (
    'de_mlb_round_001', 2026, 'mlb', 'round_yes_no', null, 'jake_morales', 'Jake Morales', 'C', 'Virginia',
    null, null, 77, null, null, 'HIGH', 'A-', 'Defense-first',
    $$Catchers who receive plus and hit enough to start rarely escape Round 1 in recent classes.$$,
    $$Team demand for cheap big-league catching pushes safe profiles up boards.$$,
    $$Shoulder fatigue rumors—if they linger—are the classic catcher slide catalyst.$$,
    null, null, null, 'yes', null, null, null, null,
    array['round1', 'high_confidence', 'position_props']
  ),
  (
    'de_mlb_team_pos_001', 2026, 'mlb', 'team_position', null, 'ryan_caldwell', 'Ryan Caldwell', 'RHP', 'Wake Forest',
    'New York Yankees', 'NYY', 31, null, null, 'MED', 'B+', 'Relief/starter',
    $$Yankees have repeatedly targeted power arms who can miss bats in the first 40 picks.$$,
    $$Caldwell's fastball shape grades as an easy pro translation even if role is hybrid early.$$,
    $$Signing-bonus math at the top of the board could force an underslot pivot away from arms.$$,
    null, null, null, null, 'NYY', 'RHP', null, null,
    array['team_needs', 'round1', 'top10']
  ),
  (
    'de_mlb_pos_first_001', 2026, 'mlb', 'position_first', null, 'tyler_brennan', 'Tyler Brennan', 'RHP', 'LSU',
    null, null, 52, 40, 64, 'MED', 'A+', 'Frontline upside',
    $$In "first pitcher drafted" markets, the safest college ace typically clears the prep variance tax.$$,
    $$Multiple teams in the top 5 are openly hunting innings, not just upside lotto tickets.$$,
    $$A prep arm popping 100 mph late could leapfrog the first college arm in chaotic sims.$$,
    null, null, null, null, null, null, 'RHP', null,
    array['position_props', 'top10']
  ),
  (
    'de_mlb_exact_003', 2026, 'mlb', 'exact_pick', 5, 'ethan_parks', 'Ethan Parks', 'OF', 'Florida',
    'Colorado Rockies', 'COL', 44, 33, 55, 'MED', 'A-', 'Five-tool',
    $$Colorado's outfield pipeline and park factors make a premium defensive center fielder a clean fit.$$,
    $$Slot value models often land on the best athlete available when college performance is stable.$$,
    $$Rockies could go underslot for pool if a pre-draft deal emerges with another prospect.$$,
    null, null, null, null, null, null, null, null,
    array['top10', 'round1']
  ),
  (
    'de_mlb_ou_002', 2026, 'mlb', 'position_ou', null, 'marcus_vega', 'Marcus Vega', 'SS', 'Texas',
    null, null, 51, null, null, 'LOW', 'A', 'Elite stick',
    $$Top-5 infielders carry wider slot/trade variance than outfield arms in the same tier.$$,
    $$Still, consensus rarely lets a true SS with this profile escape the top 6.$$,
    $$Bonus pool gymnastics at 1–3 can shove premium bats down a slot artificially.$$,
    3.5, 'UNDER', 2, null, null, null, null, null,
    array['position_props', 'top10']
  ),
  (
    'de_mlb_team_need_002', 2026, 'mlb', 'team_position', null, 'liam_bridges', 'Liam Bridges', '3B', 'TCU',
    'Texas Rangers', 'TEX', 28, null, null, 'MED', 'B+', 'Power bat',
    $$Texas has cycled corner bats through the system; a college masher with track record fits the window.$$,
    $$Bridges' exit velo data grades as an easy carry into pro ball despite swing-and-miss risk.$$,
    $$If Texas goes pitching-heavy early, they could pass on another corner profile.$$,
    null, null, null, null, 'TEX', '3B', null, null,
    array['team_needs', 'round1']
  ),
  (
    'de_mlb_round_002', 2026, 'mlb', 'round_yes_no', null, 'chris_lang', 'Chris Lang', 'LHP', 'Oregon State',
    null, null, 38, null, null, 'LOW', 'B', 'Command',
    $$Safe lefty starters without plus velo often slip to Day 2 when teams chase ceiling.$$,
    $$Still, teams hunting fast-to-MLB innings sometimes buy late first on command profiles.$$,
    $$Velocity uptick in bullpens before the draft could rocket him into the 20s.$$,
    null, null, null, 'no', null, null, null, null,
    array['position_props']
  )
on conflict (external_id) do nothing;
