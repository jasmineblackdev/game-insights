/**
 * Fetches real NFL/NBA/MLB draft prospect data from ESPN.
 * Converts ESPN prospect rankings into DraftPickPrediction format.
 *
 * Grades are derived from consensus rank position:
 *   #1–3:  A+   (generational talent, top of board)
 *   #4–8:  A    (blue chip, near-certain impact)
 *   #9–15: A-   (premium prospect, starter potential)
 *   #16–25:B+   (strong value, likely contributor)
 *   #26–40:B    (solid mid-round quality)
 *   #41–60:B-   (developmental with upside)
 *   #61+:  C+   (project/depth)
 *
 * ESPN draft endpoints tried:
 *  1. Post-draft picks: site.api.espn.com/apis/site/v2/sports/{sport}/draft?season={year}
 *  2. Pre-draft prospects: sports.core.api.espn.com/v2/sports/{sport}/draft/prospects?limit=100
 */

import type { League } from "@/data/mockGames";
import type { DraftGrade, DraftPickPrediction } from "@/data/draftPicks";

// ── Grade helpers ──────────────────────────────────────────────────────────────

function rankToGrade(rank: number): DraftGrade {
  if (rank <= 3)  return "A+";
  if (rank <= 8)  return "A";
  if (rank <= 15) return "A-";
  if (rank <= 25) return "B+";
  if (rank <= 40) return "B";
  if (rank <= 60) return "B-";
  return "C+";
}

function rankToConfidence(rank: number): "high" | "medium" | "low" {
  if (rank <= 10) return "high";
  if (rank <= 30) return "medium";
  return "low";
}

// ── Sport-specific ESPN URLs ───────────────────────────────────────────────────

type SportPath = "football/nfl" | "basketball/nba" | "baseball/mlb";

function sportPath(league: League): SportPath | null {
  if (league === "nfl") return "football/nfl";
  if (league === "nba") return "basketball/nba";
  if (league === "mlb") return "baseball/mlb";
  return null;
}

function draftPicksUrl(league: League, season: number): string {
  const sp = sportPath(league);
  if (!sp) return "";
  return `https://site.api.espn.com/apis/site/v2/sports/${sp}/draft?season=${season}&limit=100`;
}

function prospectsUrl(league: League): string {
  const sp = sportPath(league);
  if (!sp) return "";
  // Use site API (browser-accessible, no CORS issues).
  // sports.core.api.espn.com blocks cross-origin browser requests.
  return `https://site.api.espn.com/apis/site/v2/sports/${sp}/draft/prospects?limit=100`;
}

// ── ESPN raw types ─────────────────────────────────────────────────────────────

interface EspnAthlete {
  id?: string;
  displayName?: string;
  position?: { abbreviation?: string; displayName?: string };
  college?: { name?: string; shortName?: string };
  grade?: number; // 0–100 NFL Network grade
  attributes?: Array<{ name?: string; description?: string }>;
  description?: string;
  rank?: number;
}

interface EspnDraftPick {
  id?: string;
  pickNumber?: number;
  overallNumber?: number;
  team?: { abbreviation?: string; displayName?: string; logo?: string };
  athlete?: EspnAthlete;
}

interface EspnDraftRound {
  number?: number;
  picks?: EspnDraftPick[];
}

interface EspnDraftResponse {
  rounds?: EspnDraftRound[];
  items?: EspnAthlete[]; // prospects endpoint wraps in items
  athletes?: EspnAthlete[];
}

// ── Converters ────────────────────────────────────────────────────────────────

function teamEmojiForLeague(league: League): string {
  if (league === "nfl") return "🏈";
  if (league === "nba") return "🏀";
  if (league === "mlb") return "⚾";
  return "🏅";
}

function buildAnalysis(
  playerName: string,
  position: string,
  college: string,
  rank: number,
  grade: DraftGrade
): string {
  const tier =
    rank <= 5 ? "elite top-five"
    : rank <= 15 ? "premium first-round"
    : rank <= 32 ? "first-round caliber"
    : rank <= 64 ? "early second-round"
    : "developmental";

  return `${playerName} is a ${tier} prospect out of ${college || "college"}. ` +
    `Graded ${grade} based on consensus boards and position value. ` +
    `${position ? `Plays ${position} — ` : ""}scouts project immediate impact at the next level.`;
}

