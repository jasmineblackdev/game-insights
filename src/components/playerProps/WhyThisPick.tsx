/**
 * Single-line "why this pick" rendered under the primary card label.
 * Trimmed to ≤2 lines on mobile to keep card height bounded. Falls
 * back gracefully when whyThisPick wasn't computed (older candidates).
 */

import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { whyThisPick } from "@/lib/valueParlay/explanation";

interface Props {
  candidate: ValueBetCandidate;
}

export function WhyThisPick({ candidate: c }: Props) {
  const text = c.whyThisPick ?? whyThisPick(c);
  return (
    <p className="text-[11px] text-muted-foreground line-clamp-2 leading-snug">
      {text}
    </p>
  );
}
