/**
 * DraftKingsTicketModal — DraftKings manual-execution flow.
 *
 * Step 1: Show the ticket (legs / stake / combined odds / payout) +
 *         "Open DraftKings" and "Copy instructions" buttons.
 * Step 2: Line verification — user enters DK odds + DK line per leg
 *         (or accepts as-is). Drift triggers a warning.
 * Step 3: Confirm — debits stake from bankroll, logs the parlay to
 *         recommended_parlays with source='draftkings_manual', and
 *         writes ml_training_samples with sportsbook=DraftKings,
 *         placed_by_user=true, plus odds_at_placement.
 *
 * Never auto-places anything.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  ExternalLink,
  Copy,
  CheckCircle2,
  ShieldAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  draftkingsUrl,
  formatBetInstructions,
  lineDrift,
} from "@/lib/draftkings/draftkingsBet";
import type { ValueBetCandidate, SmartParlayResult } from "@/lib/valueParlay/types";
import { useBankroll } from "@/context/BankrollContext";
import { logRecommendedParlay, type ParlayVariant } from "@/lib/parlayTracking/recommendedParlayLogger";
import { writeTrainingSamplesFromLegs } from "@/lib/ml/trainingSamples";

interface Props {
  open: boolean;
  onClose: () => void;
  legs: ValueBetCandidate[];
  result: SmartParlayResult | null;
  suggestedStake: number;
  /** Description shown at the top — usually the source tier ("Auto Profit · Green Day"). */
  description?: string;
  /** Maps to the recommended_parlays.tier column. */
  tier?: "safe" | "balanced" | "aggressive" | "cashout";
  variant?: ParlayVariant;
  onPlaced?: () => void;
}

