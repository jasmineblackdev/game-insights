import { DRAFT_EDGE_MOCK_NFL } from "@/data/draftEdgeMock";
import type { DraftEdgeCard } from "@/data/draftEdgeTypes";
import { isSupabaseConfigured } from "@/lib/supabase";

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

export type DraftEdgeFetchResult = {
  items: DraftEdgeCard[];
  source: "api" | "mock";
};

/**
 * GET `{ items: DraftEdgeCard[] }` from `draft-edge` (query: year, league).
 * Falls back to local NFL mock when unset or on error.
 */
export async function fetchDraftEdgeCards(
  year: number,
  league: "nfl" | "nba"
): Promise<DraftEdgeFetchResult> {
  const mock =
    league === "nfl" ? DRAFT_EDGE_MOCK_NFL.filter((c) => c.year === year) : [];

  const base = resolveDraftEdgeUrl();
  if (!base || !isSupabaseConfigured) {
    return { items: mock.length ? [...mock] : [], source: "mock" };
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
    if (!items.length) throw new Error("Empty items");
    return { items, source: "api" };
  } catch (e) {
    console.warn("[GameLens] Draft Edge API unavailable, using mock:", e);
    return { items: mock.length ? [...mock] : [], source: "mock" };
  }
}
