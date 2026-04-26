/**
 * NFL Opponent Context — defensive efficiency by phase.
 *
 * Unlike basketball where one defensive rating drives most prop
 * adjustments, NFL props split sharply by phase: a QB's passing
 * yards depend on the opposing pass defense; an RB's rushing yards
 * depend on the opposing rush defense; a WR/TE's receiving line
 * tracks pass defense as well, because both are gated by how many
 * yards the unit allows through the air.
 *
 * Pulls from ESPN's per-team statistics endpoint, caches per teamId
 * per session, and falls back to neutral (multiplier = 1.0) when
 * data is missing — never blocks the projection pipeline.
 */

const TEAM_STATS_URL = (teamId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/statistics`;

export interface NflOppContext {
  teamId?: string;
  /** Points allowed per game (lower = stingier defense). */
  pointsAllowedPg?: number;
  /** Passing yards allowed per game. */
  passYdsAllowedPg?: number;
  /** Rushing yards allowed per game. */
  rushYdsAllowedPg?: number;
  /** Sacks generated per game (defensive disruption proxy). */
  sacksPerGame?: number;
  /** Takeaways per game (turnovers forced). */
  takeawaysPerGame?: number;
  /** Plays per game — proxy for pace. */
  playsPerGame?: number;
  /** True when at least pointsAllowed + passYds + rushYds resolved. */
  hasData: boolean;
  /** Bucketed quality vs the average NFL defense. Drives the badge. */
  matchupQuality: "tough_pass" | "tough_rush" | "soft_pass" | "soft_rush" | "neutral" | "unknown";
  /** Human-readable matchup note suitable for the UI badge tooltip / reason_2. */
  matchupNote: string;
}

// 2024–2025 NFL league averages — used as the denominator for
// per-stat multipliers. Hand-updated from pro-football-reference.com.
const LEAGUE = {
  PTS_ALLOWED: 22.5,
  PASS_YDS_ALLOWED: 220.0,
  RUSH_YDS_ALLOWED: 115.0,
  SACKS_PG: 2.4,
  TAKEAWAYS_PG: 1.3,
  PLAYS_PG: 64.0,
};

/** ±15% per-multiplier clamp — a single signal can't flip a projection. */
function clampMul(m: number): number {
  if (!Number.isFinite(m)) return 1.0;
  return Math.max(0.85, Math.min(1.15, m));
}

function classifyMatchup(c: NflOppContext): {
  q: NflOppContext["matchupQuality"];
  note: string;
} {
  if (!c.hasData) {
    return { q: "unknown", note: "Team data unavailable — using season averages only." };
  }

  const passYds = c.passYdsAllowedPg ?? LEAGUE.PASS_YDS_ALLOWED;
  const rushYds = c.rushYdsAllowedPg ?? LEAGUE.RUSH_YDS_ALLOWED;

  // Pick the more extreme of pass / rush as the headline matchup.
  const passDelta = (passYds - LEAGUE.PASS_YDS_ALLOWED) / LEAGUE.PASS_YDS_ALLOWED;
  const rushDelta = (rushYds - LEAGUE.RUSH_YDS_ALLOWED) / LEAGUE.RUSH_YDS_ALLOWED;

  // Strong soft pass D
  if (passDelta >= 0.10 && passDelta >= rushDelta) {
    return {
      q: "soft_pass",
      note: `Soft pass D — ${passYds.toFixed(0)} yds allowed/game (league ~${LEAGUE.PASS_YDS_ALLOWED.toFixed(0)}).`,
    };
  }
  // Strong soft rush D
  if (rushDelta >= 0.10 && rushDelta > passDelta) {
    return {
      q: "soft_rush",
      note: `Soft rush D — ${rushYds.toFixed(0)} yds allowed/game (league ~${LEAGUE.RUSH_YDS_ALLOWED.toFixed(0)}).`,
    };
  }
  // Tough pass D
  if (passDelta <= -0.10 && passDelta <= rushDelta) {
    return {
      q: "tough_pass",
      note: `Tough pass D — ${passYds.toFixed(0)} yds allowed/game (league ~${LEAGUE.PASS_YDS_ALLOWED.toFixed(0)}).`,
    };
  }
  // Tough rush D
  if (rushDelta <= -0.10 && rushDelta < passDelta) {
    return {
      q: "tough_rush",
      note: `Tough rush D — ${rushYds.toFixed(0)} yds allowed/game (league ~${LEAGUE.RUSH_YDS_ALLOWED.toFixed(0)}).`,
    };
  }
  return {
    q: "neutral",
    note: "Neutral matchup — opponent near league average defense.",
  };
}

const ctxCache = new Map<string, Promise<NflOppContext>>();

/**
 * Lazy NFL opponent context for a single team. Pulls per-team stats
 * from ESPN, caches per-session by teamId so every player on the
 * opposing roster shares one fetch.
 */
export function getNflOpponentContext(teamId?: string): Promise<NflOppContext> {
  if (!teamId) {
    const c = classifyMatchup({ hasData: false } as NflOppContext);
    return Promise.resolve({
      hasData: false,
      matchupQuality: c.q,
      matchupNote: c.note,
    });
  }

  if (ctxCache.has(teamId)) return ctxCache.get(teamId)!;

  const p = (async (): Promise<NflOppContext> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(TEAM_STATS_URL(teamId), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const c = classifyMatchup({ hasData: false } as NflOppContext);
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

      const ctx: NflOppContext = {
        teamId,
        pointsAllowedPg: pick(
          "avgpointsagainst", "pointspergameallowed", "opponentpointspergame", "opppointspergame",
        ),
        passYdsAllowedPg: pick(
          "avgpassingyardsagainst", "passingyardsagainstpergame",
          "opponentpassingyardspergame", "opppassingyardspergame",
        ),
        rushYdsAllowedPg: pick(
          "avgrushingyardsagainst", "rushingyardsagainstpergame",
          "opponentrushingyardspergame", "opprushingyardspergame",
        ),
        sacksPerGame: pick("avgsacks", "sackspergame", "totalsackspergame"),
        takeawaysPerGame: pick("avgtakeaways", "takeawayspergame", "totaltakeawayspergame"),
        playsPerGame: pick("avgplays", "playspergame", "offensiveplayspergame"),
        hasData: false,
        matchupQuality: "unknown",
        matchupNote: "",
      };
      ctx.hasData = ctx.pointsAllowedPg != null
        && (ctx.passYdsAllowedPg != null || ctx.rushYdsAllowedPg != null);
      const c = classifyMatchup(ctx);
      ctx.matchupQuality = c.q;
      ctx.matchupNote = c.note;
      return ctx;
    } catch {
      clearTimeout(timer);
      const c = classifyMatchup({ hasData: false } as NflOppContext);
      return { teamId, hasData: false, matchupQuality: c.q, matchupNote: c.note };
    }
  })();

  ctxCache.set(teamId, p);
  return p;
}

/**
 * Per-stat multiplier from opposing NFL defense. Returns 1.0 (no-op)
 * when data is missing.
 *
 * Mapping reflects which "yards allowed" stat most directly affects
 * each prop type:
 *   passing_yards   → opp pass yds allowed × pace × disruption
 *   rushing_yards   → opp rush yds allowed × pace
 *   receiving_yards → opp pass yds allowed × pace
 *   receptions      → opp pass yds allowed (target share proxy)
 *
 * Defensive disruption (sacks + takeaways) hits passing volume, so
 * passing-related multipliers also incorporate a small disruption
 * factor.
 */
export function nflOpponentMultiplier(statType: string, ctx: NflOppContext): number {
  if (!ctx.hasData) return 1.0;

  const passAllowed = ctx.passYdsAllowedPg ?? LEAGUE.PASS_YDS_ALLOWED;
  const rushAllowed = ctx.rushYdsAllowedPg ?? LEAGUE.RUSH_YDS_ALLOWED;
  const sacksPg = ctx.sacksPerGame ?? LEAGUE.SACKS_PG;
  const playsPg = ctx.playsPerGame ?? LEAGUE.PLAYS_PG;

  const passMult = passAllowed / LEAGUE.PASS_YDS_ALLOWED;
  const rushMult = rushAllowed / LEAGUE.RUSH_YDS_ALLOWED;
  const paceMult = ctx.playsPerGame != null
    ? clampMul(1 + ((playsPg - LEAGUE.PLAYS_PG) / LEAGUE.PLAYS_PG) * 0.5)
    : 1.0;
  // Disruption: more sacks → fewer passing yards. Inverse relationship,
  // capped at ±5% so a high-sack team doesn't kill an otherwise-strong
  // matchup.
  const disruption = ctx.sacksPerGame != null
    ? clampMul(1 - ((sacksPg - LEAGUE.SACKS_PG) / LEAGUE.SACKS_PG) * 0.05)
    : 1.0;

  switch (statType) {
    case "passing_yards":
      return clampMul(passMult * paceMult * disruption);
    case "rushing_yards":
      return clampMul(rushMult * paceMult);
    case "receiving_yards":
      return clampMul(passMult * paceMult * disruption);
    case "receptions":
      return clampMul(passMult * disruption);
    default:
      return 1.0;
  }
}

export function _clearNflOpponentContextCache(): void {
  ctxCache.clear();
}
