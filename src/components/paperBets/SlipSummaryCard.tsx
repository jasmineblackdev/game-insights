/**
 * SlipSummaryCard — bottom-of-form summary panel.
 *
 * Surfaces three headline stats (Combined Odds / Hit Probability /
 * Potential Payout) and a colored risk-mix progress bar derived from
 * each leg's American odds. The risk mix gives the user an at-a-glance
 * read on how speculative the slip is before they submit.
 *
 * Hit probability is the *uncorrelated* combined product, the same
 * approximation the Builder shows. For most paper-bet slips that's
 * a reasonable upper bound.
 */
import { cn } from "@/lib/utils";
import {
  americanToImpliedProb,
  computeRiskMix,
  riskMixPct,
} from "@/lib/paperBets/riskMix";
import type { PaperLeg } from "@/lib/paperBets/types";

interface Props {
  legs: PaperLeg[];
  combinedOddsAmerican: number;
  potentialPayout: number;
  payoutMultiplier: number;
  onClearAll?: () => void;
}

export function SlipSummaryCard({
  legs, combinedOddsAmerican, potentialPayout, payoutMultiplier, onClearAll,
}: Props) {
  if (legs.length === 0) return null;

  const hitProb = legs.reduce((p, l) => p * americanToImpliedProb(l.americanOdds), 1);
  const mix = computeRiskMix(legs);
  const pct = riskMixPct(mix);

  return (
    <div className="rounded-lg border border-border/60 bg-background/60 p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-foreground">
          Slip summary ({legs.length} {legs.length === 1 ? "leg" : "legs"})
        </p>
        {onClearAll ? (
          <button
            type="button"
            onClick={onClearAll}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear all
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Combined Odds"
          value={
            Number.isFinite(combinedOddsAmerican)
              ? combinedOddsAmerican > 0 ? `+${combinedOddsAmerican}` : `${combinedOddsAmerican}`
              : "—"
          }
        />
        <Stat
          label="Hit Probability"
          value={`${Math.round(hitProb * 100)}%`}
        />
        <Stat
          label="Potential Payout"
          value={
            potentialPayout > 0
              ? legs.length > 1 ? `${payoutMultiplier.toFixed(2)}x` : `$${potentialPayout.toFixed(2)}`
              : "—"
          }
          subtitle={
            potentialPayout > 0 && legs.length > 1
              ? `$${potentialPayout.toFixed(2)} on this stake`
              : null
          }
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
          <span className="font-semibold">Risk Mix</span>
          <span className="tabular-nums">{mix.total} {mix.total === 1 ? "leg" : "legs"}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden flex">
          {pct.low > 0 ? (
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${pct.low}%` }}
              aria-label={`Low risk ${pct.low}%`}
            />
          ) : null}
          {pct.med > 0 ? (
            <div
              className="h-full bg-amber-500"
              style={{ width: `${pct.med}%` }}
              aria-label={`Medium risk ${pct.med}%`}
            />
          ) : null}
          {pct.high > 0 ? (
            <div
              className="h-full bg-red-500"
              style={{ width: `${pct.high}%` }}
              aria-label={`High risk ${pct.high}%`}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-[10px] tabular-nums">
          <RiskKey color="bg-emerald-500" label="Low"  pct={pct.low}  count={mix.low} />
          <RiskKey color="bg-amber-500"   label="Med"  pct={pct.med}  count={mix.med} />
          <RiskKey color="bg-red-500"     label="High" pct={pct.high} count={mix.high} />
        </div>
      </div>
    </div>
  );
}

function Stat({
  label, value, subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string | null;
}) {
  return (
    <div className="rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-base sm:text-lg font-bold tabular-nums leading-tight text-foreground")}>
        {value}
      </p>
      {subtitle ? (
        <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5 truncate">{subtitle}</p>
      ) : null}
    </div>
  );
}

function RiskKey({
  color, label, pct, count,
}: {
  color: string;
  label: string;
  pct: number;
  count: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      <span className="font-semibold text-foreground">{label}</span>
      <span>{pct}%</span>
      <span className="opacity-60">({count})</span>
    </span>
  );
}
