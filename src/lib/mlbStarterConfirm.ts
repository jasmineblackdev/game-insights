import type { GamePrediction } from "@/data/mockGames";
import { queryClient } from "@/lib/queryClient";
import { supabase } from "@/lib/supabase";

function invalidateMlbCaches() {
  void queryClient.invalidateQueries({ queryKey: ["mlb-espn-enriched"] });
  void queryClient.invalidateQueries({ queryKey: ["mlb-modeled"] });
}

const STORAGE_KEY = "gamelens-mlb-starters-v1";

const TABLE = "mlb_starter_user_confirmations" as const;

function readRaw(): Record<string, boolean> {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (!s) return {};
    const o = JSON.parse(s) as unknown;
    if (!o || typeof o !== "object") return {};
    return o as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function isMlbStartersUserConfirmed(gameId: string): boolean {
  return readRaw()[gameId] === true;
}

/** Merge cloud rows into localStorage. Returns true if anything changed. */
export async function pullMlbStarterConfirmationsFromSupabase(): Promise<boolean> {
  if (!supabase) return false;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) return false;

  const { data, error } = await supabase.from(TABLE).select("game_id, confirmed");
  if (error || !data?.length) return false;

  const local = readRaw();
  let changed = false;
  for (const row of data as { game_id: string; confirmed: boolean }[]) {
    if (row.confirmed) {
      if (!local[row.game_id]) {
        local[row.game_id] = true;
        changed = true;
      }
    } else if (local[row.game_id]) {
      delete local[row.game_id];
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
    } catch {
      /* quota */
    }
    invalidateMlbCaches();
  }
  return changed;
}

async function persistMlbStarterConfirmationToCloud(gameId: string, confirmed: boolean): Promise<void> {
  if (!supabase) return;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) return;
  const uid = session.user.id;

  if (!confirmed) {
    const { error } = await supabase.from(TABLE).delete().eq("game_id", gameId);
    if (error) console.warn("mlb_starter_confirm delete:", error.message);
    else invalidateMlbCaches();
    return;
  }

  const { error } = await supabase.from(TABLE).upsert(
    {
      user_id: uid,
      game_id: gameId,
      confirmed: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,game_id" }
  );
  if (error) console.warn("mlb_starter_confirm upsert:", error.message);
  else invalidateMlbCaches();
}

export function setMlbStartersUserConfirmed(gameId: string, confirmed: boolean): void {
  const next = readRaw();
  if (confirmed) next[gameId] = true;
  else delete next[gameId];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  void persistMlbStarterConfirmationToCloud(gameId, confirmed);
}

/** Merge local "I verified starters" flags into `_meta` before running the MLB model. */
export function mergeMlbStarterConfirmations(games: GamePrediction[]): GamePrediction[] {
  const raw = readRaw();
  return games.map((g) => {
    if (g.league !== "mlb" || !g._meta) return g;
    if (!raw[g.id]) return g;
    return {
      ...g,
      _meta: { ...g._meta, userConfirmedMlbStarters: true },
    };
  });
}
