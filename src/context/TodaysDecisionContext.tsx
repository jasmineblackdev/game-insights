/**
 * TodaysDecisionContext — exposes the day-level Today's Decision
 * verdict to descendant components so they can suppress conflicting
 * "strong recommendation" signals when the discipline call is SKIP.
 *
 * Phase 5 of the consolidation. Pure UI/visibility layer — no
 * scoring, no optimizer, no schema. Reads:
 *   verdict       — BET | MODIFY | SKIP | null (still loading)
 *
 * When verdict === "SKIP", any descendant showing strong-rec pills
 * (HIGH conf, SHARP EDGE, PLACE decisions) should mute them, or at
 * least show a slate-level note that these are advisory only.
 *
 * The provider is intentionally optional — components fall back to
 * `null` (no suppression) when not wrapped, so the consolidation
 * can roll out incrementally without breaking unwrapped surfaces.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { DecisionVerdict } from "@/lib/insights/todaysDecision";

interface ContextValue {
  verdict: DecisionVerdict | null;
}

const TodaysDecisionContext = createContext<ContextValue>({ verdict: null });

export function TodaysDecisionProvider({
  verdict,
  children,
}: {
  verdict: DecisionVerdict | null;
  children: ReactNode;
}) {
  return (
    <TodaysDecisionContext.Provider value={{ verdict }}>
      {children}
    </TodaysDecisionContext.Provider>
  );
}

/**
 * Read the day-level verdict. Returns null when no provider is
 * mounted upstream — descendants treat that as "no suppression."
 */
export function useTodaysDecisionVerdict(): DecisionVerdict | null {
  return useContext(TodaysDecisionContext).verdict;
}

/**
 * Convenience boolean — true when discipline says SKIP.
 */
export function useDayIsSkip(): boolean {
  return useTodaysDecisionVerdict() === "SKIP";
}
