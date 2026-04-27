/**
 * DailyParlayCheckBanner — light-touch nudge that fires when today's
 * app_recommended parlays haven't been generated yet.
 *
 * Why it exists: the optimizer only auto-saves recommended_parlays
 * rows when ParlayBuilderSection renders. If the user opens the app
 * but never navigates to the parlay builder, no recommendations
 * exist for the day — and the auto-resolver has nothing to resolve,
 * the pattern coach has no fresh data, etc.
 *
 * Behavior:
 *   - Queries recommended_parlays for today's app_recommended rows
 *   - When count === 0: renders a banner with a "Generate now" CTA
 *     that flips the home view to the parlay builder. Once builder
 *     mounts, optimizer auto-saves the day's variants.
 *   - Dismiss button stores a sessionStorage flag keyed on today's
 *     date so the banner doesn't keep nagging if the user actively
 *     decided to skip generation that day.
 *   - Auto-hides once any rows exist for today (no manual refresh).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

const DISMISS_KEY_PREFIX = "gamelens-daily-parlay-banner-dismissed";

function todayYmdLocal(): string {
  // Local-time YYYY-MM-DD; the recommended_parlays.date column uses
  // current_date in the DB's tz, but for "did the user generate today?"
  // a local-time check is what feels right to the user.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface Props {
  onGenerate: () => void;
}

export function DailyParlayCheckBanner({ onGenerate }: Props) {
  const today = useMemo(() => todayYmdLocal(), []);
  const dismissKey = `${DISMISS_KEY_PREFIX}:${today}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(dismissKey) === "1"; }
    catch { return false; }
  });

  const { data: hasToday, isPending } = useQuery({
    queryKey: ["recommended-parlays-today-count", today],
    enabled: isSupabaseConfigured && !!supabase && !dismissed,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      if (!supabase) return false;
      const { count } = await supabase
        .from("recommended_parlays")
        .select("id", { count: "exact", head: true })
        .eq("source", "app_recommended")
        .eq("date", today);
      return (count ?? 0) > 0;
    },
  });

  // Reset dismiss flag at midnight roll-over via the date-keyed key —
  // sessionStorage entry expires implicitly because tomorrow's key differs.
  useEffect(() => {
    try { sessionStorage.removeItem(`${DISMISS_KEY_PREFIX}:${today}-old`); } catch { /* noop */ }
  }, [today]);

  if (dismissed) return null;
  if (isPending) return null;
  if (hasToday) return null;

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(dismissKey, "1"); } catch { /* noop */ }
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.06] px-4 py-3 flex items-start gap-3">
      <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-foreground">
          No recommended parlays generated for today yet
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          The optimizer auto-saves the day's parlay variants when you open the
          builder — generate now so the auto-resolver has fresh picks to grade
          tonight.
        </p>
      </div>
      <Button size="sm" variant="default" className="shrink-0 gap-1" onClick={onGenerate}>
        Generate now
        <ChevronRight className="w-3.5 h-3.5" />
      </Button>
      <button
        type="button"
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground p-0.5"
        title="Dismiss until tomorrow"
        aria-label="Dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
