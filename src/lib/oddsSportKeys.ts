/**
 * The Odds API (https://the-odds-api.com) — sport `key` strings for /v4/sports/{key}/odds.
 * Free tier: confirm current keys with GET /v4/sports/?all=true (no quota cost).
 *
 * ESPN soccer slug → Odds API key (when both cover the same competition).
 */
export const ODDS_API_SOCCER_KEY_BY_ESPN_SLUG: Record<string, string> = {
  "eng.1": "soccer_epl",
  "esp.1": "soccer_spain_la_liga",
  "ger.1": "soccer_germany_bundesliga",
  "ita.1": "soccer_italy_serie_a",
  "uefa.champions": "soccer_uefa_champs_league",
  "uefa.europa": "soccer_uefa_europa_league",
  "usa.1": "soccer_usa_mls",
};

/** Keys we attempt for soccer enrichment (unique). */
export const ODDS_API_SOCCER_KEYS_SUPPORTED = [
  ...new Set(Object.values(ODDS_API_SOCCER_KEY_BY_ESPN_SLUG)),
] as string[];

/**
 * Extra markets useful for MLB “legs” (first-5 / F5 style) on supported US books.
 * @see https://the-odds-api.com/sports-odds-data/betting-markets.html
 */
export const ODDS_API_MLB_LEG_MARKETS =
  "h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings";
