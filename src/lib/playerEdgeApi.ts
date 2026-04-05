import {
  getPlayerEdgeById,
  type PlayerEdgePrediction,
  type PlayerEdgeSportFilter,
  type PlayerEdgeStatFilter,
} from "@/data/playerEdgeMock";
import { fetchLivePlayerEdgePredictions } from "@/lib/espnPlayerStats";
import { isSupabaseConfigured } from "@/lib/supabase";

export type PlayerEdgeAccuracyRollup = {
  window: string;
  wins: number;
  losses: number;
  pushes: number;
  total: number;
};

export type PlayerEdgeFetchResult = {
  items: PlayerEdgePrediction[];
  accuracy?: PlayerEdgeAccuracyRollup;
  /** `api` when the network request succeeded; `mock` when using local fallback. */
  source: "api" | "mock";
};

function ensureGameSort(items: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return items.map((p, i) => ({
    ...p,
    game_sort: typeof p.game_sort === "number" ? p.game_sort : i * 10,
  }));
}

function resolvePlayerEdgeDataUrl(): string | null {
  const custom = (import.meta.env.VITE_PLAYER_EDGE_API_URL as string | undefined)?.trim();
  if (custom) return custom;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/player-edge`;
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

function parseAccuracy(raw: unknown): PlayerEdgeAccuracyRollup | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const wins = Number(o.wins);
  const losses = Number(o.losses);
  const pushes = Number(o.pushes);
  const total = Number(o.total);
  if (!Number.isFinite(wins) || !Number.isFinite(losses) || !Number.isFinite(pushes)) return undefined;
  const t = Number.isFinite(total) ? total : wins + losses + pushes;
  return {
    window: typeof o.window === "string" ? o.window : "7d",
    wins,
    losses,
    pushes,
    total: t,
  };
}

async function fetchPlayerEdgeJson(
  baseUrl: string,
  params: Record<string, string | undefined>
): Promise<{ items: PlayerEdgePrediction[]; accuracy?: PlayerEdgeAccuracyRollup }> {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (shouldAttachSupabaseAnonKey(url.toString())) {
    const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers.apikey = key;
    }
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { items?: unknown; accuracy?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  if (!Array.isArray(body.items)) throw new Error("Expected { items: array }");
  return {
    items: body.items as PlayerEdgePrediction[],
    accuracy: parseAccuracy(body.accuracy),
  };
}

/**
 * GET JSON `{ items, accuracy? }` from `VITE_PLAYER_EDGE_API_URL`, or from the Supabase
 * Edge Function `player-edge` when `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` are set.
 * Query params: `sport`, `statType`, optional `id` (single projection).
 * On missing config or request failure, returns mock `items` with `source: 'mock'`.
 */
export async function fetchPlayerEdgePredictions(
  sport: PlayerEdgeSportFilter,
  stat: PlayerEdgeStatFilter
): Promise<PlayerEdgeFetchResult> {
  const dataUrl = resolvePlayerEdgeDataUrl();

  // Custom or Supabase endpoint configured — use it
  if (dataUrl) {
    try {
      const params: Record<string, string | undefined> = {};
      if (sport !== "all") params.sport = sport;
      if (stat !== "all") params.statType = stat;
      const { items, accuracy } = await fetchPlayerEdgeJson(dataUrl, params);
      return { items: ensureGameSort(items), accuracy, source: "api" };
    } catch (e) {
      console.warn("[GameLens] Player Edge API unavailable, falling back to ESPN stats:", e);
    }
  }

  // No custom endpoint — fetch live player stats directly from ESPN
  try {
    const espnItems = await fetchLivePlayerEdgePredictions();
    // Filter by sport/stat if requested
    const filtered = espnItems.filter((p) => {
      if (sport !== "all" && p.sport !== sport) return false;
      if (stat !== "all" && p.stat_type !== stat) return false;
      return true;
    });
    return { items: ensureGameSort(filtered), source: "api" };
  } catch (e) {
    console.warn("[GameLens] ESPN player stats unavailable:", e);
    return { items: [], source: "api" };
  }
}

export async function fetchPlayerEdgeProjectionById(id: string): Promise<PlayerEdgePrediction | null> {
  const dataUrl = resolvePlayerEdgeDataUrl();
  if (dataUrl) {
    try {
      const { items } = await fetchPlayerEdgeJson(dataUrl, { id });
      const list = ensureGameSort(items);
      if (list.length > 0) return list[0] ?? null;
    } catch (e) {
      console.warn("[GameLens] Player Edge detail fetch failed:", e);
    }
  }
  // Try to find in ESPN live data
  try {
    const espnItems = await fetchLivePlayerEdgePredictions();
    return espnItems.find((p) => p.id === id) ?? null;
  } catch {
    return null;
  }
}

/** True when a live endpoint will be used (custom URL or Supabase + deploy). */
export function isPlayerEdgeLiveConfigured(): boolean {
  return resolvePlayerEdgeDataUrl() !== null;
}

export function isSupabasePlayerEdgeConfigured(): boolean {
  return (
    isSupabaseConfigured &&
    Boolean((import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim()) &&
    Boolean((import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()) &&
    !(import.meta.env.VITE_PLAYER_EDGE_API_URL as string | undefined)?.trim()
  );
}
