import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/useSupabaseSession";

type FavRow = { sport: string; player_external_id: string };

function favKey(p: PlayerEdgePrediction): string {
  return `${p.sport}:${p.player_id}`;
}

export function usePlayerEdgeFavorites() {
  const session = useSupabaseSession();
  const qc = useQueryClient();
  const userId = session?.user?.id;

  const listQuery = useQuery({
    queryKey: ["user-favorite-players", userId],
    queryFn: async (): Promise<FavRow[]> => {
      if (!supabase || !userId) return [];
      const { data, error } = await supabase
        .from("user_favorite_players")
        .select("sport, player_external_id");
      if (error) throw error;
      return (data ?? []) as FavRow[];
    },
    enabled: isSupabaseConfigured && !!supabase && !!userId,
  });

  const set = new Set((listQuery.data ?? []).map((r) => `${r.sport}:${r.player_external_id}`));

  const toggle = useMutation({
    mutationFn: async (p: PlayerEdgePrediction) => {
      if (!supabase) throw new Error("no_supabase");
      if (!userId) throw new Error("no_session");
      const rows = qc.getQueryData<FavRow[]>(["user-favorite-players", userId]) ?? [];
      const favorited = rows.some((r) => r.sport === p.sport && r.player_external_id === p.player_id);
      if (favorited) {
        const { error } = await supabase
          .from("user_favorite_players")
          .delete()
          .eq("user_id", userId)
          .eq("sport", p.sport)
          .eq("player_external_id", p.player_id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("user_favorite_players").insert({
          user_id: userId,
          sport: p.sport,
          player_external_id: p.player_id,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["user-favorite-players", userId] });
    },
    onError: (e: Error) => {
      if (e.message === "no_session") toast.message("Sign in to save favorites");
      else if (e.message !== "no_supabase") toast.error("Could not update favorite");
    },
  });

  return {
    showFavoritesUi: isSupabaseConfigured && !!supabase,
    isSignedIn: !!userId,
    favoritesReady: !userId || !listQuery.isPending,
    isFav: (p: PlayerEdgePrediction) => set.has(favKey(p)),
    toggleFavorite: (p: PlayerEdgePrediction) => {
      if (!userId) {
        toast.message("Sign in to save favorites");
        return;
      }
      toggle.mutate(p);
    },
    togglePending: toggle.isPending,
  };
}
