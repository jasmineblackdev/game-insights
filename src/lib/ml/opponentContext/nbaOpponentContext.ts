/**
 * NBA Opponent Context — team defense + pace
 *
 * For an NBA player prop, the dominant opponent signals are the
 * defending team's pace (more possessions = more chances) and what
 * the defense actually allows by stat category. True positional
 * defense (DvP) is paywalled; this module uses team-level
 * "opponent stats allowed" which are exposed for free by ESPN's
 * per-team statistics endpoint.
 *
 * Lazy-fetched and cached per session by team id, so every player on
 * a team shares one fetch and refresh-friendly.
 */

const TEAM_STATS_URL = (teamId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/statistics`;

export interface NbaOppContext {
  teamId?: string;
  /** Team possessions per 48 — higher means more shot attempts for everyone. */
  pace?: number;
  /** Points allowed per 100 possessions — lower means stingier defense. */
  defRating?: number;
  /** Per-game opponent points allowed. */
  pointsAllowedPg?: number;
  /** Per-game opponent rebounds allowed. */
  reboundsAllowedPg?: number;
  /** Per-game opponent assists allowed. */
  assistsAllowedPg?: number;
  /** Per-game opponent 3-pointers made allowed. */
  threesAllowedPg?: number;
  /** True when at least pace + defRating were resolved. */
  hasData: boolean;
  /** Bucketed quality vs the average NBA defense. Drives the badge. */
  matchupQuality: "tough" | "neutral" | "soft" | "fast" | "unknown";
  /** Human-readable matchup note suitable for the UI badge tooltip / reason_2. */
  matchupNote: string;
}

// 2024–2025 NBA league averages (per-game / per-100). Hand-updated
// from basketball-reference.com — used as the denominator for
// per-stat multipliers.
const LEAGUE = {
  PACE: 99.0,
  DEF_RTG: 113.5,
  PTS_ALLOWED: 113.5,
  REB_ALLOWED: 43.5,
  AST_ALLOWED: 26.7,
  THREES_ALLOWED: 13.3,
};

/** Multipliers clamp to ±15% so a single signal can't flip a projection. */
function clampMul(m: number): number {
  if (!Number.isFinite(m)) return 1.0;
  return Math.max(0.85, Math.min(1.15, m));
}

function classifyMatchup(c: NbaOppContext): {
  q: NbaOppContext["matchupQuality"];
  note: string;
} {
  if (!c.hasData) {
    return { q: "unknown", note: "Team data unavailable — using season averages only." };
  }

  const pace = c.pace ?? LEAGUE.PACE;
  const defRtg = c.defRating ?? LEAGUE.DEF_RTG;
  const ptsA = c.pointsAllowedPg ?? LEAGUE.PTS_ALLOWED;
  const astA = c.assistsAllowedPg ?? LEAGUE.AST_ALLOWED;
  const threesA = c.threesAllowedPg ?? LEAGUE.THREES_ALLOWED;

  // Pace flag overrides quality bucket when notably fast — fast pace
  // is a positive signal across all stat types.
  const fastPace = pace >= LEAGUE.PACE + 2.5;

  let toughScore = 0;
  if (defRtg < LEAGUE.DEF_RTG - 3) toughScore += 1.5;
  else if (defRtg > LEAGUE.DEF_RTG + 3) toughScore -= 1.5;

  if (ptsA < LEAGUE.PTS_ALLOWED - 3) toughScore += 1;
  else if (ptsA > LEAGUE.PTS_ALLOWED + 3) toughScore -= 1;

  if (astA > LEAGUE.AST_ALLOWED + 1.5) toughScore -= 1;   // soft for assist props
  else if (astA < LEAGUE.AST_ALLOWED - 1.5) toughScore += 0.5;

  if (threesA > LEAGUE.THREES_ALLOWED + 1.0) toughScore -= 0.5; // soft for 3PM

  if (fastPace && toughScore <= 1) {
    return {
      q: "fast",
      note: `Fast pace boost — opponent runs ${pace.toFixed(1)} POSS/48 (league ~${LEAGUE.PACE.toFixed(0)}).`,
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
    note: `Neutral matchup — opponent near league average defense.`,
  };
}

const ctxCache = new Map<string, Promise<NbaOppContext>>();

/**
 * Lazy NBA opponent context for a single team. Pulls per-team stats
 * from ESPN, caches the resulting promise per teamId so every player
 * on the opposing roster shares one fetch.
 */
export function getNbaOpponentContext(teamId?: string): Promise<NbaOppContext> {
  if (!teamId) {
    const c = classifyMatchup({ hasData: false } as NbaOppContext);
    return Promise.resolve({
      hasData: false,
      matchupQuality: c.q,
      matchupNote: c.note,
    });
  }

  if (ctxCache.has(teamId)) return ctxCache.get(teamId)!;

  const p = (async (): Promise<NbaOppContext> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(TEAM_STATS_URL(teamId), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const c = classifyMatchup({ hasData: false } as NbaOppContext);
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

      const ctx: NbaOppContext = {
        teamId,
        pace: pick("pace", "possessions"),
        defRating: pick("defensiverating", "drtg", "defrtg", "avgpointsallowed"),
        pointsAllowedPg: pick(
          "avgpointsagainst", "pointspergameallowed", "opponentpointspergame", "opppointspergame"
        ),
        reboundsAllowedPg: pick(
          "avgreboundsagainst", "opponentreboundspergame", "oppreboundspergame"
        ),
        assistsAllowedPg: pick(
          "avgassistsagainst", "opponentassistspergame", "oppassistspergame"
        ),
        threesAllowedPg: pick(
          "avgthreepointfieldgoalsmadeagainst",
          "opponentthreepointfieldgoalspergame",
          "oppthreepointfieldgoalspergame",
          "oppthreepointersmade",
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
      const c = classifyMatchup({ hasData: false } as NbaOppContext);
      return { teamId, hasData: false, matchupQuality: c.q, matchupNote: c.note };
    }
  })();

  ctxCache.set(teamId, p);
  return p;
}

/**
 * Per-stat multiplier from team-defense + pace. Returns 1.0 (no-op)
 * when the team data is missing. Steals/blocks stay neutral — there's
 * no good public team-level signal for them.
 *
 * Mapping reflects which "opponent allowed" stat most directly
 * affects each prop type. For combined picks we average the
 * components' multipliers.
 *
 * Pace is a small additive boost (or drag) applied to every stat
 * that scales with possession count — points / rebounds / assists /
 * threes / combined picks. Capped so a 5-pace gap moves projection
 * by ~5%.
 */
export function nbaOpponentMultiplier(statType: string, ctx: NbaOppContext): number {
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
      return clampMul(
        oppAllowedMult(ctx.pointsAllowedPg, LEAGUE.PTS_ALLOWED) * paceMult
      );
    case "rebounds":
      return clampMul(
        oppAllowedMult(ctx.reboundsAllowedPg, LEAGUE.REB_ALLOWED) * paceMult
      );
    case "assists":
      return clampMul(
        oppAllowedMult(ctx.assistsAllowedPg, LEAGUE.AST_ALLOWED) * paceMult
      );
    case "threes":
      return clampMul(
        oppAllowedMult(ctx.threesAllowedPg, LEAGUE.THREES_ALLOWED) * paceMult
      );
    case "pra":
      // Sum of three-stat exposure — average each component's multiplier
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
      // No strong team-level signal for these; leave neutral until DvP
      // or shot-block-rate data is available.
      return 1.0;
    default:
      return 1.0;
  }
}

/** Clear cache — exposed for tests / debugging. */
export function _clearNbaOpponentContextCache(): void {
  ctxCache.clear();
}
