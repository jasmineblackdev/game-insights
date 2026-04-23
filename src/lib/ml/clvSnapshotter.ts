/**
 * Closing-line value snapshotter.
 *
 * For each candidate that matches a recent prediction_history row, records
 * the current American odds into prediction_clv_snapshots once the game is
 * within CLV_SNAP_WINDOW_MIN minutes of starting. The edge function /
 * analytics RPCs treat the latest snap_at per prediction as the closing
 * line, compute clv_pp vs the opening_line_american, and drive CLV-ranked
 * learning insights.
 *
 * Fire-and-forget from the parlay builder / prop UI — session-deduped so
 * each (prediction_id, snap bucket) only writes once per page load.
 */

import { supabase } from "@/lib/supabase";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

/** How close to game start we consider a snapshot "closing". */
const CLV_SNAP_WINDOW_MIN = 15;

/** Session-local guard so a single render pass doesn't spam the DB. */
const seen = new Set<string>();

/** Best-effort parse of "7:30 PM ET" into a minutes-from-now offset. */
function minutesToStart(gameTimeLabel: string | undefined): number | null {
  if (!gameTimeLabel) return null;
  const m = gameTimeLabel.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const hh12 = parseInt(m[1], 10);
  const mm   = parseInt(m[2], 10);
  const isPm = m[3].toUpperCase() === "PM";
  const hh24 = (hh12 % 12) + (isPm ? 12 : 0);

  const now = new Date();
  const eastern = new Date(
    now.toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const gameStart = new Date(eastern);
  gameStart.setHours(hh24, mm, 0, 0);

  // If game time already passed today by more than 4h, assume tomorrow
  const diffMin = Math.round((gameStart.getTime() - now.getTime()) / 60_000);
  if (diffMin < -240) return diffMin + 24 * 60;
  return diffMin;
}

/**
 * Snapshot odds for candidates whose game is inside the CLV window.
 * Fire-and-forget — never throws.
 */
export async function snapshotClvForCandidates(
  candidates: ValueBetCandidate[],
): Promise<void> {
  if (!supabase || !candidates.length) return;

  const rows: Record<string, unknown>[] = [];
  for (const c of candidates) {
    const mtfs = minutesToStart(c.gameTimeLabel);
    // Snap once inside the window, and once at T+0 to capture the actual close.
    // Anything older is ignored (post-start in-play lines would be noise).
    if (mtfs == null) continue;
    if (mtfs > CLV_SNAP_WINDOW_MIN || mtfs < -1) continue;

    // Dedup bucket: per 5-minute window, so we can capture an opening snap
    // and a closing snap without spamming between them.
    const bucket = Math.floor(mtfs / 5);
    const dedupKey = `${c.id}:${bucket}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    rows.push({
      prediction_id:    c.id,
      sport:            String(c.sport).toLowerCase(),
      market_type:      c.marketType,
      american_odds:    c.americanOdds,
      minutes_to_start: mtfs,
      sportsbook_key:   c.sportsbookKey ?? null,
    });
  }

  if (!rows.length) return;
  try {
    await supabase.from("prediction_clv_snapshots").insert(rows);
  } catch {
    // silent
  }
}

/**
 * Finalises closing_line + clv_pp on prediction_history for any prediction
 * whose game has just passed its start time. Intended to be called from a
 * lightweight useEffect on odds refresh — it only touches rows whose game
 * window ended recently and haven't been sealed yet.
 */
export async function sealClvForPredictions(
  candidates: ValueBetCandidate[],
): Promise<void> {
  if (!supabase || !candidates.length) return;

  const sealable = candidates.filter((c) => {
    const m = minutesToStart(c.gameTimeLabel);
    return m != null && m <= 0 && m > -60; // started within last hour
  });
  if (!sealable.length) return;

  for (const c of sealable) {
    const sealKey = `seal:${c.id}`;
    if (seen.has(sealKey)) continue;
    seen.add(sealKey);

    try {
      // Most recent snapshot for this prediction = closing line
      const { data } = await supabase
        .from("prediction_clv_snapshots")
        .select("american_odds, snap_at")
        .eq("prediction_id", c.id)
        .order("snap_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!data) continue;

      const closing = Number(data.american_odds);
      // Opening line — read from prediction_history if present, else
      // treat the candidate's current americanOdds as opening (we weren't
      // tracking earlier). Platt runs nightly so later snapshots still
      // get clv_pp once opening is recorded.
      const { data: phRow } = await supabase
        .from("prediction_history")
        .select("opening_line_american, closing_line_american")
        .eq("prediction_id", c.id)
        .maybeSingle();

      const opening = phRow?.opening_line_american ?? c.americanOdds;
      if (phRow?.closing_line_american != null) continue; // already sealed

      // Convert American → implied → percentage-point delta
      const impliedFromAmerican = (a: number): number =>
        a >= 0 ? 100 / (a + 100) : -a / (-a + 100);
      const clv_pp = Math.round(
        (impliedFromAmerican(closing) - impliedFromAmerican(opening)) * 1000
      ) / 10;

      await supabase
        .from("prediction_history")
        .update({
          closing_line_american: closing,
          closing_line_snap_at:  data.snap_at,
          opening_line_american: opening,
          clv_pp,
        })
        .eq("prediction_id", c.id);
    } catch {
      // silent
    }
  }
}
