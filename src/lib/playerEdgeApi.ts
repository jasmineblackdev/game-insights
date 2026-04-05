import {
  PLAYER_EDGE_MOCK,
  type PlayerEdgePrediction,
  type PlayerEdgeSportFilter,
  type PlayerEdgeStatFilter,
} from "@/data/playerEdgeMock";

function ensureGameSort(items: PlayerEdgePrediction[]): PlayerEdgePrediction[] {
  return items.map((p, i) => ({
    ...p,
    game_sort: typeof p.game_sort === "number" ? p.game_sort : i * 10,
  }));
}

/**
 * GET JSON `{ items: PlayerEdgePrediction[] }` from `VITE_PLAYER_EDGE_API_URL`.
 * Use an absolute URL (e.g. `https://your-project.supabase.co/functions/v1/player-edge`).
 * If unset or the request fails, returns a copy of local mock data.
 */
export async function fetchPlayerEdgePredictions(
  sport: PlayerEdgeSportFilter,
  stat: PlayerEdgeStatFilter
): Promise<PlayerEdgePrediction[]> {
  const raw = (import.meta.env.VITE_PLAYER_EDGE_API_URL as string | undefined)?.trim();
  if (!raw) {
    return ensureGameSort([...PLAYER_EDGE_MOCK]);
  }

  try {
    const url = new URL(raw);
    if (sport !== "all") url.searchParams.set("sport", sport);
    if (stat !== "all") url.searchParams.set("statType", stat);

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) throw new Error("Expected { items: array }");
    return ensureGameSort(body.items as PlayerEdgePrediction[]);
  } catch (e) {
    console.warn("[GameLens] Player Edge API unavailable, using mock:", e);
    return ensureGameSort([...PLAYER_EDGE_MOCK]);
  }
}

export function isPlayerEdgeApiConfigured(): boolean {
  return Boolean((import.meta.env.VITE_PLAYER_EDGE_API_URL as string | undefined)?.trim());
}
