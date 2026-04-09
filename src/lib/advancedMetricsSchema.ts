/**
 * Documented JSON keys for `advanced_team_metrics.metrics` / related tables.
 * ETL jobs should populate these; the client layer reads them optionally.
 *
 * Soccer: team_xg_for, team_xg_against, shots_on_target_avg, possession_percentage,
 *         pressing_intensity, expected_assists_avg, dangerous_attacks_avg,
 *         fixture_congestion_games_7d, travel_km_last_7d (optional)
 *
 * NFL: qb_pressure_rate_allowed, receiver_separation_index, offensive_efficiency_trend,
 *      defensive_matchup_strength, red_zone_td_rate, third_down_rate, pace_plays_per_game
 *
 * NBA: true_shooting_pct, usage_stability_score, lineup_net_rating_proxy,
 *      defensive_matchup_difficulty, pace_factor, bench_net_rating
 *
 * MLB: barrel_rate, hard_hit_rate, pitcher_k_rate_trend, xba_allowed_proxy,
 *      bullpen_reliability_score, pitch_quality_index (optional scalars 0–1 or rates)
 */

export type AdvancedMetricsRow = {
  team_id: string;
  metrics: Record<string, unknown>;
  confidence_adjustment_weight?: number | null;
};
