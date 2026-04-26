/**
 * WNBA Opponent Context — team defense + pace, separate from NBA so
 * model calibration and league averages stay clean. Same shape as
 * NbaOppContext (so the espnPlayerStats loop can branch sport-by-sport
 * without diverging plumbing) but values reflect WNBA's actual
 * defensive ratings and pace, which run different from NBA.
 */

const TEAM_STATS_URL = (teamId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${teamId}/statistics`;

export interface WnbaOppContext {
  teamId?: string;
  pace?: number;
  defRating?: number;
  pointsAllowedPg?: number;
  reboundsAllowedPg?: number;
  assistsAllowedPg?: number;
  threesAllowedPg?: number;
  hasData: boolean;
  matchupQuality: "tough" | "neutral" | "soft" | "fast" | "unknown";
  matchupNote: string;
}

// 2024–2025 WNBA league averages — runs lower scoring than NBA, so
// per-stat denominators differ. Hand-calibrated from
// basketball-reference.com / wnba.com.
const LEAGUE = {
  PACE: 80.5,
  DEF_RTG: 102.0,
  PTS_ALLOWED: 81.0,
  REB_ALLOWED: 33.0,
  AST_ALLOWED: 19.5,
  THREES_ALLOWED: 6.5,
};

function clampMul(m: number): number {
  if (!Number.isFinite(m)) return 1.0;
  return Math.max(0.85, Math.min(1.15, m));
}

function classifyMatchup(c: WnbaOppContext): {
  q: WnbaOppContext["matchupQuality"];
  note: string;
} {
  if (!c.hasData) {
    return { q: "unknown", note: "WNBA team data unavailable — flagged LOW DATA, using season averages only." };
  }

  const pace = c.pace ?? LEAGUE.PACE;
  const defRtg = c.defRating ?? LEAGUE.DEF_RTG;
  const ptsA = c.pointsAllowedPg ?? LEAGUE.PTS_ALLOWED;
  const astA = c.assistsAllowedPg ?? LEAGUE.AST_ALLOWED;
  const threesA = c.threesAllowedPg ?? LEAGUE.THREES_ALLOWED;

  const fastPace = pace >= LEAGUE.PACE + 2.0;

  let toughScore = 0;
  if (defRtg < LEAGUE.DEF_RTG - 3) toughScore += 1.5;
  else if (defRtg > LEAGUE.DEF_RTG + 3) toughScore -= 1.5;

  if (ptsA < LEAGUE.PTS_ALLOWED - 3) toughScore += 1;
  else if (ptsA > LEAGUE.PTS_ALLOWED + 3) toughScore -= 1;

  if (astA > LEAGUE.AST_ALLOWED + 1.5) toughScore -= 1;
  else if (astA < LEAGUE.AST_ALLOWED - 1.5) toughScore += 0.5;

  if (threesA > LEAGUE.THREES_ALLOWED + 1.0) toughScore -= 0.5;

  if (fastPace && toughScore <= 1) {
    return {
      q: "fast",
      note: `Fast pace boost — opponent runs ${pace.toFixed(1)} POSS/40 (league ~${LEAGUE.PACE.toFixed(0)}).`,
    };
  }
  if (toughScore >= 2) {
    return {
      q: "tough",
      note: `Tough matchup — ${defRtg.toFixed(1)} DRtg, ${ptsA.toFixed(1)} PPG allowed.`,
    };
  }
  if (toughScore <= -1.5) {
    const driver = astA > LEAGUE.AST_ALLOWED + 1.5
      ? `${astA.toFixed(1)} APG allowed`
      : ptsA > LEAGUE.PTS_ALLOWED + 3
        ? `${ptsA.toFixed(1)} PPG allowed`
        : `${defRtg.toFixed(1)} DRtg`;
    return {
      q: "soft",
      note: `Soft matchup — ${driver}, inflates output.`,
    };
  }
  return {
    q: "neutral",
    note: `Neutral matchup — opponent near WNBA league average defense.`,
  };
}

const ctxCache = new Map<string, Promise<WnbaOppContext>>();

export function getWnbaOpponentContext(teamId?: string): Promise<WnbaOppContext> {
  if (!teamId) {
    const c = classifyMatchup({ hasData: false } as WnbaOppContext);
    return Promise.resolve({
      hasData: false,
      matchupQuality: c.q,
      matchupNote: c.note,
    });
  }

  if (ctxCache.has(teamId)) return ctxCache.get(teamId)!;

  const p = (async (): Promise<WnbaOppContext> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(TEAM_STATS_URL(teamId), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const c = classifyMatchup({ hasData: false } as WnbaOppContext);
        return { teamId, hasData: false, matchupQuality: c.q, matchupNote: c.note };
      }
      const body = (await res.json()) as {
        team?: {
          statistics?: {
            splits?: {
              categories?: Array<{
                name?: string;
                stats?: Array<{ name?: string; value?: number }>;
              }>;
            };
          };
        };
      };
      const cats = body.team?.statistics?.splits?.categories ?? [];
      const flat: Array<{ name: string; value: number }> = [];
      for (const cat of cats) {
        for (const s of cat.stats ?? []) {
          if (s.name && typeof s.value === "number" && Number.isFinite(s.value)) {
            flat.push({ name: s.name.toLowerCase(), value: s.value });
          }
        }
      }
      const pick = (...names: string[]): number | undefined => {
        for (const n of names) {
          const f = flat.find((s) => s.name === n);
          if (f) return f.value;
        }
        return undefined;
      };

      const ctx: WnbaOppContext = {
        teamId,
        pace: pick("pace", "possessions"),
        defRating: pick("defensiverating", "drtg", "defrtg", "avgpointsallowed"),
        pointsAllowedPg: pick("avgpointsagainst", "pointspergameallowed", "opponentpointspergame"),
        reboundsAllowedPg: pick("avgreboundsagainst", "opponentreboundspergame"),
        assistsAllowedPg: pick("avgassistsagainst", "opponentassistspergame"),
        threesAllowedPg: pick(
          "avgthreepointfieldgoalsmadeagainst",
          "opponentthreepointfieldgoalspergame",
          "oppthreepointfieldgoalspergame",
        ),
        hasData: false,
        matchupQuality: "unknown",
        matchupNote: "",
      };
      ctx.hasData = ctx.pace != null || ctx.defRating != null || ctx.pointsAllowedPg != null;
      const c = classifyMatchup(ctx);
      ctx.matchupQuality = c.q;
      ctx.matchupNote = c.note;
      return ctx;
    } catch {
      clearTimeout(timer);
      const c = classifyMatchup({ hasData: false } as WnbaOppContext);
      return { teamId, hasData: false, matchupQuality: c.q, matchupNote: c.note };
    }
  })();

  ctxCache.set(teamId, p);
  return p;
}

/**
 * Per-stat multiplier identical in shape to nbaOpponentMultiplier but
 * keyed off the WNBA-specific league averages so projections respond
 * to the actual league.
 */
export function wnbaOpponentMultiplier(statType: string, ctx: WnbaOppContext): number {
  if (!ctx.hasData) return 1.0;

  const paceMult = ctx.pace != null
    ? clampMul(1 + ((ctx.pace - LEAGUE.PACE) / LEAGUE.PACE) * 0.5)
    : 1.0;

  const oppAllowedMult = (allowed: number | undefined, league: number): number => {
    if (allowed == null) return 1.0;
    return clampMul(allowed / league);
  };

  switch (statType) {
    case "points":
      return clampMul(oppAllowedMult(ctx.pointsAllowedPg, LEAGUE.PTS_ALLOWED) * paceMult);
    case "rebounds":
      return clampMul(oppAllowedMult(ctx.reboundsAllowedPg, LEAGUE.REB_ALLOWED) * paceMult);
    case "assists":
      return clampMul(oppAllowedMult(ctx.assistsAllowedPg, LEAGUE.AST_ALLOWED) * paceMult);
    case "threes":
      return clampMul(oppAllowedMult(ctx.threesAllowedPg, LEAGUE.THREES_ALLOWED) * paceMult);
    case "pra":
      return clampMul(
        ((oppAllowedMult(ctx.pointsAllowedPg, LEAGUE.PTS_ALLOWED) +
          oppAllowedMult(ctx.reboundsAllowedPg, LEAGUE.REB_ALLOWED) +
          oppAllowedMult(ctx.assistsAllowedPg, LEAGUE.AST_ALLOWED)) / 3) * paceMult
      );
    case "pts_reb":
      return clampMul(
        ((oppAllowedMult(ctx.pointsAllowedPg, LEAGUE.PTS_ALLOWED) +
          oppAllowedMult(ctx.reboundsAllowedPg, LEAGUE.REB_ALLOWED)) / 2) * paceMult
      );
    case "pts_ast":
      return clampMul(
        ((oppAllowedMult(ctx.pointsAllowedPg, LEAGUE.PTS_ALLOWED) +
          oppAllowedMult(ctx.assistsAllowedPg, LEAGUE.AST_ALLOWED)) / 2) * paceMult
      );
    case "reb_ast":
      return clampMul(
        ((oppAllowedMult(ctx.reboundsAllowedPg, LEAGUE.REB_ALLOWED) +
          oppAllowedMult(ctx.assistsAllowedPg, LEAGUE.AST_ALLOWED)) / 2) * paceMult
      );
    case "steals":
    case "blocks":
      return 1.0;
    default:
      return 1.0;
  }
}

export function _clearWnbaOpponentContextCache(): void {
  ctxCache.clear();
}
