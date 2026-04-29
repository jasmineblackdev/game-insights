/**
 * Shadow Pick Tracking — unified read-side abstraction over the
 * existing logging tables. The app already writes everything we need:
 *
 *   • prop_impressions          — every pick the user saw
 *   • picks_log                 — picks the user copied / took
 *   • parlay_leg_rejections     — picks the optimizer filtered out
 *   • prediction_history        — resolved outcomes for hit-rate / ROI
 *
 * This module classifies every generated prediction into one of six
 * categories without requiring a new write path:
 *
 *   1. RECOMMENDED_BET — shown with timing_urgency = 'bet_now' (or null)
 *   2. USER_TAKEN      — appears in picks_log
 *   3. USER_SKIPPED    — shown, game has started, never logged to picks_log
 *   4. FILTERED_OUT    — appears in parlay_leg_rejections
 *   5. MONITOR_ONLY    — shown with timing_urgency = 'monitor'
 *   6. PASS            — shown with timing_urgency = 'pass'
 *
 * The single-purpose async functions here are read-only and safe to call
 * from a useQuery hook on the dashboard.
 */

import { supabase } from "@/lib/supabase";

export type ShadowCategory =
  | "RECOMMENDED_BET"
  | "USER_TAKEN"
  | "USER_SKIPPED"
  | "FILTERED_OUT"
  | "MONITOR_ONLY"
  | "PASS";

export const SHADOW_CATEGORY_ORDER: ShadowCategory[] = [
  "RECOMMENDED_BET",
  "USER_TAKEN",
  "USER_SKIPPED",
  "MONITOR_ONLY",
  "PASS",
  "FILTERED_OUT",
];

export const SHADOW_CATEGORY_LABEL: Record<ShadowCategory, string> = {
  RECOMMENDED_BET: "Recommended Bet",
  USER_TAKEN:      "User Taken",
  USER_SKIPPED:    "User Skipped",
  MONITOR_ONLY:    "Monitor Only",
  PASS:            "Pass",
  FILTERED_OUT:    "Filtered Out",
};

export const SHADOW_CATEGORY_DESCRIPTION: Record<ShadowCategory, string> = {
  RECOMMENDED_BET: "Picks the engine surfaced as bet-now opportunities.",
  USER_TAKEN:      "Picks the user copied or marked as taken.",
  USER_SKIPPED:    "Picks the user saw but never bet (game already started).",
  MONITOR_ONLY:    "Picks downgraded to wait-and-watch by timing rules.",
  PASS:            "Picks the engine ultimately rejected after grading.",
  FILTERED_OUT:    "Picks the parlay optimizer's filters dropped before display.",
};

export interface ShadowSummaryRow {
  category:        ShadowCategory;
  generated_count: number;
  resolved_count:  number;
  win_count:       number;
  loss_count:      number;
  push_count:      number;
  hit_rate_pct:    number | null;
  est_roi_pct:     number | null;
}

export interface ShadowMissedRow {
  sport:        string;
  stat_type:    string | null;
  category:     ShadowCategory;
  reason:       string;
  edge:         number | null;
  ml_hit_prob:  number | null;
  confidence:   string | null;
  occurred_on:  string;
  player?:      string | null;
}

