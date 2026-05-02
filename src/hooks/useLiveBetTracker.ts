/**
 * useLiveBetTracker — page-visibility-gated polling for open paper
 * bets marked bet_timing="live".
 *
 * Behavior:
 *   • Polls every 60 seconds (matches the approved scope).
 *   • Pauses when the tab is hidden (document.visibilityState).
 *   • Coalesces by gameId so one ESPN summary call covers every bet
 *     on the same game.
 *   • Calls the provided onChanged() when any bet's state changed
 *     (settled / live updated / needs review) so the parent can
 *     refetch.
 *   • Silent: failures log to console.warn and never throw.
 *
 * Strict no-ops when:
 *   • candidates list is empty
 *   • document is hidden
 *   • Supabase isn't configured
 *
 * No optimizer or schema changes — just runs the existing resolver
 * path on a timer.
 */

import { useEffect, useRef } from "react";
import { tickLiveBet, type LiveTickAction } from "@/lib/paperBets/liveTracker";
import type { PaperBet } from "@/lib/paperBets/types";

const POLL_MS = 60_000;

interface Args {
  bets: PaperBet[];
  /** Fired after each tick when at least one bet changed. */
  onChanged?: () => void;
}

export function useLiveBetTracker({ bets, onChanged }: Args): void {
  // Stable ref so the interval callback always sees the latest list
  // without retriggering the effect every time bets refetches.
  const betsRef = useRef<PaperBet[]>(bets);
  betsRef.current = bets;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const inflightRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const tick = async (): Promise<void> => {
      if (inflightRef.current) return; // last cycle still running
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const liveOpen = betsRef.current.filter((b) =>
        b.betTiming === "live"
        && (b.status === "open" || b.status === "in_progress" || b.status === "needs_review"),
      );
      if (!liveOpen.length) return;

      inflightRef.current = true;
      try {
        const actions = await Promise.all(liveOpen.map((b) => tickLiveBet(b)));
        const changed = actions.some(
          (a: LiveTickAction) => a === "settled" || a === "live_updated" || a === "needs_review",
        );
        if (changed) onChangedRef.current?.();
      } finally {
        inflightRef.current = false;
      }
    };

    // Kick once immediately so a freshly-opened tab gets current
    // state without waiting POLL_MS for the first cycle.
    void tick();

    const id = window.setInterval(() => { void tick(); }, POLL_MS);

    // Resume promptly when the tab regains focus.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
