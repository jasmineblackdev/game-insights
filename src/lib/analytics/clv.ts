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
