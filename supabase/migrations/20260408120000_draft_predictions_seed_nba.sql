-- Seed NBA 2026 Draft Edge cards (mirrors `DRAFT_EDGE_MOCK_NBA`).

insert into public.draft_predictions (
  external_id, year, league, card_kind, pick_number, player_id, player_name, position, college,
  predicted_team, predicted_team_abbr, probability, prob_low, prob_high, confidence, grade, tier,
  reason_1, reason_2, risk_factor, ou_line, ou_prediction, projected_pick, round_prediction,
  team_target_abbr, team_need_position, first_position_label, mover_note, tags
) values
  (
    'de_nba_exact_001', 2026, 'nba', 'exact_pick', 1, 'aj_dybantsa', 'AJ Dybantsa', 'SG / SF', 'BYU',
    'San Antonio Spurs', 'SAS', 68, 58, 78, 'HIGH', 'A+', 'Elite',
    $$Spurs slot + creation vacuum aligns with the class's clearest shot-making alpha at 6'9".$$,
    $$Consensus #1 on most boards; positional value (big wing creator) holds even in trade-down sims.$$,
    $$Medical rediscovery or a surprise trade package from a team moving up for a guard could reshuffle 1–2.$$,
    null, null, null, null, null, null, null, null,
    array['top10', 'round1', 'high_confidence']
  ),
  (
    'de_nba_exact_002', 2026, 'nba', 'exact_pick', 2, 'ace_bailey', 'Ace Bailey', 'SF', 'Rutgers',
    'Washington Wizards', 'WAS', 54, 42, 66, 'HIGH', 'A', 'Blue chip',
    $$Washington's rebuild arc points to a high-usage wing who can score in the mid-range and grow defensively.$$,
    $$Mocks cluster Bailey 2–4; Wizards' need profile wins tiebreaks vs Detroit in most team-need models.$$,
    $$Detroit or Portland trading up—or falling in love with Harper—could bump this slot.$$,
    null, null, null, null, null, null, null,
    $$WAS–Bailey linkage gained steam after combine measurements confirmed wing length.$$,
    array['top10', 'round1', 'high_confidence', 'mover']
  ),
  (
    'de_nba_ou_001', 2026, 'nba', 'position_ou', null, 'dylan_harper', 'Dylan Harper', 'PG / SG', 'Rutgers',
    null, null, null, 52, 74, 'MED', 'A', 'Blue chip',
    $$Multiple lottery teams need primary creation; slide past 4 is rare in sims without injury noise.$$,
    $$Size–skill combo for a guard keeps him inside the top 5 on consensus big boards.$$,
    $$A surprise first overall bet on a wing could push Harper to 5–7 in trade-heavy drafts.$$,
    4.5, 'UNDER', 3, null, null, null, null,
    $$Draft slot prop steamed slightly toward Under after team interviews leaked positively.$$,
    array['position_props', 'top10', 'mover']
  ),
  (
    'de_nba_round_001', 2026, 'nba', 'round_yes_no', null, 'kon_knueppel', 'Kon Knueppel', 'SG / SF', 'Duke',
    null, null, 84, null, null, 'HIGH', 'A-', 'High floor',
    $$Elite shooting + NBA body gives one of the safest top-20 profiles in the class.$$,
    $$Even in weak-team scenarios, floor-spacing wings rarely slip out of the first 30 picks.$$,
    $$Medical flags or a sharp shooting slump in private workouts could widen his range.$$,
    null, null, null, 'yes', null, null, null, null,
    array['round1', 'high_confidence', 'position_props']
  ),
  (
    'de_nba_team_pos_001', 2026, 'nba', 'team_position', null, 'egor_demin', 'Egor Demin', 'PG / SG', 'BYU',
    'Toronto Raptors', 'TOR', 36, null, null, 'MED', 'B+', 'Connector',
    $$Toronto has prioritized jumbo initiators who can run pick-and-roll and hit movement shooters.$$,
    $$Demin's size–passing intersection fits the modern Raptors build more than another pure wing.$$,
    $$If a higher-rated wing falls, front office could pivot off pure PG need.$$,
    null, null, null, null, 'TOR', 'PG', null, null,
    array['team_needs', 'round1', 'top10']
  ),
  (
    'de_nba_pos_first_001', 2026, 'nba', 'position_first', null, 'noa_essengue', 'Noa Essengue', 'SF / PF', 'Ratiopharm Ulm (Ignite)',
    null, null, 41, 28, 54, 'MED', 'B+', 'Upside',
    $$In "first big drafted" markets, his physical tools separate from the college-forward cluster.$$,
    $$Teams picking late lottery often swing on length + switchability earlier than pure shooting fours.$$,
    $$A surprise early run on centers could jump the first PF off the board before Essengue.$$,
    null, null, null, null, null, null, 'PF', null,
    array['position_props', 'top10']
  ),
  (
    'de_nba_exact_003', 2026, 'nba', 'exact_pick', 3, 'dylan_harper', 'Dylan Harper', 'PG / SG', 'Rutgers',
    'Detroit Pistons', 'DET', 49, 38, 61, 'HIGH', 'A', 'Blue chip',
    $$Detroit's timeline pairs with a big guard who can collapse defenses next to their core.$$,
    $$If Dybantsa/Bailey go 1–2, Harper becomes the cleanest "best player available" at 3.$$,
    $$Portland could prioritize a different archetype if their medical staff prefers another prospect.$$,
    null, null, null, null, null, null, null, null,
    array['top10', 'round1', 'high_confidence']
  ),
  (
    'de_nba_ou_002', 2026, 'nba', 'position_ou', null, 'aj_dybantsa', 'AJ Dybantsa', 'SG / SF', 'BYU',
    null, null, 58, null, null, 'LOW', 'A+', 'Elite',
    $$Generational prospects still carry "any top-3 slot" variance when teams shop picks.$$,
    $$Spurs remain the modal landing spot, but trade simulations add fat tails to pick 1.$$,
    $$Historic talent — market and smokescreen volume create wider true ranges than grades imply.$$,
    1.5, 'UNDER', 1, null, null, null, null, null,
    array['position_props', 'top10']
  ),
  (
    'de_nba_team_need_002', 2026, 'nba', 'team_position', null, 'carter_bryant', 'Carter Bryant', 'SF / PF', 'Arizona',
    'Charlotte Hornets', 'CHA', 33, null, null, 'MED', 'B+', '3&D upside',
    $$Charlotte's wing depth chart invites another long defender who can grow into spot-up volume.$$,
    $$Bryant's athletic profile maps to switch schemes the Hornets have drafted toward recently.$$,
    $$If a higher-rated wing slips, Charlotte could pass on duplication at the position.$$,
    null, null, null, null, 'CHA', 'SF', null, null,
    array['team_needs', 'round1', 'top10']
  ),
  (
    'de_nba_round_002', 2026, 'nba', 'round_yes_no', null, 'tre_johnson', 'Tre Johnson', 'SG', 'Texas',
    null, null, 56, null, null, 'MED', 'B', 'Bucket',
    $$Pure scoring guards with defensive questions often land late first or early second in models.$$,
    $$NOP's roster crunch could push a "best talent" bet if he interviews as a microwave sixth man.$$,
    $$A team starved for offense could reach earlier than consensus, vaulting him into the 20s.$$,
    null, null, null, 'yes', null, null, null, null,
    array['position_props', 'round1']
  )
on conflict (external_id) do nothing;
