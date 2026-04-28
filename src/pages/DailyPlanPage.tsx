/**
 * /daily — Daily Betting Plan
 *
 * Three structured bets generated from the same candidate pool the
 * parlay builder uses, sized via the bankroll's per-tier suggestions:
 *   Primary    — 1–2 legs, lowest risk, low-risk stake (≤5%)
 *   Balanced   — 2–3 legs, medium risk, medium-risk stake (~2.5%)
 *   Upside     — 3–4 legs, higher payout, high-risk stake (~1%)
 *
 * Cross-tier dedup keeps each bet a distinct ticket. Lock-leg lets a
 * user pin a leg across regenerations, and Regenerate re-runs the
 * generator (e.g. after a roster change).
 */

import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  ArrowLeft,
  RefreshCw,
  Lock,
  Unlock,
  Plus,
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  Layers,
  Shuffle,
  ExternalLink,
} from "lucide-react";
import { DraftKingsTicketModal } from "@/components/draftkings/DraftKingsTicketModal";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GamePrediction } from "@/data/mockGames";
import { easternYmd, fetchNbaGamePredictions } from "@/lib/nbaEspn";
import { fetchNflGamePredictions } from "@/lib/nflEspn";
import { fetchMlbEnrichedGames } from "@/lib/mlbEspn";
import { applyMlbPredictionModel } from "@/lib/mlbPredictionModel";
import { mergeMlbStarterConfirmations } from "@/lib/mlbStarterConfirm";
import { fetchBoxingPredictions } from "@/lib/boxingFetch";
import { fetchMmaPredictions } from "@/lib/mmaFetch";
import { fetchPlayerEdgePredictions } from "@/lib/playerEdgeApi";
import { enrichGamesWithBettingIntelligence } from "@/lib/bettingIntelligence";
import { fetchAllOddsBundles, type GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import {
  buildAllValueCandidates,
  buildEnrichedPropCandidates,
} from "@/lib/valueParlay/buildCandidates";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  generateDailyPlan,
  tierBadgeClass,
  tierLabel,
  type DailyPlanCard,
} from "@/lib/dailyPlan/dailyPlanGenerator";
import { replaceWeakestLeg } from "@/lib/dailyPlan/replaceWeakest";
import { useValueParlay } from "@/context/ValueParlayContext";
import { useBankroll } from "@/context/BankrollContext";
import { BankrollWidget } from "@/components/bankroll/BankrollWidget";
import { AutoProfitCard } from "@/components/dailyPlan/AutoProfitCard";
import { Disclosure } from "@/components/ui/disclosure";
import { SharpModeBanner } from "@/components/SharpModeBanner";
import { useSharpMode } from "@/context/SharpModeContext";
import { settleFinalGames } from "@/lib/predictionHistorySettler";
import { loadUserBettingPatterns } from "@/lib/learning/userBettingPatterns";
import { resolveRecommendedParlays } from "@/lib/learning/recommendedParlayResolver";
import {
  getPropRiskLevel,
  riskLevelClass,
  riskLevelLabel,
} from "@/lib/valueParlay/propRiskLevels";
import {
  logRecommendedParlay,
  type ParlayVariant,
} from "@/lib/parlayTracking/recommendedParlayLogger";

