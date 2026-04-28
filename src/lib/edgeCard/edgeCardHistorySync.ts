/**
 * EdgeCard history sync — durable backup of slip history that
 * previously lived only in localStorage.
 *
 * Two writes:
 *   - upsertEdgeCardHistoryEntry: called from EdgeCardContext on
 *     saveSlipToHistory + setHistoryOutcome. Idempotent via client_id
 *     so re-saves don't pile up rows.
 *   - mergeFromRemote: called once on EdgeCardContext mount; pulls
 *     any remote rows the local cache doesn't have (e.g. user
 *     switched browsers / cleared cache).
 *
 * All writes are fire-and-forget — never block the UI on the network.
 */

import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { normalizeEdgeCardSizeFromStorage, type EdgeHistoryEntry } from "@/lib/edgeCardScoring";

export type EdgeCardHistorySource = "edge_card" | "edge_card_legacy";

export interface EdgeCardHistoryRow {
  client_id: string;
  saved_at: string;
  card_size: number;
  items: unknown;
  aggregate_confidence: string | null;
  risk_label: "controlled" | "moderate" | "elevated" | null;
  outcome: "win" | "loss" | "push" | null;
  source: EdgeCardHistorySource;
}

function entryToRow(entry: EdgeHistoryEntry, source: EdgeCardHistorySource = "edge_card"): EdgeCardHistoryRow {
  return {
    client_id: entry.id,
    saved_at: entry.savedAt,
    card_size: entry.size,
    items: entry.items,
    aggregate_confidence: entry.aggregateConfidence ?? null,
    risk_label: (entry.riskLabel as "controlled" | "moderate" | "elevated" | undefined) ?? null,
    outcome: (entry.outcome as "win" | "loss" | "push" | undefined) ?? null,
    source,
  };
}

export async function upsertEdgeCardHistoryEntry(
  entry: EdgeHistoryEntry,
  source: EdgeCardHistorySource = "edge_card",
): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;
  const row = entryToRow(entry, source);
  try {
    await supabase
      .from("edge_card_history")
      .upsert(row, { onConflict: "client_id" });
  } catch {
    // Never surface DB errors to the UI; localStorage already has the row.
  }
}

/**
 * Pull remote rows the local cache doesn't have by client_id. Returns
 * the merged list (caller updates state with it). Capped at 100 rows
 * — same as the local cap.
 */
export async function loadRemoteHistoryMerge(
  local: EdgeHistoryEntry[],
): Promise<EdgeHistoryEntry[]> {
  if (!isSupabaseConfigured || !supabase) return local;
  try {
    const { data, error } = await supabase
      .from("edge_card_history")
      .select("client_id, saved_at, card_size, items, aggregate_confidence, risk_label, outcome")
      .order("saved_at", { ascending: false })
      .limit(100);
    if (error || !data) return local;
    const localIds = new Set(local.map((e) => e.id));
    const remoteOnly: EdgeHistoryEntry[] = [];
    for (const r of data as Array<{
      client_id: string;
      saved_at: string;
      card_size: number;
      items: unknown;
      aggregate_confidence: string | null;
      risk_label: string | null;
      outcome: string | null;
    }>) {
      if (!r.client_id || localIds.has(r.client_id)) continue;
      remoteOnly.push({
        id: r.client_id,
        savedAt: r.saved_at,
        size: normalizeEdgeCardSizeFromStorage(r.card_size),
        items: Array.isArray(r.items) ? (r.items as EdgeHistoryEntry["items"]) : [],
        aggregateConfidence: (r.aggregate_confidence ?? "low") as EdgeHistoryEntry["aggregateConfidence"],
        riskLabel: (r.risk_label ?? "controlled") as EdgeHistoryEntry["riskLabel"],
        outcome: (r.outcome === "win" || r.outcome === "loss" || r.outcome === "push" ? r.outcome : undefined) as EdgeHistoryEntry["outcome"],
      });
    }
    if (!remoteOnly.length) return local;
    // Merge by saved_at desc, cap at 30 (same as local cap).
    return [...local, ...remoteOnly]
      .sort((a, b) => (a.savedAt > b.savedAt ? -1 : 1))
      .slice(0, 30);
  } catch {
    return local;
  }
}
