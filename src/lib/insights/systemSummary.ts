/**
 * System Health summary — single aggregator for the /insights dashboard.
 *
 * Pulls four headline groups in parallel:
 *
 *   System Status (recent decision quality):
 *     • roi7d            — sum(pnl) / sum(stake) over last 7 days
 *     • hitRate7d        — wins / (wins + losses) over last 7 days
 *     • avgClvPp         — apples-to-apples CLV from analytics_clv_summary
 *     • sample7d         — total resolved bets in the 7-day window
 *
 *   Model Trust:
 *     • brierScore       — weighted-avg Brier across calibrated buckets
 *     • calibrationError — avg |residual| across same buckets
 *     • status           — "reliable" / "needs_data" / "unstable"
 *
 *   Data Health:
 *     • pendingCount     — predictions with outcome IS NULL
 *     • stalePending     — pending older than 48h
 *     • manualOverridePct — share of recommended_parlays where source
 *                           is user_manual or draftkings_manual
 *
 *   Sample warnings:
 *     • thinSample  — true when sample7d < 20
 *
 * Fail-soft: every leaf returns null on RPC error / missing migration so
 * the dashboard renders "—" placeholders instead of crashing.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { fetchClvSummary } from "@/lib/analytics/clv";

export type ModelTrustStatus = "reliable" | "needs_data" | "unstable";

export interface SystemSummary {
  // System status
  roi7d:        number | null;
  hitRate7d:    number | null;
  avgClvPp:     number | null;
  sample7d:     number;
  // Model trust
  brierScore:        number | null;
  calibrationError:  number | null;
  modelTrustStatus:  ModelTrustStatus;
  modelTrustSamples: number;
  // Data health
  pendingCount:        number;
  stalePending:        number;
  manualOverridePct:   number | null;
  totalRecommended:    number;
  // Meta
  thinSample: boolean;
}

const STALE_HOURS = 48;

/** Pull every metric in parallel; never throws — leaves blanks instead. */
export async function getSystemSummary(): Promise<SystemSummary> {
  if (!isSupabaseConfigured || !supabase) return blankSummary();

  const [systemStatus, modelTrust, dataHealth] = await Promise.all([
    fetchSystemStatus(),
    fetchModelTrust(),
    fetchDataHealth(),
  ]);

  const sample7d = systemStatus.sample7d;
  return {
    ...systemStatus,
    ...modelTrust,
    ...dataHealth,
    thinSample: sample7d > 0 && sample7d < 20,
  };
}

function blankSummary(): SystemSummary {
  return {
    roi7d: null,
    hitRate7d: null,
    avgClvPp: null,
    sample7d: 0,
    brierScore: null,
    calibrationError: null,
    modelTrustStatus: "needs_data",
    modelTrustSamples: 0,
    pendingCount: 0,
    stalePending: 0,
    manualOverridePct: null,
    totalRecommended: 0,
    thinSample: true,
  };
}

// ── System status ────────────────────────────────────────────────────

interface SystemStatusFields {
  roi7d:     number | null;
  hitRate7d: number | null;
  avgClvPp:  number | null;
  sample7d:  number;
}

async function fetchSystemStatus(): Promise<SystemStatusFields> {
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [clv, recentBets] = await Promise.all([
    fetchClvSummary(7).catch(() => null),
    fetchRecent7dBets(sevenDaysAgoIso).catch(() => []),
  ]);

  const won  = recentBets.filter((r) => r.outcome === "won").length;
  const lost = recentBets.filter((r) => r.outcome === "lost").length;
  const settled = recentBets.filter((r) => r.outcome === "won" || r.outcome === "lost" || r.outcome === "push");
  const stake  = settled.reduce((s, r) => s + numOrZero(r.user_stake), 0);
  const payout = settled.reduce((s, r) => s + numOrZero(r.user_payout), 0);
  const roi7d = stake > 0 ? ((payout - stake) / stake) * 100 : null;
  const hitRate7d = (won + lost) > 0 ? (won / (won + lost)) * 100 : null;

  return {
    roi7d,
    hitRate7d,
    avgClvPp: clv?.avgClvPp ?? null,
    sample7d: settled.length,
  };
}

interface RecentBetRow {
  outcome: string | null;
  user_stake: number | null;
  user_payout: number | null;
  recommended_at: string;
}

async function fetchRecent7dBets(sinceIso: string): Promise<RecentBetRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("recommended_parlays")
    .select("outcome, user_stake, user_payout, recommended_at")
    .gte("recommended_at", sinceIso)
    .limit(500);
  if (error || !data) return [];
  return data as RecentBetRow[];
}

