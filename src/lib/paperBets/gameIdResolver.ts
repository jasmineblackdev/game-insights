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
      team?: {
        abbreviation?: string;
        displayName?: string;
        name?: string;
        shortDisplayName?: string;
        location?: string;
      };
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

// ── Athlete lookup ──────────────────────────────────────────────────

const ATHLETE_SEARCH_URL = "https://site.api.espn.com/apis/common/v3/search";

/**
 * League slug ESPN uses for each sport in athlete search results.
 * Used to filter the search response down to the right league when
 * a name matches across multiple leagues (e.g. "Aaron Smith").
 */
const SPORT_LEAGUE_SLUG: Record<string, string> = {
  MLB:  "mlb",
  NBA:  "nba",
  WNBA: "wnba",
  NFL:  "nfl",
};

export interface AthleteMatch {
  athleteId: string;
  displayName: string;
  /** Team abbreviation as ESPN reports it for this athlete. */
  teamAbbr: string | null;
}

interface EspnAthleteHit {
  id?: string;
  uid?: string;
  displayName?: string;
  defaultLeague?: { abbreviation?: string; slug?: string };
  team?: { abbreviation?: string };
}

/**
 * Resolve an ESPN athlete id by full name + sport. Used at slip-add
 * time so the user never has to paste ESPN's numeric id — they just
 * type the player's name and the system links it.
 *
 * Combat sports skip this path (athletes are organized differently
 * in ESPN's index); player props in BOXING/MMA aren't supported as
 * paper bets anyway.
 *
 * Returns null when no match — caller should let the bet ship
 * without an athleteId; the resolver will mark it needs_review with
 * the existing "player_not_in_box_score" diagnosis and the user can
 * Edit bet to correct.
 */
export async function resolveAthleteByName(args: {
  sport: string;
  name: string;
}): Promise<AthleteMatch | null> {
  const slug = SPORT_LEAGUE_SLUG[args.sport.toUpperCase()];
  if (!slug) return null;
  const trimmed = args.name.trim();
  if (!trimmed) return null;

  const url = `${ATHLETE_SEARCH_URL}?query=${encodeURIComponent(trimmed)}&limit=20&type=player`;
  let json: { results?: Array<{ contents?: EspnAthleteHit[] }> };
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    json = await res.json();
  } catch {
    return null;
  }

  // ESPN search nests athletes inside results[].contents[]. Walk all
  // groups, filter to the requested sport's slug, prefer exact name
  // match before substring.
  const all: EspnAthleteHit[] = [];
  for (const group of json.results ?? []) {
    if (!group.contents) continue;
    for (const hit of group.contents) {
      if (hit.id && hit.displayName) all.push(hit);
    }
  }
  const wantedSlug = slug.toLowerCase();
  const sportFiltered = all.filter((h) => {
    const lg = h.defaultLeague?.slug?.toLowerCase()
      ?? h.defaultLeague?.abbreviation?.toLowerCase()
      ?? "";
    return lg.includes(wantedSlug);
  });
  const pool = sportFiltered.length > 0 ? sportFiltered : all;

  const lowerName = trimmed.toLowerCase();
  const exact = pool.find((h) => h.displayName?.toLowerCase() === lowerName);
  const pick = exact ?? pool[0];
  if (!pick?.id) return null;
  return {
    athleteId: String(pick.id),
    displayName: pick.displayName ?? trimmed,
    teamAbbr: pick.team?.abbreviation ?? null,
  };
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

  // Normalize the user-typed string and the side candidates the
  // same way so "NY KNICKS" / "NY Knicks" / "Knicks" / "New York"
  // all match ESPN's "NYK". Without this, only the canonical
  // abbreviation matched and any full-name input failed silently
  // with "no game today" — even when the team was on the slate.
  const norm = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const teamNorm = norm(team);
  const teamTokens = teamNorm.split(" ").filter(Boolean);

  const sideMatches = (
    t: { abbreviation?: string; displayName?: string; name?: string; shortDisplayName?: string; location?: string } | undefined,
  ): boolean => {
    if (!t) return false;
    const abbr = (t.abbreviation ?? "").toUpperCase();
    if (abbr && abbr === team) return true; // fast path: exact abbr
    const candidates = [
      t.abbreviation,
      t.displayName,
      t.name,
      t.shortDisplayName,
      t.location && t.name ? `${t.location} ${t.name}` : undefined,
    ].filter((s): s is string => typeof s === "string" && s.length > 0).map(norm);
    if (candidates.includes(teamNorm)) return true;
    // Strict subset — every user token appears in some candidate.
    // Catches "Knicks" → matches name "knicks", and "Brooklyn Nets"
    // → matches displayName "brooklyn nets".
    const strict = teamTokens.length > 0 && candidates.some((c) => {
      const cTokens = c.split(" ").filter(Boolean);
      return teamTokens.every((tok) => cTokens.includes(tok));
    });
    if (strict) return true;
    // Loose — at least one substantial user token (≥4 chars)
    // appears as a substring inside any candidate. Catches
    // "NY KNICKS" → "knicks" substring of "new york knicks", and
    // typo cases like "knick" → still matches "knicks". The 4-char
    // gate prevents false positives from short prefixes ("ny",
    // "la", "sf") landing in unrelated team names.
    return teamTokens.some((tok) =>
      tok.length >= 4 && candidates.some((c) => c.includes(tok)),
    );
  };

  const events = json.events ?? [];
  for (const ev of events) {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    const homeAbbr = (home?.team?.abbreviation ?? "").toUpperCase();
    const awayAbbr = (away?.team?.abbreviation ?? "").toUpperCase();
    const homeMatched = sideMatches(home?.team);
    const awayMatched = sideMatches(away?.team);
    if (homeMatched || awayMatched) {
      return {
        gameId: String(ev.id ?? ""),
        homeAbbr,
        awayAbbr,
        startIso: ev.date ?? null,
        matchedSide: homeMatched ? "home" : "away",
      };
    }
  }

  return null;
}
