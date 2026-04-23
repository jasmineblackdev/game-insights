/**
 * Declares which model inputs are **heuristic** vs backed by dedicated usage / event feeds.
 * Player props use ESPN-style trend aggregates (last5/season) and team pace — not live minutes, snap share, or event-level usage pipelines.
 *
 * @see docs/MODEL_ASSUMPTIONS.md
 */
export const PLAYER_PROP_MINUTES_OR_SNAP_MODEL = "heuristic_trend_pace_v1" as const;

/** Short line for tooltips / future UI — safe to surface without implying real tracking data. */
export function playerPropHeuristicDisclaimer(): string {
  return "Projections use trend + pace heuristics until minutes or snap feeds are wired.";
}
