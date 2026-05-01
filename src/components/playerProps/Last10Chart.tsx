/**
 * Last10Chart — Outlier-style per-game timeline.
 *
 * 10 cells, oldest → newest left-to-right. Green = hit, red = miss,
 * grey = push or missing data. Hover shows date / opponent / value.
 *
 * Renders nothing when no game-by-game data is computable (avoids
 * a blank panel — the surrounding HitRateBars handle the no-data
 * case).
 */

import { cn } from "@/lib/utils";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

interface Props {
  candidate: ValueBetCandidate;
  /** Optional line value for the tooltip. Defaults to the leg's line. */
  line?: number | null;
  /** Compact = 6px cells; default = 10px cells. */
  compact?: boolean;
}

export function Last10Chart({ candidate, line, compact = false }: Props) {
  const games = candidate.hitRates?.gameByGame ?? [];
  if (games.length === 0) return null;
  const targetLine = line ?? candidate.lineValue ?? null;

  // Pad with empty cells when fewer than 10 games — keeps the visual
  // grid stable and signals sample-size to the user.
  const padding = Math.max(0, 10 - games.length);
  const cellSize = compact ? "h-1.5 w-1.5" : "h-2.5 w-2.5";

  return (
    <div className="space-y-1">
      <div className={cn("flex items-end gap-0.5", compact ? "" : "gap-1")}>
        {Array.from({ length: padding }).map((_, i) => (
          <span
            key={`pad-${i}`}
            className={cn("rounded-sm bg-muted/30 border border-border/30", cellSize)}
            title="No game data"
          />
        ))}
        {games.map((g, i) => {
          const tone =
            g.hit === true ? "bg-emerald-500 border-emerald-600"
            : g.hit === false ? "bg-red-500 border-red-600"
            : "bg-muted-foreground/30 border-muted-foreground/40";
          const tooltip = targetLine != null
            ? `${g.date} vs ${g.opponent}: ${g.value} (line ${targetLine}) — ${g.hit === true ? "HIT" : g.hit === false ? "MISS" : "PUSH"}`
            : `${g.date} vs ${g.opponent}: ${g.value}`;
          return (
            <span
              key={`${g.date}-${i}`}
              className={cn("rounded-sm border", cellSize, tone)}
              title={tooltip}
            />
          );
        })}
      </div>
      {!compact ? (
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" /> hit
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-red-500" /> miss
          </span>
          {games.some((g) => g.hit === null) ? (
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-muted-foreground/30" /> push
            </span>
          ) : null}
          <span className="ml-auto font-mono tabular-nums">
            {games.filter((g) => g.hit === true).length}/{games.filter((g) => g.hit !== null).length}
          </span>
        </div>
      ) : null}
    </div>
  );
}