function buildStrength(position: string, rank: number): string {
  const posStrengths: Record<string, string> = {
    QB: "Decision-making and arm talent with pro-level pocket awareness",
    WR: "Route precision, yards after catch, and separation at the line",
    CB: "Man coverage ability and ball-hawking instincts in press",
    DE: "First-step quickness and pass-rush repertoire off the edge",
    OT: "Anchor strength and lateral mobility in pass protection",
    LB: "Sideline-to-sideline pursuit and run-fit discipline",
    TE: "Dual-threat capability as blocker and receiver",
    RB: "Contact balance, vision through gaps, and pass-pro ability",
    PG: "Playmaking vision and shot creation off the dribble",
    SG: "Off-ball movement and three-point shooting mechanics",
    SF: "Versatility on both ends and elite athleticism",
    PF: "Stretch ability combined with interior finishing",
    C:  "Rim protection and high-low passing from the post",
    SP: "Elite arm angle and pitch repertoire with swing-and-miss ability",
    SS: "Hit tool and bat-to-ball skills from both sides of the plate",
  };
  const cleanPos = position?.replace(/\s*\/.*/, "").trim().toUpperCase();
  return posStrengths[cleanPos] ?? `Exceptional athleticism and production at ${position || "the position"}`;
}

function buildImpact(rank: number, position: string): string {
  if (rank <= 5) return "Expected Day 1 starter with Pro Bowl upside in Year 1";
  if (rank <= 15) return "Projects to start within the first season, high-floor contributor";
  if (rank <= 32) return "Rotational impact in Year 1, starting role expected by Year 2";
  if (rank <= 64) return "Strong developmental candidate, depth role early with starter potential";
  return "Project/depth pick with long-term upside given athleticism profile";
}

function pickFromEspnPick(pick: EspnDraftPick, index: number, league: League): DraftPickPrediction | null {
  const athlete = pick.athlete;
  const playerName = athlete?.displayName;
  if (!playerName) return null;

  const pickNum = pick.pickNumber ?? pick.overallNumber ?? index + 1;
  const team = pick.team;
  const position = athlete?.position?.abbreviation ?? athlete?.position?.displayName ?? "—";
  const college = athlete?.college?.name ?? athlete?.college?.shortName ?? "—";
  const grade = rankToGrade(pickNum);

  return {
    league,
    pickNumber: pickNum,
    teamName: team?.displayName ?? "TBD",
    teamAbbr: team?.abbreviation ?? "TBD",
    teamLogo: teamEmojiForLeague(league),
    playerName,
    position,
    college,
    grade,
    confidence: rankToConfidence(pickNum),
    analysis: buildAnalysis(playerName, position, college, pickNum, grade),
    keyStrength: buildStrength(position, pickNum),
    projectedImpact: buildImpact(pickNum, position),
  };
}

function prospectToPick(prospect: EspnAthlete, index: number, league: League): DraftPickPrediction | null {
  const playerName = prospect.displayName;
  if (!playerName) return null;

  const rank = prospect.rank ?? index + 1;
  const position = prospect.position?.abbreviation ?? prospect.position?.displayName ?? "—";
  const college = prospect.college?.name ?? prospect.college?.shortName ?? "—";
  const grade = rankToGrade(rank);

  return {
    league,
    pickNumber: rank,
    teamName: "TBD",
    teamAbbr: "TBD",
    teamLogo: teamEmojiForLeague(league),
    playerName,
    position,
    college,
    grade,
    confidence: rankToConfidence(rank),
    analysis: buildAnalysis(playerName, position, college, rank, grade),
    keyStrength: buildStrength(position, rank),
    projectedImpact: buildImpact(rank, position),
  };
}

// ── Fetchers ───────────────────────────────────────────────────────────────────

/** Try the post-draft picks endpoint first (works after the draft). */
async function fetchDraftPicks(league: League, season: number): Promise<DraftPickPrediction[]> {
  const url = draftPicksUrl(league, season);
  if (!url) return [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as EspnDraftResponse;
    const picks: DraftPickPrediction[] = [];
    for (const round of data.rounds ?? []) {
      for (let i = 0; i < (round.picks ?? []).length; i++) {
        const p = pickFromEspnPick(round.picks![i], i, league);
        if (p) picks.push(p);
      }
    }
    return picks;
  } catch {
    return [];
  }
}

/** Try the pre-draft prospects endpoint (works before the draft). */
async function fetchDraftProspects(league: League): Promise<DraftPickPrediction[]> {
  const url = prospectsUrl(league);
  if (!url) return [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as EspnDraftResponse;
    const athletes = data.items ?? data.athletes ?? [];
    return athletes
      .map((a, i) => prospectToPick(a, i, league))
      .filter((p): p is DraftPickPrediction => p != null)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/**
 * Fetch real draft picks or prospects from ESPN for a given league and year.
 * Tries post-draft picks first, then falls back to pre-draft prospect rankings.
 * Returns an empty array if ESPN has no data for this league/year yet.
 */
export async function fetchLiveDraftPicks(league: League, season: number): Promise<DraftPickPrediction[]> {
  // Try actual picks (post-draft) first
  const picks = await fetchDraftPicks(league, season);
  if (picks.length > 0) return picks;

  // Pre-draft: try prospect rankings
  const prospects = await fetchDraftProspects(league);
  return prospects;
}

/** Current draft year — NFL/NBA/MLB draft year for the current calendar year. */
export function currentDraftSeason(): number {
  return new Date().getFullYear();
}
