import { isSupabaseConfigured } from "@/lib/supabase";

export type NbaAdvancedRatingsPayload = {
  season: string;
  seasonType?: string;
  source: string;
  ratings: Record<string, { offRtg: number; defRtg: number; pace: number }>;
};

/** ESPN abbreviations that differ from stats.nba.com TEAM_ABBREVIATION. */
const ESPN_TO_NBA_ABBR: Record<string, string> = {
  GS: "GSW",
  NY: "NYK",
  NO: "NOP",
  SA: "SAS",
  PHO: "PHX",
  WSH: "WAS",
  CHO: "CHA",
};

export function normalizeEspnToNbaStatsAbbr(espnAbbr: string): string {
  const u = espnAbbr.trim().toUpperCase();
  return ESPN_TO_NBA_ABBR[u] ?? u;
}

function resolveNbaStatsProxyUrl(): string | null {
  const custom = (import.meta.env.VITE_NBA_STATS_PROXY_URL as string | undefined)?.trim();
  if (custom) return custom;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/nba-stats-proxy`;
  }
  return null;
}

function shouldAttachSupabaseAnonKey(targetUrl: string): boolean {
  const sup = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  if (!sup) return false;
  try {
    return new URL(targetUrl).origin === new URL(sup).origin;
  } catch {
    return false;
  }
}

/**
 * Fetches league advanced team stats (ORtg, DRtg, pace) via Supabase Edge proxy.
 * Returns null if URL unset, Supabase not configured, or upstream fails.
 */
export async function fetchNbaAdvancedRatingsViaProxy(): Promise<NbaAdvancedRatingsPayload | null> {
  if (!isSupabaseConfigured) return null;
  const base = resolveNbaStatsProxyUrl();
  if (!base) return null;

  try {
    const url = new URL(base);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (shouldAttachSupabaseAnonKey(url.toString())) {
      const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
      if (key) {
        headers.Authorization = `Bearer ${key}`;
        headers.apikey = key;
      }
    }

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as NbaAdvancedRatingsPayload & { error?: string };
    if (body.error || !body.ratings || typeof body.ratings !== "object") return null;
    return body;
  } catch (e) {
    console.warn("[GameLens] nba-stats-proxy unavailable:", e);
    return null;
  }
}