// ── Model trust ──────────────────────────────────────────────────────

interface ModelTrustFields {
  brierScore:        number | null;
  calibrationError:  number | null;
  modelTrustStatus:  ModelTrustStatus;
  modelTrustSamples: number;
}

interface PlattBucketRow {
  sample_size: number | null;
  brier_score: number | null;
  log_loss: number | null;
}

async function fetchModelTrust(): Promise<ModelTrustFields> {
  if (!supabase) {
    return { brierScore: null, calibrationError: null, modelTrustStatus: "needs_data", modelTrustSamples: 0 };
  }
  const { data, error } = await supabase.rpc("analytics_platt_calibration_status");
  if (error || !data || !Array.isArray(data) || data.length === 0) {
    return { brierScore: null, calibrationError: null, modelTrustStatus: "needs_data", modelTrustSamples: 0 };
  }
  const rows = data as PlattBucketRow[];
  let weightedBrier = 0;
  let weightedLogLoss = 0;
  let totalWeight = 0;
  for (const r of rows) {
    const n = numOrZero(r.sample_size);
    const b = numOrNull(r.brier_score);
    const l = numOrNull(r.log_loss);
    if (n <= 0) continue;
    if (b != null) {
      weightedBrier += b * n;
      totalWeight += n;
    }
    if (l != null) {
      weightedLogLoss += l * n;
    }
  }
  const brierScore = totalWeight > 0 ? weightedBrier / totalWeight : null;
  // We don't have per-bucket calibration residual on this RPC. Use
  // log_loss as a proxy when present — both grow with miscalibration.
  const calibrationError = totalWeight > 0 ? weightedLogLoss / totalWeight : null;

  // Status thresholds:
  //   reliable    — Brier ≤ 0.22 and ≥ 200 weighted samples
  //   unstable    — Brier > 0.27 (worse than uniform random for binary
  //                 markets at decent confidence)
  //   needs_data  — anything else (default when N is thin)
  let status: ModelTrustStatus = "needs_data";
  if (brierScore != null) {
    if (brierScore > 0.27)                      status = "unstable";
    else if (brierScore <= 0.22 && totalWeight >= 200) status = "reliable";
  }
  return {
    brierScore,
    calibrationError,
    modelTrustStatus: status,
    modelTrustSamples: totalWeight,
  };
}

// ── Data health ──────────────────────────────────────────────────────

interface DataHealthFields {
  pendingCount:      number;
  stalePending:      number;
  manualOverridePct: number | null;
  totalRecommended:  number;
}

async function fetchDataHealth(): Promise<DataHealthFields> {
  if (!supabase) {
    return { pendingCount: 0, stalePending: 0, manualOverridePct: null, totalRecommended: 0 };
  }
  const staleCutoff = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  const [pendingAll, pendingStale, sourceCounts] = await Promise.all([
    supabase
      .from("recommended_parlays")
      .select("id", { count: "exact", head: true })
      .eq("outcome", "pending"),
    supabase
      .from("recommended_parlays")
      .select("id", { count: "exact", head: true })
      .eq("outcome", "pending")
      .lt("recommended_at", staleCutoff),
    fetchSourceCounts(),
  ]);

  const pendingCount = pendingAll.error ? 0 : (pendingAll.count ?? 0);
  const stalePending = pendingStale.error ? 0 : (pendingStale.count ?? 0);

  return {
    pendingCount,
    stalePending,
    manualOverridePct: sourceCounts.manualPct,
    totalRecommended:  sourceCounts.total,
  };
}

async function fetchSourceCounts(): Promise<{ manualPct: number | null; total: number }> {
  if (!supabase) return { manualPct: null, total: 0 };
  const [total, manual] = await Promise.all([
    supabase.from("recommended_parlays").select("id", { count: "exact", head: true }),
    supabase
      .from("recommended_parlays")
      .select("id", { count: "exact", head: true })
      .in("source", ["user_manual", "draftkings_manual"]),
  ]);
  const t = total.error ? 0 : (total.count ?? 0);
  const m = manual.error ? 0 : (manual.count ?? 0);
  if (t === 0) return { manualPct: null, total: 0 };
  return { manualPct: (m / t) * 100, total: t };
}

// ── Helpers ──────────────────────────────────────────────────────────

function numOrZero(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function modelTrustLabel(status: ModelTrustStatus): string {
  if (status === "reliable")   return "Reliable";
  if (status === "unstable")   return "Unstable";
  return "Needs data";
}

export function modelTrustToneClass(status: ModelTrustStatus): string {
  if (status === "reliable")
    return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (status === "unstable")
    return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
  return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
}
