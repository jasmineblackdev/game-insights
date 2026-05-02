/**
 * Auto-resolve ESPN gameId from a team abbreviation at slip-build
 * time, so the user only ever has to enter the team — never a raw
 * ESPN event id.
 *
 * Why this lives here: the "Track Live Bet" workflow promises that
 * once the slip is submitted, the system handles everything (live
 * polling, auto-settle when final). That promise breaks if the leg
 * has no gameId — the resolver and the live tracker both bail. This
 * module closes that gap by looking up the gameId from the chosen
 * (sport, team, date) before the bet is ever submitted.
 *
 * Behavior:
 *   • Hits ESPN's scoreboard endpoint for the sport + ymd date.
 *   • Walks every event, matches teamLabel against either home or
 *     away abbreviation (case-insensitive).
 *   • Returns the matched event id + canonical home/away abbrs so
 *     the caller can correct a typo back to the canonical form.
 *   • Returns null when no match — caller surfaces "Could not find
 *     game for {team} on {date}" so the user can fix the
 *     abbreviation before submit.
 *
 * No optimizer / schema / ML changes. Pure read-side helper.
 */

const SCOREBOARDS: Record<string, string> = {
  MLB:    "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  NBA:    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  WNBA:   "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard",
  NFL:    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  BOXING: "https://site.api.espn.com/apis/site/v2/sports/boxing/boxing/scoreboard",
  MMA:    "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard",
};

export interface GameIdMatch {
  gameId: string;
  homeAbbr: string;
  awayAbbr: string;
  /** ISO start time so the caller can persist it on the leg. */
  startIso: string | null;
  /** Which side the input matched ("home" or "away"). */
  matchedSide: "home" | "away";
}

interface EspnEventRaw {
  id?: string;
  date?: string;
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: string;
      team?: { abbreviation?: string };
    }>;
  }>;
}

interface ScoreboardResponse {
  events?: EspnEventRaw[];
}

function ymdParam(dateIso: string): string {
  // ESPN expects yyyymmdd. Accept either yyyy-mm-dd or yyyymmdd.
  const compact = dateIso.replace(/-/g, "");
  return compact.slice(0, 8);
}

/**
 * Resolve gameId by sport + team abbreviation + date.
 *
 * @param sport      "MLB" | "NBA" | "WNBA" | "NFL" | "BOXING" | "MMA"
 * @param teamLabel  Team abbreviation as the user typed it; we
 *                   uppercase + trim before comparison.
 * @param dateIso    Either yyyy-mm-dd or yyyymmdd. When omitted,
 *                   defaults to "today" (no date param sent → ESPN
 *                   returns its default board).
 *
 * Returns null when:
 *   • Sport isn't in the SCOREBOARDS map
 *   • Network / parse error
 *   • No event matches the team on that date
 */
export async function resolveGameIdByTeam(args: {
  sport: string;
  teamLabel: string;
  dateIso?: string;
}): Promise<GameIdMatch | null> {
  const url = SCOREBOARDS[args.sport.toUpperCase()];
  if (!url) return null;

  const team = args.teamLabel.trim().toUpperCase();
  if (!team) return null;

  // Build URL — when a date is provided, scope the scan to that day.
  const finalUrl = args.dateIso
    ? `${url}?dates=${ymdParam(args.dateIso)}`
    : url;

  let json: ScoreboardResponse;
  try {
    const res = await fetch(finalUrl);
    if (!res.ok) return null;
    json = (await res.json()) as ScoreboardResponse;
  } catch {
    return null;
  }

  const events = json.events ?? [];
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const homeAbbr = (home?.team?.abbreviation ?? "").toUpperCase();
    const awayAbbr = (away?.team?.abbreviation ?? "").toUpperCase();
    if (homeAbbr === team || awayAbbr === team) {
      return {
        gameId: String(ev.id ?? ""),
        homeAbbr,
        awayAbbr,
        startIso: ev.date ?? null,
        matchedSide: homeAbbr === team ? "home" : "away",
      };
    }
  }

  return null;
}
