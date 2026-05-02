/**
 * Closing Line Value analytics — client fetchers.
 *
 * Reads four RPCs added in migration 20260511000000_analytics_clv.sql.
 * All RPCs apply the same apples-to-apples filter: only rows where
 * line data is missing on both sides (team markets) OR where entry
 * line equals closing line are counted toward CLV metrics. Drifted-
 * line rows are reported separately so they don't pollute the
 * headline.
 *
 * Fail-soft: every fetcher returns null on error / missing config so
 * the dashboard can render a "data unavailable" panel instead of
 * crashing the page.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";

export interface ClvSummary {
  totalWithClv: number;
  beatingClose: number;
  pctBeatingClose: number | null;
  avgClvPp: number | null;
  medianClvPp: number | null;
  total7d: number;
  pctBeatingClose7d: number | null;
  avgClvPp7d: number | null;
  totalDrifted: number;
  avgClvPpDrifted: number | null;
}

export interface ClvBreakdownRow {
  key: string;             // sport, market, or "sport · market"
  n: number;
  beatingClose: number;
  pctBeatingClose: number | null;
  avgClvPp: number | null;
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

export async function fetchClvSummary(lookbackDays = 30): Promise<ClvSummary | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.rpc("analytics_clv_summary", {
    lookback_days: lookbackDays,
  });
  if (error || !data || !Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as Record<string, unknown>;
  return {
    totalWithClv:       num(r.total_with_clv),
    beatingClose:       num(r.beating_close),
    pctBeatingClose:    numOrNull(r.pct_beating_close),
    avgClvPp:           numOrNull(r.avg_clv_pp),
    medianClvPp:        numOrNull(r.median_clv_pp),
    total7d:            num(r.total_7d),
    pctBeatingClose7d:  numOrNull(r.pct_beating_close_7d),
    avgClvPp7d:         numOrNull(r.avg_clv_pp_7d),
    totalDrifted:       num(r.total_drifted),
    avgClvPpDrifted:    numOrNull(r.avg_clv_pp_drifted),
  };
}

async function fetchBreakdown(
  rpc: "analytics_clv_by_sport" | "analytics_clv_by_market",
  lookbackDays: number,
  keyField: "sport" | "market_type",
): Promise<ClvBreakdownRow[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc(rpc, { lookback_days: lookbackDays });
  if (error || !data || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    key:             String(r[keyField] ?? ""),
    n:               num(r.n),
    beatingClose:    num(r.beating_close),
    pctBeatingClose: numOrNull(r.pct_beating_close),
    avgClvPp:        numOrNull(r.avg_clv_pp),
  }));
}

export const fetchClvBySport = (lookbackDays = 30) =>
  fetchBreakdown("analytics_clv_by_sport", lookbackDays, "sport");

export const fetchClvByMarket = (lookbackDays = 30) =>
  fetchBreakdown("analytics_clv_by_market", lookbackDays, "market_type");

export async function fetchClvBySportMarket(lookbackDays = 30): Promise<ClvBreakdownRow[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc("analytics_clv_by_sport_market", {
    lookback_days: lookbackDays,
  });
  if (error || !data || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    key:             `${r.sport ?? ""} · ${r.market_type ?? ""}`,
    n:               num(r.n),
    beatingClose:    num(r.beating_close),
    pctBeatingClose: numOrNull(r.pct_beating_close),
    avgClvPp:        numOrNull(r.avg_clv_pp),
  }));
}

// ── Per-pick CLV result bucket (#169) ────────────────────────────────

/**
 * Distribution of clv_result values across every prediction in the
 * window. Five buckets:
 *   beat_close     — apples-to-apples row with clv_pp > 0
 *   lost_to_close  — apples-to-apples row with clv_pp < 0
 *   same           — apples-to-apples row with abs(clv_pp) < 0.01
 *   line_changed   — line drifted between entry and close (separate
 *                    cohort so it doesn't inflate the headline beat
 *                    rate)
 *   unavailable    — clv_pp missing OR partial-line cohort
 *
 * Source: analytics_clv_results_summary RPC (migration 20260515).
 * Fail-soft: returns null on RPC error / migration not applied.
 */
export interface ClvResultsSummary {
  total: number;
  beatClose: number;
  lostToClose: number;
  same: number;
  lineChanged: number;
  unavailable: number;
  /** Headline beat-rate, restricted to apples-to-apples rows. */
  pctBeatCloseApples: number | null;
  /** Beat-rate inside the line_changed cohort, for comparison. */
  pctBeatCloseDrifted: number | null;
}

export interface ClvResultsBySportRow {
  sport: string;
  total: number;
  beatClose: number;
  lostToClose: number;
  same: number;
  lineChanged: number;
  unavailable: number;
}

export async function fetchClvResultsSummary(lookbackDays = 30): Promise<ClvResultsSummary | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  const { data, error } = await supabase.rpc("analytics_clv_results_summary", {
    lookback_days: lookbackDays,
  });
  if (error || !data || !Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as Record<string, unknown>;
  return {
    total:               num(r.total),
    beatClose:           num(r.beat_close),
    lostToClose:         num(r.lost_to_close),
    same:                num(r.same),
    lineChanged:         num(r.line_changed),
    unavailable:         num(r.unavailable),
    pctBeatCloseApples:  numOrNull(r.pct_beat_close_apples),
    pctBeatCloseDrifted: numOrNull(r.pct_beat_close_drifted),
  };
}

export async function fetchClvResultsBySport(lookbackDays = 30): Promise<ClvResultsBySportRow[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc("analytics_clv_results_by_sport", {
    lookback_days: lookbackDays,
  });
  if (error || !data || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    sport:        String(r.sport ?? ""),
    total:        num(r.total),
    beatClose:    num(r.beat_close),
    lostToClose:  num(r.lost_to_close),
    same:         num(r.same),
    lineChanged:  num(r.line_changed),
    unavailable:  num(r.unavailable),
  }));
}

/**
 * 7-day vs 30-day trend direction. Positive deltaPct = improving.
 * Returns null when either window is too thin to compare.
 */
export function clvTrendDirection(
  s: ClvSummary | null,
): { dir: "up" | "down" | "flat" | "thin"; deltaPct: number | null } {
  if (!s) return { dir: "thin", deltaPct: null };
  if (s.total7d < 5 || s.totalWithClv < 20) return { dir: "thin", deltaPct: null };
  const a = s.pctBeatingClose7d ?? 0;
  const b = s.pctBeatingClose ?? 0;
  const delta = a - b;
  if (delta >= 5) return { dir: "up", deltaPct: delta };
  if (delta <= -5) return { dir: "down", deltaPct: delta };
  return { dir: "flat", deltaPct: delta };
}
