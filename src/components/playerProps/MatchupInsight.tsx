/**
 * MatchupInsight — single-line opponent context.
 * "vs CLE: 4/6 hit rate (favourable)" / "Role boost vs PHI" / etc.
 *
 * Sourced from c.matchupNote (computed in recentPerformanceEnrichment
 * from vs-opponent hit rate + injury opportunity adj). Hides when the
 * note is empty.
 */

import { Target } from "lucide-react";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidate: ValueBetCandidate;
}

export function MatchupInsight({ candidate }: Props) {
  const note = candidate.matchupNote;
  if (!note) return null;
  // Tone matches the opponent-context classifier vocabulary plus the
  // hit-rate-derived fallback wording. "Soft" matchup means the
  // defense allows above-average production = good for the bettor.
  const tone =
    /tough|risk|degraded|opponent has been tough|suppresses/i.test(note) ? "text-red-700 dark:text-red-400"
    : /soft|favourable|boost|elevates|inflates|fast pace/i.test(note) ? "text-emerald-700 dark:text-emerald-400"
    : "text-muted-foreground";
  return (
    <p className={`text-[11px] inline-flex items-center gap-1.5 ${tone}`}>
      <Target className="w-3 h-3 shrink-0" />
      <span>{note}</span>
    </p>
  );
}
