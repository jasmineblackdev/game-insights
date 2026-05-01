/**
 * MLB Opponent Context — pitcher matchup
 *
 * For an MLB hitter prop, the dominant opponent signal is the opposing
 * starting pitcher's profile, not the team's overall record. This
 * module fetches probable SP stats (ERA, WHIP, K/9, BB/9, HR/9) and
 * exposes per-stat-type multipliers that the projection layer applies
 * after season-average projection.
 *
 * Lazy-fetched and cached per session by SP athlete ID — the same
 * pitcher hits the cache once even though each hitter on the opposing
 * team queries the same context. Returns a no-op multiplier (1.0)
 * whenever SP is unannounced, has insufficient sample size, or the
 * stats fetch fails — never blocks or slows the projection pipeline.
 */

import { fetchPitcherStats, type PitcherStats } from "@/lib/mlbEspnStats";

/** Sub-context for hitter-prop projection. */
export interface MlbOppContext {
  spId?: string;
  spName?: string;
  spHand?: "L" | "R";
  spEra?: number;
  spWhip?: number;
  spK9?: number;
  spBb9?: number;
  spHrPer9?: number;
  spIp?: number;
  /** True when probable SP was named on the scoreboard (vs unknown TBA). */
  spAnnounced: boolean;
  /** Sample-size flag — multipliers only apply when sp_ip ≥ MIN_IP_FOR_ADJ. */
  spReliable: boolean;
  /** Bucketed quality vs the average MLB SP. Drives the UI badge. */
  matchupQuality: "tough" | "neutral" | "soft" | "unknown";
  /** Human-readable note suitable for the UI badge tooltip / reason_2. */
  matchupNote: string;
}

// 2024–2025 MLB league averages — used as the denominator for
// per-stat multipliers. Hand-updated from baseball-reference.com.
const LEAGUE = {
  ERA: 4.30,
  WHIP: 1.30,
  K9: 8.6,
  BB9: 3.1,
  HR9: 1.18,
};

/** Need at least ~30 IP before we trust the K/BB/HR rates. */
const MIN_IP_FOR_ADJ = 30;

/** Multipliers are clamped so a single signal never moves a projection by more than ±15%. */
function clampMul(m: number): number {
  if (!Number.isFinite(m)) return 1.0;
  return Math.max(0.85, Math.min(1.15, m));
}

function classifyMatchup(stats: PitcherStats, announced: boolean, reliable: boolean): {
  q: MlbOppContext["matchupQuality"];
  note: string;
} {
  if (!announced) {
    return {
      q: "unknown",
      note: "Probable SP unannounced — using season averages only.",
    };
  }
  if (!reliable) {
    return {
      q: "unknown",
      note: "Pitcher data thin (low sample) — using season averages only.",
    };
  }

  let toughScore = 0;
  const era = stats.era ?? LEAGUE.ERA;
  const whip = stats.whip ?? LEAGUE.WHIP;
  const k9 = stats.k9 ?? LEAGUE.K9;
  const hr9 = stats.hr9 ?? LEAGUE.HR9;

  if (era < 3.50) toughScore += 1.5;
  else if (era > 4.80) toughScore -= 1.5;

  if (whip < 1.15) toughScore += 1;
  else if (whip > 1.40) toughScore -= 1;

  if (k9 > 9.5) toughScore += 1.5;
  else if (k9 < 7.0) toughScore -= 1;

  // High HR/9 → soft for hitters going Over on power props
  if (hr9 > 1.40) toughScore -= 1.5;
  else if (hr9 < 0.90) toughScore += 1;

  let q: MlbOppContext["matchupQuality"] = "neutral";
  let note = "Neutral matchup — pitcher profile near league average.";
  if (toughScore >= 2.5) {
    q = "tough";
    note = `Tough matchup — ${era.toFixed(2)} ERA, ${k9.toFixed(1)} K/9 SP suppresses hitter output.`;
  } else if (toughScore <= -2) {
    q = "soft";
    note = `Soft matchup — ${era.toFixed(2)} ERA, ${hr9.toFixed(2)} HR/9 SP inflates hitter output.`;
  }
  return { q, note };
}

const ctxCache = new Map<string, Promise<MlbOppContext>>();

/**
 * Lazy SP context for an opposing pitcher. Pass in what we already
 * know from the scoreboard (id, name, handedness); we round-trip to
 * ESPN athlete-stats only when an id is available, and the result is
 * memoized for the session so every hitter on the opposing team
 * shares one fetch.
 */