function formatAmerican(o: number): string {
  return o > 0 ? `+${o}` : `${o}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DraftKingsTicketModal({
  open,
  onClose,
  legs,
  result,
  suggestedStake,
  description,
  tier = "balanced",
  variant = "best_value",
  onPlaced,
}: Props) {
  const { recordBetPlaced } = useBankroll();
  // Per-leg verified odds + line. Defaults to the recommendation values;
  // user can edit before confirming. Empty string means "use as-is".
  const [verifiedOdds, setVerifiedOdds] = useState<Record<string, string>>({});
  const [verifiedLines, setVerifiedLines] = useState<Record<string, string>>({});
  const [stakeInput, setStakeInput] = useState<string>(String(suggestedStake || ""));
  const [step, setStep] = useState<"ticket" | "verify" | "done">("ticket");
  const [submitting, setSubmitting] = useState(false);

  if (legs.length === 0 || !result) return null;

  const stakeNum = Number(stakeInput) || 0;
  const payout = stakeNum * (result.projectedPayoutMultiplier ?? 1);

  // Per-leg drift evaluation when user enters DK values.
  const driftPerLeg = legs.map((l) => {
    const recOdds = l.americanOdds;
    const recLine = l.lineValue;
    const dkOdds = verifiedOdds[l.id] !== undefined && verifiedOdds[l.id] !== ""
      ? Number(verifiedOdds[l.id])
      : undefined;
    const dkLine = verifiedLines[l.id] !== undefined && verifiedLines[l.id] !== ""
      ? Number(verifiedLines[l.id])
      : undefined;
    return {
      leg: l,
      drift: lineDrift({
        recommendedOdds: recOdds,
        draftkingsOdds: dkOdds,
        recommendedLine: recLine,
        draftkingsLine: dkLine,
      }),
      dkOdds,
      dkLine,
    };
  });

  const anyDriftWarn = driftPerLeg.some((d) => d.drift.warn);

  const copyInstructions = () => {
    const text = formatBetInstructions({
      legs,
      stake: stakeNum > 0 ? stakeNum : undefined,
      combinedOdds: result.combinedAmericanOdds,
      payoutMultiplier: result.projectedPayoutMultiplier,
    });
    navigator.clipboard?.writeText(text).then(
      () => toast.success("Instructions copied — paste them next to your DraftKings slip"),
      () => toast.message("Copy failed — your browser blocked clipboard access"),
    );
  };

  const openDraftKings = () => {
    // First leg's sport drives the deep-link section.
    const url = draftkingsUrl(String(legs[0]?.sport).toLowerCase());
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const confirmPlaced = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // 1) Debit stake from bankroll (local).
      if (stakeNum > 0) {
        const r = recordBetPlaced(stakeNum, undefined, "DraftKings · manually placed");
        if (!r.ok) toast.message(r.reason ?? "Could not record stake");
      }
      // 2) Log to recommended_parlays with source='user_manual' (the
      //    table's check constraint accepts that value; we tag it as
      //    DraftKings via reasons[]). When the migration adds
      //    'draftkings_manual' to the enum we'll switch.
      void logRecommendedParlay({
        tier,
        variant,
        result,
        reasons: [
          "sportsbook=DraftKings",
          "placement=manual",
          ...legs.map((l, i) => {
            const dkOdds = driftPerLeg[i].dkOdds;
            const dkLine = driftPerLeg[i].dkLine;
            const odds = dkOdds != null ? formatAmerican(dkOdds) : formatAmerican(l.americanOdds);
            return `leg_${i + 1}_dk: ${l.selectionLabel} @ ${odds}`;
          }),
        ],
        modelVersion: "draftkings-manual-v1",
      });
      // 3) Write training samples with sportsbook + odds_at_placement.
      void writeTrainingSamplesFromLegs({
        legs,
        source: "draftkings_manual",
        modelVersion: "draftkings-manual-v1",
        suggestedStake,
        actualStake: stakeNum,
        sportsbook: "DraftKings",
        placedByUser: true,
        featuresSnapshotPerLeg: (l) => {
          const i = legs.findIndex((x) => x.id === l.id);
          const d = driftPerLeg[i];
          return {
            recommended_odds: l.americanOdds,
            draftkings_odds:  d.dkOdds ?? null,
            recommended_line: l.lineValue ?? null,
            draftkings_line:  d.dkLine ?? null,
            odds_drift_points: d.drift.oddsDeltaPoints,
            line_drift:        d.drift.lineDelta,
            drift_warned:      d.drift.warn,
          };
        },
      });
      toast.success(`Parlay logged — ${legs.length} leg${legs.length === 1 ? "" : "s"} tracked`);
      setStep("done");
      onPlaced?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="text-emerald-500 font-black">DK</span>
            DraftKings ticket
          </SheetTitle>
          {description ? (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          ) : null}
        </SheetHeader>

        {/* Ticket details */}
        <div className="mt-4 space-y-3">
          <div className="rounded-md bg-muted/40 p-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Combined</p>
              <p className="text-sm font-bold tabular-nums">{formatAmerican(result.combinedAmericanOdds)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hit prob</p>
              <p className="text-sm font-bold tabular-nums">{Math.round((result.projectedHitProbability ?? 0) * 100)}%</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pays</p>
              <p className="text-sm font-bold tabular-nums">{fmtMoney(payout)}</p>
            </div>
          </div>

          <ul className="space-y-1.5">
            {legs.map((l) => (
              <li key={l.id} className="rounded-md border border-border bg-card/60 px-3 py-2 text-xs">
                <p className="font-bold text-foreground truncate">{l.selectionLabel}</p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {String(l.sport).toUpperCase()}
                  {l.statType ? ` · ${l.statType.replace(/_/g, " ")}` : ` · ${l.marketType}`}
                  {l.lineValue != null ? ` · ${l.lineValue}` : ""}
                  {" · "}{formatAmerican(l.americanOdds)}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {step === "ticket" ? (
          <>
            {/* Stake input */}
            <div className="mt-4 space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Stake</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  className="w-full h-9 rounded-md border border-input bg-background pl-6 pr-2 text-sm"
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Suggested: ${suggestedStake} · pays {fmtMoney(payout)} on a winner.
              </p>
            </div>

            {/* Step 1 actions */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="default" onClick={openDraftKings}>
                <ExternalLink className="w-3.5 h-3.5" />
                Open DraftKings
              </Button>
              <Button variant="outline" onClick={copyInstructions}>
                <Copy className="w-3.5 h-3.5" />
                Copy instructions
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground mt-3 leading-snug">
              We don't auto-place bets. Place the ticket inside DraftKings, then come back and verify
              the line before logging it.
            </p>

            <div className="mt-auto pt-4 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={onClose}>
                <X className="w-3.5 h-3.5" />
                Cancel
              </Button>
              <Button variant="default" className="flex-1" onClick={() => setStep("verify")}>
                Next: Verify line
              </Button>
            </div>
          </>
        ) : null}

        {step === "verify" ? (
          <>
            <p className="mt-4 text-[11px] text-muted-foreground leading-snug">
              Enter the odds and line you saw on DraftKings (leave blank to use the recommended
              values). Drift triggers a warning.
            </p>
            <ul className="mt-3 space-y-2">
              {legs.map((l, i) => {
                const d = driftPerLeg[i];
                return (
                  <li key={l.id} className="rounded-md border border-border bg-card/60 px-3 py-2 text-[11px] space-y-2">
                    <p className="font-bold text-foreground">{l.selectionLabel}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-muted-foreground">DK odds</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          placeholder={String(l.americanOdds)}
                          value={verifiedOdds[l.id] ?? ""}
                          onChange={(e) => setVerifiedOdds((s) => ({ ...s, [l.id]: e.target.value }))}
                          className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
                        />
                      </label>
                      <label className="space-y-0.5">
                        <span className="text-[10px] text-muted-foreground">DK line</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.5"
                          placeholder={l.lineValue != null ? String(l.lineValue) : "—"}
                          value={verifiedLines[l.id] ?? ""}
                          onChange={(e) => setVerifiedLines((s) => ({ ...s, [l.id]: e.target.value }))}
                          className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
                        />
                      </label>
                    </div>
                    {d.drift.warn ? (
                      <p className="text-[10px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
                        <ShieldAlert className="w-3 h-3 shrink-0 mt-0.5" />
                        <span>{d.drift.reasons.join(" ")}</span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {anyDriftWarn ? (
              <p className="mt-3 text-[11px] text-amber-700 dark:text-amber-400 rounded-md bg-amber-500/5 border border-amber-500/20 px-3 py-2">
                One or more legs drifted. The edge in the recommendation may not match the DK price —
                placement is your call.
              </p>
            ) : null}

            <div className="mt-auto pt-4 flex gap-2">
              <Button variant="ghost" className="flex-1" onClick={() => setStep("ticket")}>
                Back
              </Button>
              <Button
                variant="default"
                className={cn("flex-1", anyDriftWarn && "bg-amber-600 hover:bg-amber-700")}
                onClick={confirmPlaced}
                disabled={submitting || stakeNum <= 0}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                I placed this bet
              </Button>
            </div>
          </>
        ) : null}

        {step === "done" ? (
          <div className="mt-6 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-4 text-center space-y-2">
            <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto" />
            <p className="font-bold text-foreground">Logged</p>
            <p className="text-[11px] text-muted-foreground">
              Stake debited from bankroll. Outcome will track once you mark this bet won/lost on the
              My Bets page.
            </p>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