function formatAmerican(o: number): string {
  return o > 0 ? `+${o}` : `${o}`;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function tierIconClass(t: DailyPlanCard["tier"]): string {
  return t === "primary" ? "text-emerald-600 dark:text-emerald-400"
    : t === "balanced" ? "text-amber-600 dark:text-amber-400"
    : "text-violet-600 dark:text-violet-400";
}

interface PlanCardProps {
  card: DailyPlanCard;
  lockedIds: Set<string>;
  onToggleLock: (id: string) => void;
  onRegenerate: () => void;
  onPlaced: () => void;
  onReplaceWeakest: () => void;
  /** Pre-computed swap preview — null when no improvement available. */
  swapPreview: { newSelection: string; edgeDelta: number } | null;
}

function PlanCard({ card, lockedIds, onToggleLock, onRegenerate, onPlaced, onReplaceWeakest, swapPreview }: PlanCardProps) {
  const { addValueLeg } = useValueParlay();
  const { suggestStake, recordBetPlaced } = useBankroll();
  const stakeRec = suggestStake(card.stakeRisk);
  const [placed, setPlaced] = useState(false);
  const [dkOpen, setDkOpen] = useState(false);

  if (!card.result || card.legs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-5 text-sm space-y-2">
        <p className="font-display font-bold text-foreground">{tierLabel(card.tier)}</p>
        <p className="text-muted-foreground">
          No strong plays for this lane right now — wait for stronger setups or take a smaller bet on
          another tier.
        </p>
        <Button size="sm" variant="ghost" onClick={onRegenerate} className="px-0">
          <RefreshCw className="w-3.5 h-3.5" />
          Regenerate after data refreshes
        </Button>
      </div>
    );
  }

  const hitPct = Math.round((card.result.projectedHitProbability ?? 0) * 100);
  const payoutForStake = stakeRec.stake > 0
    ? stakeRec.stake * (card.result.projectedPayoutMultiplier ?? 1)
    : 0;

  const addAllToSlip = () => {
    let added = 0;
    for (const l of card.legs) {
      const r = addValueLeg(l);
      if (r.ok) added++;
    }
    if (added) toast.success(`Added ${added} leg${added === 1 ? "" : "s"} to parlay slip`);
    else toast.message("All legs already on the slip");
  };

  const markPlaced = async () => {
    if (placed) return;
    setPlaced(true);
    if (stakeRec.stake > 0) {
      const r = recordBetPlaced(stakeRec.stake, undefined, `${tierLabel(card.tier)} placed`);
      if (!r.ok) toast.message(r.reason ?? "Could not record stake");
    }
    // Fire-and-forget log to recommended_parlays so the analytics page
    // picks it up. Variant maps tier → existing parlay variant labels.
    const variant: ParlayVariant = card.tier === "primary"
      ? "best_value"
      : card.tier === "balanced"
        ? "best_value"
        : "higher_payout";
    void logRecommendedParlay({
      tier: card.tier === "upside" ? "aggressive" : card.tier === "balanced" ? "balanced" : "safe",
      variant,
      result: card.result,
      reasons: card.whyThisBet,
      modelVersion: "daily-plan-v1",
    });
    toast.success(`${tierLabel(card.tier)} marked as placed`);
    onPlaced();
  };

  return (
    <div className="rounded-lg border border-border bg-card/60 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className={cn("w-4 h-4 shrink-0", tierIconClass(card.tier))} />
          <div className="min-w-0">
            <h3 className="font-display font-bold text-base text-foreground truncate">
              {tierLabel(card.tier)}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {card.legs.length} leg{card.legs.length === 1 ? "" : "s"} · {formatAmerican(card.result.combinedAmericanOdds)} · hit {hitPct}%
            </p>
          </div>
        </div>
        <span
          className={cn(
            "text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full border uppercase",
            tierBadgeClass(card.tier),
          )}
        >
          {card.tier}
        </span>
      </div>

      {/* Suggested stake */}
      <div className="rounded-md bg-muted/40 p-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Suggested</p>
          <p className="text-sm font-bold tabular-nums">${stakeRec.stake}</p>
          <p className="text-[9px] text-muted-foreground">
            {(stakeRec.pctOfBankroll * 100).toFixed(1)}% of roll
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hit prob</p>
          <p className="text-sm font-bold tabular-nums">{hitPct}%</p>
          <p className="text-[9px] text-muted-foreground capitalize">{card.result.cardConfidence} conf</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pays</p>
          <p className="text-sm font-bold tabular-nums">{fmtMoney(payoutForStake)}</p>
          <p className="text-[9px] text-muted-foreground">{(card.result.projectedPayoutMultiplier ?? 1).toFixed(2)}x</p>
        </div>
      </div>

      {/* Legs */}
      <ul className="space-y-2">
        {card.legs.map((l) => {
          const risk = getPropRiskLevel(l);
          const isWeakest = card.weakestLegId === l.id;
          const locked = lockedIds.has(l.id);
          return (
            <li
              key={l.id}
              className={cn(
                "rounded-md border p-3 text-xs space-y-1",
                isWeakest ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-muted/30",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-foreground truncate">{l.selectionLabel}</p>
                  <div className="flex flex-wrap items-center gap-1.5 mt-0.5 text-[11px]">
                    <span className={cn("inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-bold", riskLevelClass(risk))}>
                      {riskLevelLabel(risk)}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {String(l.sport).toUpperCase()} · {formatAmerican(l.americanOdds)} · edge {(l.edge * 100).toFixed(1)}%
                    </span>
                    {isWeakest ? (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400 font-bold">Weakest</span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant={locked ? "default" : "ghost"}
                  className="h-7 w-7 shrink-0"
                  onClick={() => onToggleLock(l.id)}
                  aria-label={locked ? "Unlock leg" : "Lock leg"}
                  title={locked ? "Locked across regenerations" : "Lock to keep across regenerations"}
                >
                  {locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                </Button>
              </div>
              {l.riskNote ? (
                <p className="text-[10px] text-muted-foreground line-clamp-2">{l.riskNote}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* Why this bet */}
      {card.whyThisBet.length > 0 ? (
        <div className="rounded-md border border-dashed border-border p-3 text-[11px] text-muted-foreground space-y-1">
          <p className="font-bold text-foreground text-[11px]">Why this bet</p>
          <ul className="list-disc list-inside space-y-0.5">
            {card.whyThisBet.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      ) : null}

      {/* Optimizer warnings */}
      {card.result.warnings.length > 0 ? (
        <ul className="text-[10px] text-amber-600 dark:text-amber-400 list-disc list-inside space-y-0.5">
          {card.result.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="default" className="flex-1" onClick={() => setDkOpen(true)} disabled={placed}>
          <ExternalLink className="w-3.5 h-3.5" />
          Place on DraftKings
        </Button>
        <Button size="sm" variant="outline" onClick={addAllToSlip}>
          <Plus className="w-3.5 h-3.5" />
          Add to slip
        </Button>
        <Button size="sm" variant="ghost" onClick={markPlaced} disabled={placed}>
          <CheckCircle2 className="w-3.5 h-3.5" />
          {placed ? "Placed" : "Mark placed"}
        </Button>
        {card.legs.length > 1 && card.weakestLegId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onReplaceWeakest}
            disabled={lockedIds.has(card.weakestLegId) || !swapPreview}
            title={
              lockedIds.has(card.weakestLegId)
                ? "Weakest leg is locked — unlock to swap"
                : swapPreview
                  ? `Swap to ${swapPreview.newSelection} · +${(swapPreview.edgeDelta * 100).toFixed(1)}% edge`
                  : "No better replacement available right now"
            }
          >
            <Shuffle className="w-3.5 h-3.5" />
            {swapPreview
              ? <>Swap weakest <span className="text-[10px] text-emerald-600 dark:text-emerald-400 ml-1">+{(swapPreview.edgeDelta * 100).toFixed(1)}%</span></>
              : "Replace weakest"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onRegenerate}>
          <RefreshCw className="w-3.5 h-3.5" />
          Regenerate
        </Button>
      </div>

      <DraftKingsTicketModal
        open={dkOpen}
        onClose={() => setDkOpen(false)}
        legs={card.legs}
        result={card.result}
        suggestedStake={stakeRec.stake}
        description={`Daily Plan · ${tierLabel(card.tier)}`}
        tier={card.tier === "upside" ? "aggressive" : card.tier === "balanced" ? "balanced" : "safe"}
        variant="best_value"
        onPlaced={() => {
          setPlaced(true);
          onPlaced();
        }}
      />
    </div>
  );
}

export default function DailyPlanPage() {
  const today = easternYmd();

  // ── Data ─────────────────────────────────────────────────────────
  const queries = useQueries({
    queries: [
      { queryKey: ["nba-espn-scoreboard", today], queryFn: fetchNbaGamePredictions, staleTime: 2 * 60 * 1000 },
      { queryKey: ["nfl-espn-scoreboard", today], queryFn: fetchNflGamePredictions, staleTime: 2 * 60 * 1000 },
      { queryKey: ["mlb-espn-enriched", today], queryFn: fetchMlbEnrichedGames, staleTime: 2 * 60 * 1000 },
      { queryKey: ["boxing-predictions"], queryFn: fetchBoxingPredictions, staleTime: 5 * 60 * 1000 },
      { queryKey: ["mma-predictions"], queryFn: fetchMmaPredictions, staleTime: 5 * 60 * 1000 },
    ],
  });
  const [nbaQ, nflQ, mlbQ, boxQ, mmaQ] = queries;

  const mlbModeledQuery = useQuery({
    queryKey: ["mlb-modeled-daily", mlbQ.dataUpdatedAt],
    queryFn: () => applyMlbPredictionModel(mergeMlbStarterConfirmations(mlbQ.data ?? [])),
    enabled: mlbQ.isSuccess,
    staleTime: Infinity,
  });

  const allGames = useMemo<GamePrediction[]>(() => [
    ...(nbaQ.data ?? []),
    ...(nflQ.data ?? []),
    ...(mlbModeledQuery.data ?? mlbQ.data ?? []),
    ...(boxQ.data ?? []),
    ...(mmaQ.data ?? []),
  ], [nbaQ.data, nflQ.data, mlbModeledQuery.data, mlbQ.data, boxQ.data, mmaQ.data]);

  const [oddsMap, setOddsMap] = useState<Map<string, GameOddsBundle>>(() => new Map());
  useEffect(() => {
    if (!allGames.length) {
      setOddsMap(new Map());
      return;
    }
    let cancelled = false;
    fetchAllOddsBundles(allGames).then((m) => {
      if (!cancelled) setOddsMap(m);
    });
    return () => { cancelled = true; };
  }, [allGames]);

  const propsQuery = useQuery({
    queryKey: ["player-edge-predictions-daily"],
    queryFn: () => fetchPlayerEdgePredictions("all", "all"),
    staleTime: 2 * 60 * 1000,
  });

  const enrichedGames = useMemo(
    () => enrichGamesWithBettingIntelligence(allGames, oddsMap),
    [allGames, oddsMap],
  );

  // Settle pending team-moneyline picks into prediction_history. The
  // settler dedupes per session so this can fire on every render.
  useEffect(() => {
    if (enrichedGames.length === 0) return;
    void settleFinalGames(enrichedGames);
    // Resolve app-recommended parlays whose games finalled.
    void resolveRecommendedParlays(enrichedGames);
  }, [enrichedGames]);

  // Warm the user-betting-pattern cache so value-score boosts are
  // ready when the optimizer rebuilds.
  useEffect(() => {
    void loadUserBettingPatterns();
  }, []);

  const candidates = useMemo<ValueBetCandidate[]>(() => {
    const teamCandidates = buildAllValueCandidates(enrichedGames, oddsMap);
    const propCandidates = buildEnrichedPropCandidates(propsQuery.data?.items ?? []);
    return [...teamCandidates, ...propCandidates];
  }, [enrichedGames, oddsMap, propsQuery.data]);

  // Publish to context so the sticky slip drawer's Replace Weakest can
  // search this pool when the user taps it from the slip on /daily.
  const { publishCandidatePool } = useValueParlay();
  useEffect(() => {
    publishCandidatePool(candidates);
  }, [candidates, publishCandidatePool]);

  // Sharp Mode — when enabled, drives the generator's strict gate
  // pipeline + drops the Upside tier.
  const { enabled: sharpEnabled, thresholds: sharpThresholds } = useSharpMode();

  // ── Plan state ───────────────────────────────────────────────────
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());
  const [regenerateTick, setRegenerateTick] = useState(0);
  const [placedTier, setPlacedTier] = useState<Set<DailyPlanCard["tier"]>>(new Set());
  /** Per-tier overrides applied over the generator's output (e.g. after a Replace-weakest swap). */
  const [tierOverrides, setTierOverrides] = useState<Partial<Record<DailyPlanCard["tier"], DailyPlanCard>>>({});

  const generated = useMemo<DailyPlanCard[]>(
    () => generateDailyPlan({
      candidates,
      lockedLegIds: lockedIds,
      sharpMode: sharpEnabled,
      sharpThresholds: sharpEnabled ? sharpThresholds : undefined,
    }),
    // regenerateTick forces recompute when user hits Regenerate even if
    // candidates/lockedIds haven't changed; useful when the optimizer's
    // output is stable across the same input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, lockedIds, regenerateTick, sharpEnabled, sharpThresholds],
  );

  /** Apply any per-tier overrides on top of the generator's plan. */
  const plan = useMemo<DailyPlanCard[]>(
    () => generated.map((c) => tierOverrides[c.tier] ?? c),
    [generated, tierOverrides],
  );

  const toggleLock = (id: string) => {
    setLockedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const regenerateAll = () => {
    setRegenerateTick((t) => t + 1);
    setTierOverrides({});
    toast.success("Plan regenerated");
  };

  /**
   * Pre-compute a Replace Weakest preview per tier so the button can
   * show the swap delta inline (e.g. "+4.2%") and stay disabled when
   * no improvement is available. Re-runs whenever plan, candidates,
   * or lock state change.
   */
  const swapPreviews = useMemo(() => {
    const out: Partial<Record<DailyPlanCard["tier"], { newSelection: string; edgeDelta: number }>> = {};
    for (const card of plan) {
      if (!card.weakestLegId || card.legs.length < 2) continue;
      const weakest = card.legs.find((l) => l.id === card.weakestLegId);
      if (!weakest) continue;
      const exclude = new Set<string>();
      for (const other of plan) {
        if (other.tier === card.tier) continue;
        for (const l of other.legs) exclude.add(l.id);
      }
      const r = replaceWeakestLeg({
        legs: card.legs,
        pool: candidates,
        weakestLegId: card.weakestLegId,
        lockedLegIds: lockedIds,
        excludeIds: exclude,
        mode: card.tier === "primary" ? "safe" : card.tier === "balanced" ? "balanced" : "aggressive",
      });
      if (!r.ok || !r.added) continue;
      out[card.tier] = {
        newSelection: r.added.selectionLabel,
        edgeDelta: Math.max(0, r.added.edge - weakest.edge),
      };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, candidates, lockedIds]);

  const replaceWeakestForTier = (tier: DailyPlanCard["tier"]) => {
    const card = plan.find((c) => c.tier === tier);
    if (!card || !card.result || !card.weakestLegId) {
      toast.message("No weakest leg to swap");
      return;
    }
    // Build the exclusion set: every leg already used in OTHER tiers
    // so the swap doesn't dup across the Daily Plan.
    const exclude = new Set<string>();
    for (const other of plan) {
      if (other.tier === tier) continue;
      for (const l of other.legs) exclude.add(l.id);
    }
    const r = replaceWeakestLeg({
      legs: card.legs,
      pool: candidates,
      weakestLegId: card.weakestLegId,
      lockedLegIds: lockedIds,
      excludeIds: exclude,
      mode: tier === "primary" ? "safe" : tier === "balanced" ? "balanced" : "aggressive",
    });
    if (!r.ok || !r.legs || !r.result || !r.removed || !r.added) {
      toast.message(r.reason ?? "Could not replace weakest leg");
      return;
    }
    const newCard: DailyPlanCard = {
      ...card,
      legs: r.legs,
      result: r.result,
      weakestLegId: r.result.weakestLegId,
      whyThisBet: [
        ...card.whyThisBet,
        `Removed ${r.removed.selectionLabel} (was weakest).`,
        `Added ${r.added.selectionLabel} — ${r.whyAdded}.`,
      ],
    };
    setTierOverrides((prev) => ({ ...prev, [tier]: newCard }));
    toast.success(`Swapped weakest leg → ${r.added.selectionLabel}`);
  };

  const loading = candidates.length === 0 && (
    nbaQ.isPending || mlbQ.isPending || propsQuery.isPending
  );

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="border-b border-border surface-glass sticky top-0 z-40 pt-[env(safe-area-inset-top)]">
        <div className="container max-w-6xl mx-auto py-3 sm:py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="flex items-center gap-2 min-h-10 text-sm text-muted-foreground hover:text-foreground transition-colors touch-manipulation shrink-0"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              Home
            </Link>
            <div className="h-4 w-px bg-border hidden sm:block" />
            <div className="flex items-center gap-2">
              <Layers className="w-5 h-5 text-primary" />
              <div>
                <h1 className="font-display font-bold text-base text-foreground">Daily Plan</h1>
                <p className="text-[11px] text-muted-foreground">
                  Primary · Balanced · Upside — sized to your bankroll
                </p>
              </div>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={regenerateAll}>
            <RefreshCw className="w-3.5 h-3.5" />
            Regenerate plan
          </Button>
        </div>
      </header>

      <main className="container max-w-6xl mx-auto py-5 sm:py-6 space-y-6">
        <SharpModeBanner />
        <BankrollWidget />

        {!loading && plan.length > 0 ? (
          <AutoProfitCard plan={plan} onReplaceWeakest={replaceWeakestForTier} />
        ) : null}

        {loading ? (
          <div className="grid md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-72 rounded-lg bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid md:grid-cols-3 gap-4">
            {plan.map((card) => (
              <PlanCard
                key={card.tier}
                card={card}
                lockedIds={lockedIds}
                onToggleLock={toggleLock}
                onRegenerate={regenerateAll}
                onPlaced={() => setPlacedTier((s) => new Set([...s, card.tier]))}
                onReplaceWeakest={() => replaceWeakestForTier(card.tier)}
                swapPreview={swapPreviews[card.tier] ?? null}
              />
            ))}
          </div>
        )}

        {!loading && placedTier.size > 0 ? (
          <p className="text-[11px] text-emerald-600 dark:text-emerald-400 text-center">
            ✓ {placedTier.size} bet{placedTier.size === 1 ? "" : "s"} marked as placed today.
          </p>
        ) : null}

        <Disclosure variant="card" title="Why this plan?">
          <div className="text-[12px] text-muted-foreground space-y-2 leading-relaxed">
            <p>
              <span className="text-foreground font-bold">Primary</span> takes the highest-confidence anchor
              (1–2 legs, no HIGH-risk legs, combat sports only when data quality is strong) and sizes via
              the bankroll's low-risk tier (≤5%).
            </p>
            <p>
              <span className="text-foreground font-bold">Balanced</span> uses the optimizer's "balanced"
              mode — the same engine the parlay builder ships with, hard-capped at 1 HIGH-risk leg and
              filtered for dependent stat pairs (RBI+Runs, HR+RBI, Hits+Total Bases).
            </p>
            <p>
              <span className="text-foreground font-bold">Upside</span> targets a higher payout via
              "aggressive" mode but still passes the same risk rules. Sized at the high-risk tier (~1%) so
              a bad night doesn't wreck the bankroll.
            </p>
            <p>
              Cross-tier dedup means no leg appears in two tiers unless you've locked it. Lock a leg to keep
              it across Regenerate, and Replace by removing the leg and regenerating.
            </p>
          </div>
        </Disclosure>
      </main>
    </div>
  );
}
