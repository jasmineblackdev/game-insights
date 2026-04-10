/**
 * Team abbreviations aligned with Parlay-Intelligence-Bot `normalize_team_name` / basketball map.
 */
import type { League } from "@/data/mockGames";

const NBA_COMPACT: Record<string, string> = {
  atlantahawks: "ATL",
  hawks: "ATL",
  atl: "ATL",
  bostonceltics: "BOS",
  celtics: "BOS",
  bos: "BOS",
  brooklynnets: "BKN",
  nets: "BKN",
  bkn: "BKN",
  charlottehornets: "CHA",
  hornets: "CHA",
  cha: "CHA",
  chicagobulls: "CHI",
  bulls: "CHI",
  chi: "CHI",
  clevelandcavaliers: "CLE",
  cavaliers: "CLE",
  cavs: "CLE",
  cle: "CLE",
  dallasmavericks: "DAL",
  mavericks: "DAL",
  mavs: "DAL",
  dal: "DAL",
  denvernuggets: "DEN",
  nuggets: "DEN",
  den: "DEN",
  detroitpistons: "DET",
  pistons: "DET",
  det: "DET",
  goldenstatewarriors: "GSW",
  warriors: "GSW",
  gsw: "GSW",
  houstonrockets: "HOU",
  rockets: "HOU",
  hou: "HOU",
  indianapacers: "IND",
  pacers: "IND",
  ind: "IND",
  losangelesclippers: "LAC",
  clippers: "LAC",
  lac: "LAC",
  losangeleslakers: "LAL",
  lakers: "LAL",
  lal: "LAL",
  memphisgrizzlies: "MEM",
  grizzlies: "MEM",
  mem: "MEM",
  miamiheat: "MIA",
  heat: "MIA",
  mia: "MIA",
  milwaukeebucks: "MIL",
  bucks: "MIL",
  mil: "MIL",
  minnesotatimberwolves: "MIN",
  timberwolves: "MIN",
  wolves: "MIN",
  min: "MIN",
  neworleanspelicans: "NOP",
  pelicans: "NOP",
  nop: "NOP",
  newyorkknicks: "NYK",
  knicks: "NYK",
  nyk: "NYK",
  oklahomacitythunder: "OKC",
  thunder: "OKC",
  okc: "OKC",
  orlandomagic: "ORL",
  magic: "ORL",
  orl: "ORL",
  philadelphia76ers: "PHI",
  phi: "PHI",
  phoenixsuns: "PHX",
  suns: "PHX",
  phx: "PHX",
  portlandtrailblazers: "POR",
  blazers: "POR",
  trailblazers: "POR",
  por: "POR",
  sacramentokings: "SAC",
  kings: "SAC",
  sac: "SAC",
  sanantoniospurs: "SAS",
  spurs: "SAS",
  sas: "SAS",
  torontoraptors: "TOR",
  raptors: "TOR",
  tor: "TOR",
  utahjazz: "UTA",
  jazz: "UTA",
  uta: "UTA",
  washingtonwizards: "WAS",
  wizards: "WAS",
  was: "WAS",
};

