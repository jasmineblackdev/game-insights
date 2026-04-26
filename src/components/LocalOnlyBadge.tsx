/**
 * LocalOnlyBadge — small chip surfaced when Supabase isn't configured
 * (or anon — future: when there's no signed-in session). Tells users
 * that bankroll/picks/parlay-history won't sync across devices, so a
 * fresh device or browser starts from a clean ledger.
 */

import { CloudOff } from "lucide-react";
import { isSupabaseConfigured } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export function LocalOnlyBadge({ className }: { className?: string }) {
  if (isSupabaseConfigured) return null;
  return (
    <span
      title="Cloud sync unavailable — bankroll, picks, and parlay history are saved on this device only and won't carry to other browsers."
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
        "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20",
        className,
      )}
    >
      <CloudOff className="w-3 h-3" />
      Local only
    </span>
  );
}
