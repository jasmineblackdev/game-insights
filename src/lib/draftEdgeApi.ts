import type { DraftEdgeCard } from "@/data/draftEdgeTypes";
import type { DraftPickPrediction } from "@/data/draftPicks";
import type { League } from "@/data/mockGames";
import { fetchLiveDraftPicks, currentDraftSeason } from "@/lib/espnDraftProspects";

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

// ── ESPN prospect → DraftEdgeCard converter ────────────────────────────────────

function riskForRank(rank: number): string {
  if (rank <= 5) return "Elite prospect — limited bust risk, but expectations are extremely high at this slot";
  if (rank <= 15) return "Injury history or positional value concerns could temper impact at this range";
  if (rank <= 32) return "Scheme fit risk — success depends on landing spot and coaching system";
  if (rank <= 64) return "Early production not guaranteed; developmental timeline could extend 1–2 seasons";
  return "High variance pick — athletic upside present but translation to pro level unproven";
}

function tierForRank(rank: number): string {
  if (rank <= 5) return "Elite";
  if (rank <= 15) return "Blue chip";
  if (rank <= 32) return "Round 1";
  if (rank <= 64) return "Round 2";
  return "Day 3";
}

function tagsForPick(pick: DraftPickPrediction): string[] {
  const tags: string[] = [];
  const r = pick.pickNumber;
  if (r <= 10) tags.push("top10");
  if (r <= 32) tags.push("round1");
  if (pick.confidence === "high") tags.push("high_confidence");
  if (pick.grade.startsWith("A")) tags.push("high_confidence");
  // positional props
  const propPos = ["QB", "WR", "CB", "DE", "OT", "SP", "PG", "C"];
  if (propPos.includes(pick.position.toUpperCase())) tags.push("position_props");
  // Remove duplicates
  return [...new Set(tags)];
}

function probabilityForRank(rank: number): number {
  if (rank <= 3) return 92;
  if (rank <= 10) return 82;
  if (rank <= 20) return 70;
  if (rank <= 32) return 58;
  if (rank <= 50) return 44;
  return 32;
}

function prospectToEdgeCard(pick: DraftPickPrediction, year: number): DraftEdgeCard {
  const conf: "HIGH" | "MED" | "LOW" =
    pick.confidence === "high" ? "HIGH" : pick.confidence === "medium" ? "MED" : "LOW";

  return {
    id: `espn-${pick.league}-${year}-${pick.pickNumber}`,
    kind: "exact_pick",
    league: pick.league,
    year,
    player_id: `${pick.league}-${pick.pickNumber}`,
    player_name: pick.playerName,
    position: pick.position,
    college: pick.college,
    confidence: conf,
    grade: pick.grade,
    tier: tierForRank(pick.pickNumber),
    reason_1: pick.keyStrength,
    reason_2: pick.projectedImpact,
    risk_factor: riskForRank(pick.pickNumber),
    tags: tagsForPick(pick),
    pick_number: pick.pickNumber,
    predicted_team: pick.teamName !== "TBD" ? pick.teamName : undefined,
    predicted_team_abbr: pick.teamAbbr !== "TBD" ? pick.teamAbbr : undefined,
    probability: probabilityForRank(pick.pickNumber),
    proj_pick_low: Math.max(1, pick.pickNumber - 4),
    proj_pick_high: pick.pickNumber + 6,
  } as DraftEdgeCard;
}

async function fetchEspnFallback(year: number, league: League): Promise<DraftEdgeCard[]> {
  try {
    const picks = await fetchLiveDraftPicks(league, year);
    return picks.map((p) => prospectToEdgeCard(p, year));
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────

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
 * Falls back to ESPN prospect rankings when Supabase returns 0 items.
 */
export async function fetchDraftEdgeCards(year: number, league: League): Promise<DraftEdgeFetchResult> {
  const base = resolveDraftEdgeUrl();

  if (base) {
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
      if (res.ok) {
        const body = await res.json();
        const items = parseItems(body);
        if (items.length > 0) {
          return { items, source: "live" };
        }
        // Supabase returned 0 rows — fall through to ESPN
      }
    } catch (e) {
      console.warn("[GameLens] Draft Edge API unavailable:", e);
    }
  }

  // No Supabase or empty result — use ESPN prospects
  const espnYear = year > 0 ? year : currentDraftSeason();
  const items = await fetchEspnFallback(espnYear, league);
  return { items, source: "live" };
}