const NFL_MAP: Record<string, string> = {
  "arizona cardinals": "ARI",
  cardinals: "ARI",
  ari: "ARI",
  "atlanta falcons": "ATL",
  falcons: "ATL",
  "baltimore ravens": "BAL",
  ravens: "BAL",
  "buffalo bills": "BUF",
  bills: "BUF",
  "carolina panthers": "CAR",
  panthers: "CAR",
  "chicago bears": "CHI",
  bears: "CHI",
  "cincinnati bengals": "CIN",
  bengals: "CIN",
  "cleveland browns": "CLE",
  browns: "CLE",
  "dallas cowboys": "DAL",
  cowboys: "DAL",
  "denver broncos": "DEN",
  broncos: "DEN",
  "detroit lions": "DET",
  lions: "DET",
  "green bay packers": "GB",
  packers: "GB",
  gb: "GB",
  "houston texans": "HOU",
  texans: "HOU",
  "indianapolis colts": "IND",
  colts: "IND",
  "jacksonville jaguars": "JAX",
  jaguars: "JAX",
  "kansas city chiefs": "KC",
  chiefs: "KC",
  kc: "KC",
  "las vegas raiders": "LV",
  raiders: "LV",
  lv: "LV",
  "los angeles chargers": "LAC",
  chargers: "LAC",
  lac: "LAC",
  "los angeles rams": "LA",
  rams: "LA",
  la: "LA",
  "miami dolphins": "MIA",
  dolphins: "MIA",
  "minnesota vikings": "MIN",
  vikings: "MIN",
  "new england patriots": "NE",
  patriots: "NE",
  ne: "NE",
  "new orleans saints": "NO",
  saints: "NO",
  no: "NO",
  "new york giants": "NYG",
  giants: "NYG",
  nyg: "NYG",
  "new york jets": "NYJ",
  jets: "NYJ",
  nyj: "NYJ",
  "philadelphia eagles": "PHI",
  eagles: "PHI",
  "pittsburgh steelers": "PIT",
  steelers: "PIT",
  "san francisco 49ers": "SF",
  "49ers": "SF",
  niners: "SF",
  sf: "SF",
  "seattle seahawks": "SEA",
  seahawks: "SEA",
  sea: "SEA",
  "tampa bay buccaneers": "TB",
  buccaneers: "TB",
  bucs: "TB",
  tb: "TB",
  "tennessee titans": "TEN",
  titans: "TEN",
  ten: "TEN",
  "washington commanders": "WAS",
  commanders: "WAS",
  was: "WAS",
  "oakland raiders": "LV",
  "san diego chargers": "LAC",
  "st. louis rams": "LA",
  "st louis rams": "LA",
  "washington football team": "WAS",
  "washington redskins": "WAS",
};

function nbaKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, "");
}

/** Resolve display abbreviation for matchup strings and team names. */
export function normalizeTeamAbbrev(teamName: string, league: League): string {
  const raw = teamName.trim();
  if (!raw) return "";
  if (league === "nba") {
    const k = nbaKey(raw);
    if (NBA_COMPACT[k]) return NBA_COMPACT[k];
    const noSpace = raw.toLowerCase().replace(/\s+/g, "");
    if (NBA_COMPACT[noSpace]) return NBA_COMPACT[noSpace];
    for (const [key, abbr] of Object.entries(NBA_COMPACT)) {
      if (key.length > 4 && k.includes(key)) return abbr;
    }
    return raw.length <= 4 ? raw.toUpperCase() : raw
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }
  if (league === "nfl") {
    const k = raw.toLowerCase().trim();
    if (NFL_MAP[k]) return NFL_MAP[k];
    return raw.length <= 4 ? raw.toUpperCase() : raw
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }
  if (raw.length <= 4) return raw.toUpperCase();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts
      .map((p) => p[0])
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }
  return raw.slice(0, 3).toUpperCase();
}

/**
 * If `matchupLabel` looks like "Away @ Home" or "Away vs Home", emit `Away (ABB) vs Home (ABB)`.
 * Otherwise returns the original label.
 */
export function formatMatchupWithAbbrevs(matchupLabel: string, sport: League): string {
  const label = matchupLabel.trim();
  let away: string | undefined;
  let home: string | undefined;
  if (label.includes("@")) {
    const [a, h] = label.split("@", 2).map((s) => s.trim());
    away = a;
    home = h;
  } else if (/ vs\.? /i.test(label)) {
    const [a, h] = label.split(/\bvs\.?\b/i, 2).map((s) => s.trim());
    away = a;
    home = h;
  }
  if (!away || !home) return label;
  const aa = normalizeTeamAbbrev(away, sport);
  const ha = normalizeTeamAbbrev(home, sport);
  return `${away} (${aa}) vs ${home} (${ha})`;
}