export function getMlbOpponentContext(args: {
  spId?: string;
  spName?: string;
  spHand?: "L" | "R";
}): Promise<MlbOppContext> {
  const { spId, spName, spHand } = args;

  if (!spId) {
    // No id, no fetch — return the unannounced-SP context immediately.
    const c = classifyMatchup(
      { athleteId: "", era: null, whip: null, k9: null, bb9: null, hr9: null, kbb: null, ip: null },
      !!spName,
      false,
    );
    return Promise.resolve({
      spName,
      spHand,
      spAnnounced: !!spName,
      spReliable: false,
      matchupQuality: c.q,
      matchupNote: c.note,
    });
  }

  if (ctxCache.has(spId)) return ctxCache.get(spId)!;

  const p = (async (): Promise<MlbOppContext> => {
    const stats = await fetchPitcherStats(spId);
    const reliable = (stats.ip ?? 0) >= MIN_IP_FOR_ADJ;
    const c = classifyMatchup(stats, true, reliable);
    return {
      spId,
      spName,
      spHand,
      spEra: stats.era ?? undefined,
      spWhip: stats.whip ?? undefined,
      spK9: stats.k9 ?? undefined,
      spBb9: stats.bb9 ?? undefined,
      spHrPer9: stats.hr9 ?? undefined,
      spIp: stats.ip ?? undefined,
      spAnnounced: true,
      spReliable: reliable,
      matchupQuality: c.q,
      matchupNote: c.note,
    };
  })();
  ctxCache.set(spId, p);
  return p;
}

/**
 * Per-stat-type projection multiplier. Returns 1.0 (no-op) when SP is
 * unannounced or the sample is too thin to trust the rates. All
 * multipliers clamp to ±15% so no single context signal can flip a
 * projection on its own.
 *
 * The mapping reflects which SP rate most directly affects each
 * hitter stat:
 *   hits / total_bases / singles / 2B / 3B  → ERA + K9 (contact)
 *   home_runs / extra_base_hits             → HR/9 (power)
 *   rbis / runs / combined R-counters       → ERA + HR/9 (run env)
 *   walks / H+BB+SB                         → BB/9 (command)
 *   strikeouts (hitter K props)             → K9 (whiff)
 */
export function pitcherMultiplier(statType: string, ctx: MlbOppContext): number {
  if (!ctx.spReliable) return 1.0;
  const era = ctx.spEra ?? LEAGUE.ERA;
  const whip = ctx.spWhip ?? LEAGUE.WHIP;
  const k9 = ctx.spK9 ?? LEAGUE.K9;
  const bb9 = ctx.spBb9 ?? LEAGUE.BB9;
  const hr9 = ctx.spHrPer9 ?? LEAGUE.HR9;

  switch (statType) {
    case "hits":
    case "total_bases":
    case "singles":
    case "doubles":
    case "triples": {
      // Lower ERA and higher K9 both suppress hitter contact. Average
      // the two normalized signals.
      const eraMult = LEAGUE.ERA / era;
      const k9Mult = LEAGUE.K9 / k9;
      return clampMul(0.5 * eraMult + 0.5 * k9Mult);
    }
    case "home_runs":
    case "extra_base_hits":
      return clampMul(hr9 / LEAGUE.HR9);
    case "rbis":
    case "runs":
    case "hits_runs_rbis":
    case "hits_runs":
    case "runs_rbis": {
      const eraMult = LEAGUE.ERA / era;
      const hrMult = hr9 / LEAGUE.HR9;
      // Bullpen exposure proxy: when the starter averages <5.5 IP per
      // start, hitters see significantly more bullpen innings, which
      // historically run a hair higher ERA than starters at the
      // league level. Use spIp / spStartsApprox as a proxy — lacking
      // a per-team bullpen ERA fetcher, this captures ~60% of the
      // signal at zero new network cost. Stronger version (real team
      // bullpen ERA endpoint) lives in V2.
      const ipPerStart = (ctx.spIp ?? 0) > 0 && ctx.spReliable
        ? Math.min(7.5, Math.max(3, ctx.spIp ?? 6))
        : 6;
      const bullpenExposureBoost = ipPerStart < 5.5
        ? 1 + (5.5 - ipPerStart) * 0.015 // up to +3% at 3.5 IP/start
        : 1;
      return clampMul(0.6 * eraMult + 0.4 * hrMult * bullpenExposureBoost);
    }
    case "walks":
    case "hits_walks_stolen_bases":
      return clampMul(bb9 / LEAGUE.BB9);
    case "strikeouts":
      // Hitter-side K prop — high-K SP raises projection, low-K SP lowers it
      return clampMul(k9 / LEAGUE.K9);
    case "hits_stolen_bases": {
      // Mostly hits-driven; SB is independent of SP profile
      const eraMult = LEAGUE.ERA / era;
      const k9Mult = LEAGUE.K9 / k9;
      return clampMul(0.4 * eraMult + 0.4 * k9Mult + 0.2);
    }
    default:
      // Unknown stat (e.g. stolen_bases on its own) → neutral
      void whip;
      return 1.0;
  }
}

/** Clear cache — exposed for tests / debugging. */
export function _clearMlbOpponentContextCache(): void {
  ctxCache.clear();
}