export interface ShadowFilterRow {
  rejection_reason: string;
  blocked_count:    number;
  high_conf_count:  number;
  avg_edge:         number | null;
  max_edge:         number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sinceISO(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function sinceDate(days: number): string {
  return sinceISO(days).slice(0, 10);
}

interface ImpressionRow {
  prop_id: string;
  sport: string | null;
  stat_type: string | null;
  timing_urgency: string | null;
  impression_date: string;
  game_time: string | null;
  edge: number | null;
  ml_hit_probability: number | null;
  confidence: string | null;
}

interface PickRow {
  prop_id: string;
  outcome: "win" | "loss" | "push" | null;
  created_at: string;
}

interface RejectionRow {
  candidate_id: string;
  sport: string | null;
  stat_type: string | null;
  rejection_reason: string;
  edge: number | null;
  ml_hit_probability: number | null;
  confidence: string | null;
  rejection_date: string;
  selection: string | null;
}

// ── 1. Per-category summary ──────────────────────────────────────────────────

export async function fetchShadowSummary(windowDays = 30): Promise<ShadowSummaryRow[]> {
  if (!supabase) return [];
  const sinceDay = sinceDate(windowDays);
  const sinceTs  = sinceISO(windowDays);

  const [impRes, pickRes, rejRes] = await Promise.all([
    supabase
      .from("prop_impressions")
      .select("prop_id, timing_urgency, impression_date, game_time")
      .gte("impression_date", sinceDay)
      .limit(10_000),
    supabase
      .from("picks_log")
      .select("prop_id, outcome, created_at")
      .gte("created_at", sinceTs)
      .limit(10_000),
    supabase
      .from("parlay_leg_rejections")
      .select("candidate_id, rejection_date")
      .gte("rejection_date", sinceDay)
      .limit(10_000),
  ]);

  const impressions = (impRes.data ?? []) as Pick<ImpressionRow,
    "prop_id" | "timing_urgency" | "impression_date" | "game_time">[];
  const picks       = (pickRes.data ?? []) as PickRow[];
  const rejections  = (rejRes.data ?? []) as Pick<RejectionRow, "candidate_id" | "rejection_date">[];

  const pickByProp = new Map<string, PickRow>();
  for (const p of picks) pickByProp.set(p.prop_id, p);

  const counts: Record<ShadowCategory, ShadowSummaryRow> = Object.fromEntries(
    SHADOW_CATEGORY_ORDER.map((c) => [c, {
      category: c, generated_count: 0, resolved_count: 0,
      win_count: 0, loss_count: 0, push_count: 0,
      hit_rate_pct: null, est_roi_pct: null,
    }]),
  ) as Record<ShadowCategory, ShadowSummaryRow>;

  const now = Date.now();

  function tally(cat: ShadowCategory, propId?: string) {
    const row = counts[cat];
    row.generated_count += 1;
    if (propId) {
      const pick = pickByProp.get(propId);
      if (pick?.outcome) {
        row.resolved_count += 1;
        if (pick.outcome === "win")  row.win_count++;
        if (pick.outcome === "loss") row.loss_count++;
        if (pick.outcome === "push") row.push_count++;
      }
    }
  }

  for (const imp of impressions) {
    const urgency = imp.timing_urgency ?? "bet_now";
    if (urgency === "monitor") tally("MONITOR_ONLY", imp.prop_id);
    else if (urgency === "pass") tally("PASS", imp.prop_id);
    else tally("RECOMMENDED_BET", imp.prop_id);

    // USER_SKIPPED: game has started and the user never logged it.
    const gameStart = imp.game_time ? Date.parse(imp.game_time) : NaN;
    if (Number.isFinite(gameStart) && gameStart < now && !pickByProp.has(imp.prop_id)) {
      tally("USER_SKIPPED", imp.prop_id);
    }
  }
  for (const p of picks)      tally("USER_TAKEN", p.prop_id);
  for (const r of rejections) tally("FILTERED_OUT", r.candidate_id);

  // Derive rate + ROI per category.
  for (const cat of SHADOW_CATEGORY_ORDER) {
    const row = counts[cat];
    const decided = row.win_count + row.loss_count;
    if (decided > 0) {
      row.hit_rate_pct = Math.round((row.win_count / decided) * 1000) / 10;
      // Flat -110 stake assumption: +0.91 per win, -1 per loss.
      row.est_roi_pct = Math.round(((0.91 * row.win_count - row.loss_count) / decided) * 1000) / 10;
    }
  }

  return SHADOW_CATEGORY_ORDER.map((c) => counts[c]);
}

// ── 2. Best missed opportunities ─────────────────────────────────────────────

export async function fetchShadowMissedOpportunities(
  windowDays = 30,
  minEdge = 0.04,
  limit = 20,
): Promise<ShadowMissedRow[]> {
  if (!supabase) return [];
  const sinceDay = sinceDate(windowDays);

  const [rejRes, impRes] = await Promise.all([
    supabase
      .from("parlay_leg_rejections")
      .select("candidate_id, sport, stat_type, rejection_reason, edge, ml_hit_probability, confidence, rejection_date, selection")
      .gte("rejection_date", sinceDay)
      .gte("edge", minEdge)
      .order("edge", { ascending: false })
      .limit(limit),
    supabase
      .from("prop_impressions")
      .select("prop_id, sport, stat_type, edge, ml_hit_probability, confidence, timing_urgency, impression_date")
      .gte("impression_date", sinceDay)
      .gte("edge", minEdge)
      .in("timing_urgency", ["monitor", "pass"])
      .order("edge", { ascending: false })
      .limit(limit),
  ]);

  const out: ShadowMissedRow[] = [];

  for (const r of (rejRes.data ?? []) as RejectionRow[]) {
    out.push({
      sport: r.sport ?? "—",
      stat_type: r.stat_type,
      category: "FILTERED_OUT",
      reason: r.rejection_reason,
      edge: r.edge,
      ml_hit_prob: r.ml_hit_probability,
      confidence: r.confidence,
      occurred_on: r.rejection_date,
      player: r.selection,
    });
  }

  for (const i of (impRes.data ?? []) as (ImpressionRow & { prop_id: string })[]) {
    out.push({
      sport: i.sport ?? "—",
      stat_type: i.stat_type,
      category: i.timing_urgency === "monitor" ? "MONITOR_ONLY" : "PASS",
      reason: "timing_downgrade",
      edge: i.edge,
      ml_hit_prob: i.ml_hit_probability,
      confidence: i.confidence,
      occurred_on: i.impression_date,
    });
  }

  return out
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
    .slice(0, limit);
}

// ── 3. Filter strictness audit ───────────────────────────────────────────────

export async function fetchShadowFilterStrictness(windowDays = 30): Promise<ShadowFilterRow[]> {
  if (!supabase) return [];
  const sinceDay = sinceDate(windowDays);
  const { data } = await supabase
    .from("parlay_leg_rejections")
    .select("rejection_reason, edge, confidence")
    .gte("rejection_date", sinceDay)
    .limit(10_000);

  const rows = (data ?? []) as Pick<RejectionRow, "rejection_reason" | "edge" | "confidence">[];
  const map = new Map<string, { n: number; hc: number; edges: number[] }>();
  for (const r of rows) {
    const e = map.get(r.rejection_reason) ?? { n: 0, hc: 0, edges: [] as number[] };
    e.n++;
    if (r.confidence === "HIGH") e.hc++;
    if (r.edge != null) e.edges.push(r.edge);
    map.set(r.rejection_reason, e);
  }
  return [...map.entries()]
    .filter(([, v]) => v.n >= 3)
    .map(([reason, v]) => ({
      rejection_reason: reason,
      blocked_count: v.n,
      high_conf_count: v.hc,
      avg_edge: v.edges.length ? Math.round((v.edges.reduce((s, x) => s + x, 0) / v.edges.length) * 10000) / 10000 : null,
      max_edge: v.edges.length ? Math.round(Math.max(...v.edges) * 10000) / 10000 : null,
    }))
    .sort((a, b) => b.high_conf_count - a.high_conf_count || (b.max_edge ?? 0) - (a.max_edge ?? 0));
}
