import { draftEdgeMockForLeague } from "@/data/draftEdgeMock";
import type { DraftEdgeCard } from "@/data/draftEdgeTypes";
import type { League } from "@/data/mockGames";

function resolveDraftEdgeUrl(): string | null {
  const custom = (import.meta.env.VITE_DRAFT_EDGE_API_URL as string | undefined)?.trim();
  if (custom) return custom;
  const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
  const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
  if (url && key) {
    return `${url.replace(/\/$/, "")}/functions/v1/draft-edge`;
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

function parseItems(raw: unknown): DraftEdgeCard[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as { items?: unknown };
  if (!Array.isArray(o.items)) return [];
  return o.items.filter((x): x is DraftEdgeCard => x != null && typeof x === "object" && "id" in x && "kind" in x);
}

export type DraftEdgeDataSource = "live" | "mock";

/** Why sample/mock cards are shown (only when source is mock). */
export type DraftEdgeMockReason = "not_configured" | "live_unavailable";

export type DraftEdgeFetchResult = {
  items: DraftEdgeCard[];
  source: DraftEdgeDataSource;
  /** Set when source is mock — drives footer copy in the UI. */
  mockReason?: DraftEdgeMockReason;
};

/**
 * GET `{ items: DraftEdgeCard[] }` from `draft-edge` (query: year, league).
 * Returns live database-backed rows when Supabase env + Edge Function succeed; otherwise local sample cards.
 */
export async function fetchDraftEdgeCards(year: number, league: League): Promise<DraftEdgeFetchResult> {
  const mock = draftEdgeMockForLeague(league, year);

  const base = resolveDraftEdgeUrl();
  if (!base) {
    return {
      items: mock.length ? [...mock] : [],
      source: "mock",
      mockReason: "not_configured",
    };
  }

  try {
    const url = new URL(base);
    url.searchParams.set("year", String(year));
    url.searchParams.set("league", league);

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
    const body = await res.json();
    const items = parseItems(body);
    // Live backend can legitimately return zero rows for a league/year — still counts as connected.
    return { items, source: "live" };
  } catch (e) {
    console.warn("[GameLens] Draft Edge live data unavailable, using sample cards:", e);
    return {
      items: mock.length ? [...mock] : [],
      source: "mock",
      mockReason: "live_unavailable",
    };
  }
}
