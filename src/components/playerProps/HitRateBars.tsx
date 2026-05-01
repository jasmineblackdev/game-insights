/**
 * Compact horizontal hit-rate bars for a player prop.
 * 4 rows: L5 / L10 / Season / vs Opp.
 *
 * Color rules:
 *   ≥ 65% → emerald (good signal)
 *   50–64% → amber (mixed)
 *   < 50% → red (bad signal)
 *
 * Sample-size dimming: rates with fewer than the recommended-sample
 * threshold render at 50% opacity. Null rates show "—" (no bar).
 */

import { cn } from "@/lib/utils";

interface Props {
  rates: {
    last5: number | null;
    last10: number | null;
    season: number | null;
    vsOpponent: number | null;
    samples: { last5: number; last10: number; season: number; vsOpponent: number };
  };
  /** Compact mode shrinks vertical spacing for use inside scanner rows. */
  compact?: boolean;
}

export function HitRateBars({ rates, compact = false }: Props) {
  const rows: { label: string; rate: number | null; samples: number; minSamples: number }[] = [
    { label: "L5",     rate: rates.last5,      samples: rates.samples.last5,      minSamples: 3 },
    { label: "L10",    rate: rates.last10,     samples: rates.samples.last10,     minSamples: 5 },
    { label: "SZN",    rate: rates.season,     samples: rates.samples.season,     minSamples: 10 },
    { label: "vs OPP", rate: rates.vsOpponent, samples: rates.samples.vsOpponent, minSamples: 2 },
  ];

  // Hide the whole panel when nothing is computable.
  if (rows.every((r) => r.rate == null)) return null;

  return (
    <div className={cn("space-y-1", compact ? "space-y-0.5" : "")}>
      {rows.map((r) => (
        <Row key={r.label} {...r} compact={compact} />
      ))}
    </div>
  );
}

function Row({
  label,
  rate,
  samples,
  minSamples,
  compact,
}: {
  label: string;
  rate: number | null;
  samples: number;
  minSamples: number;
  compact: boolean;
}) {
  const thin = samples < minSamples;
  const tone =
    rate == null ? "bg-muted-foreground/20"
    : rate >= 0.65 ? "bg-emerald-500"
    : rate >= 0.50 ? "bg-amber-500"
    : "bg-red-500";
  const pct = rate == null ? null : Math.round(rate * 100);
  const wins = rate != null ? Math.round(rate * samples) : null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[11px]",
        thin ? "opacity-50" : "",
      )}
      title={
        rate == null
          ? `${label}: not enough samples`
          : `${label}: ${wins}/${samples} (${pct}%)${thin ? " · thin sample" : ""}`
      }
    >
      <span className="text-muted-foreground font-mono w-12 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
        {rate != null ? (
          <div
            className={cn("h-full rounded-full transition-all", tone)}
            style={{ width: `${Math.min(100, Math.max(2, pct ?? 0))}%` }}
          />
        ) : null}
      </div>
      <span className={cn("tabular-nums shrink-0 text-right", compact ? "w-10" : "w-14")}>
        {rate == null ? "—" : `${wins}/${samples}`}
      </span>
    </div>
  );
}
