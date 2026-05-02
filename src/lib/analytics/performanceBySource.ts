/**
 * Performance by source — client fetcher for the User vs System
 * panel on Insights → System Health.
 *
 * Reads `analytics_performance_by_source` (migration 20260517).
 * Returns one row per origin category with ROI / hit rate / CLV.
 *
 * Categories (in display order):
 *   system_recommended — AI-generated parlay rows
 *   auto_plan          — paper bet from Today's Decision hand-off
 *   manual_user        — user-typed paper bet
 *   live_paper         — paper bet placed in-game
 *   paper_test         — user-entered rec_parlays (legacy/manual)
 *
 * CLV is null for the three paper-bets-backed categories until the
 * paper→prediction_history bridge ships under #164. The UI renders
 * a "—" placeholder rather than a 0 so it's clear the data is
 * missing, not zero.
 *
 * Fail-soft: returns empty array on RPC error / missing config so
 * the dashboard can show a graceful unavailable state.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export type PerformanceCategory =
  | "manual_user"
  | "auto_plan"
  | "system_recommended"
  | "paper_test"
  | "live_paper";

export interface PerformanceBySourceRow {
  category: PerformanceCategory;
  total: number;
  resolved: number;
  won: number;
  lost: number;
  push: number;
  hitRatePct: number | null;
  totalStake: number;
  totalPnl: number;
  roiPct: number | null;
  clvSample: number;
  clvPpAvg: number | null;
  pctBeatClose: number | null;
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchPerformanceBySource(
  lookbackDays = 30,
): Promise<PerformanceBySourceRow[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc("analytics_performance_by_source", {
    lookback_days: lookbackDays,
  });
  if (error || !data || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    category:     String(r.category ?? "manual_user") as PerformanceCategory,
    total:        num(r.total),
    resolved:     num(r.resolved),
    won:          num(r.won),
    lost:         num(r.lost),
    push:         num(r.push),
    hitRatePct:   numOrNull(r.hit_rate_pct),
    totalStake:   num(r.total_stake),
    totalPnl:     num(r.total_pnl),
    roiPct:       numOrNull(r.roi_pct),
    clvSample:    num(r.clv_sample),
    clvPpAvg:     numOrNull(r.clv_pp_avg),
    pctBeatClose: numOrNull(r.pct_beat_close),
  }));
}

export const PERFORMANCE_CATEGORY_LABELS: Record<PerformanceCategory, string> = {
  system_recommended: "System recs",
  auto_plan:          "Auto-plan",
  manual_user:        "Manual user",
  live_paper:         "Live paper",
  paper_test:         "Paper test",
};

export const PERFORMANCE_CATEGORY_DESCRIPTIONS: Record<PerformanceCategory, string> = {
  system_recommended: "AI-generated parlays surfaced by the app.",
  auto_plan:          "Paper bets from Today's Decision → Track as Paper Bet.",
  manual_user:        "Paper bets you typed in by hand.",
  live_paper:         "Paper bets placed in-game (live tracker).",
  paper_test:         "Manual rows logged into the recommended_parlays surface.",
};
