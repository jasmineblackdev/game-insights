import type { CollegeSportId, FuturesMarketTypeV1 } from "@/lib/collegeFuturesTypes";

export type CollegeFuturesSportConfig = {
  id: CollegeSportId;
  label: string;
  shortLabel: string;
  leagueKey: string;
  /** Default Odds API `sport_key` for /v4/sports/{key}/odds?markets=outrights — override via env if catalog shifts. */
  defaultOddsSportKey: string;
  envOverrideKey: "VITE_ODDS_COLLEGE_FOOTBALL_SPORT_KEY" | "VITE_ODDS_COLLEGE_BASKETBALL_SPORT_KEY" | "VITE_ODDS_COLLEGE_BASEBALL_SPORT_KEY";
  competitionName: string;
};

export const COLLEGE_FUTURES_SPORTS: CollegeFuturesSportConfig[] = [
  {
    id: "college_football",
    label: "College Football",
    shortLabel: "CFB",
    leagueKey: "ncaaf",
    defaultOddsSportKey: "americanfootball_ncaaf_championship",
    envOverrideKey: "VITE_ODDS_COLLEGE_FOOTBALL_SPORT_KEY",
    competitionName: "College Football National Champion",
  },
  {
    id: "college_basketball",
    label: "College Basketball",
    shortLabel: "CBB",
    leagueKey: "ncaab",
    defaultOddsSportKey: "basketball_ncaab_championship",
    envOverrideKey: "VITE_ODDS_COLLEGE_BASKETBALL_SPORT_KEY",
    competitionName: "NCAA Men's Basketball Champion",
  },
  {
    id: "college_baseball",
    label: "College Baseball",
    shortLabel: "CWS",
    leagueKey: "ncaa_baseball",
    defaultOddsSportKey: "baseball_ncaa_world_series",
    envOverrideKey: "VITE_ODDS_COLLEGE_BASEBALL_SPORT_KEY",
    competitionName: "College World Series Champion",
  },
];

export function resolveOddsSportKey(cfg: CollegeFuturesSportConfig): string {
  const raw = (import.meta.env as Record<string, string | undefined>)[cfg.envOverrideKey];
  const trimmed = raw?.trim();
  if (trimmed && /^[a-zA-Z0-9_]+$/.test(trimmed)) return trimmed;
  return cfg.defaultOddsSportKey;
}

export const COLLEGE_FUTURES_V1_MARKET: FuturesMarketTypeV1 = "national_champion";
