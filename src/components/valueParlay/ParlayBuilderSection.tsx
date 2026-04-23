import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, Hourglass, RefreshCw, Shuffle, Trash2, Wallet, Wrench, Zap } from "lucide-react";
import type { GamePrediction, League } from "@/data/mockGames";
import { useValueParlay } from "@/context/ValueParlayContext";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildAllValueCandidates, buildEnrichedPropCandidates } from "@/lib/valueParlay/buildCandidates";
import { formatBuilderParlayShare } from "@/lib/valueParlay/parlayBotFormatting";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import type { ParlayBuildMode, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { optimizeForMode, optimizeSmartParlays, type AnalyticsWeights } from "@/lib/valueParlay/parlayOptimizer";
import { RankedLiveParlayPresets } from "@/components/valueParlay/RankedLiveParlayPresets";
import { parlayReasons } from "@/lib/valueParlay/parlayReasons";
import { useQuery } from "@tanstack/react-query";
import { fetchPlayerEdgePredictions } from "@/lib/playerEdgeApi";
import { useRoiBySport, useRoiByMarketType, useParlayModelMix, type ParlayModelMixRow } from "@/hooks/useAnalyticsDashboard";
import {
  logPropImpressions,
  logParlayLegRejections,
  logGamePredictionSnapshots,
} from "@/lib/ml/impressionLogger";
import { enrichCandidatesWithRecentPerformance } from "@/lib/valueParlay/recentPerformanceEnrichment";
import { snapshotClvForCandidates, sealClvForPredictions } from "@/lib/ml/clvSnapshotter";
import { loadPlattParams } from "@/lib/ml/plattCalibration";

const MODE_LABEL: Record<ParlayBuildMode, string> = {
  safe: "Safe (2 legs · +120 to +320)",
  balanced: "Balanced (3 legs · +250 to +550)",
  aggressive: "Aggressive (5–6 legs)",
  cashout: "Cash-Out (3 legs, staggered)",
};

const HISTORY_KEY = "gamelens-value-parlay-history-v1";

// ── 7-day tier hit rate strip ─────────────────────────────────────────────────

function TierPerformanceStrip() {
  const { data = [] } = useParlayModelMix(7);
  const rows = data as ParlayModelMixRow[];
  if (!rows.length) return null;

  const TIERS = ["safe", "balanced", "aggressive"] as const;
  const TIER_COLOR: Record<string, string> = {
    safe:       "text-emerald-500",
    balanced:   "text-yellow-500",
    aggressive: "text-orange-500",
  };

  const byTier = rows.reduce<Record<string, { resolved: number; hits: number }>>((acc, r) => {
    if (!acc[r.tier]) acc[r.tier] = { resolved: 0, hits: 0 };
    acc[r.tier].resolved += Number(r.resolved_count);
    if (r.hit_rate_pct != null) {
      acc[r.tier].hits += Math.round((Number(r.hit_rate_pct) / 100) * Number(r.resolved_count));
    }
    return acc;
  }, {});

  const chips = TIERS.flatMap((tier) => {
    const t = byTier[tier];
    if (!t || t.resolved < 3) return [];
    const hitRate = ((t.hits / t.resolved) * 100).toFixed(0);
    return [{ tier, hitRate, resolved: t.resolved }];
  });

  if (!chips.length) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px] px-1">
      <span className="text-muted-foreground/60 font-medium">7d hit rates:</span>
      {chips.map(({ tier, hitRate, resolved }, i) => (
        <span key={tier}>
          <span className={cn("font-semibold capitalize", TIER_COLOR[tier])}>{tier}</span>
          <span className="text-muted-foreground"> {hitRate}%</span>
          <span className="text-muted-foreground/40 text-[8px] ml-0.5">/{resolved}</span>
          {i < chips.length - 1 && <span className="text-muted-foreground/30 ml-1">·</span>}
        </span>
      ))}
    </div>
  );
}

function leagueShort(l: League) {
  return l.toUpperCase();
}

// ── Cash-Out Parlay section ───────────────────────────────────────────────────
// Isolated from Safe/Balanced/Aggressive. Builds a 3-leg parlay optimised
// for early cash-out — staggered start times, highest-probability legs first,
// biggest-payout leg last. Does not read or modify parlayMode.

function CashOutParlaySection({
  candidates,
  analyticsWeights,
  setBuilderLegs,
  disabled,
}: {
  candidates: ValueBetCandidate[];
  analyticsWeights: AnalyticsWeights;
  setBuilderLegs: (legs: ValueBetCandidate[]) => void;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState<SmartParlayResult | null>(null);

  const generate = () => {
    if (!candidates.length) {
      toast.message("No candidates available");
      return;
    }
    const r = optimizeForMode(candidates, "cashout", analyticsWeights);
    if (!r.legs.length) {
      toast.error("Could not build a cash-out parlay from the current pool");
      setPreview(null);
      return;
    }
    setPreview(r);
    toast.success("Cash-Out parlay generated");
  };

  const apply = () => {
    if (!preview?.legs.length) return;
    setBuilderLegs(preview.legs);
    toast.success("Cash-Out legs applied to slip");
  };

  return (
    <div className="rounded-2xl border border-sky-500/30 bg-sky-500/[0.04] p-4 sm:p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sky-600 dark:text-sky-400">
            <Hourglass className="w-5 h-5 shrink-0" />
            <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
              Cash-Out Parlay
            </span>
          </div>
          <h3 className="font-display font-bold text-lg text-foreground">Cash-out friendly build</h3>
          <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
            3 legs, staggered start times. Highest hit-probability legs resolve first so you can
            take early cash-out offers with profit. Separate from Safe / Balanced / Aggressive.
          </p>
        </div>
        <Button size="sm" variant="default" className="gap-1 shrink-0" onClick={generate} disabled={disabled}>
          <Hourglass className="w-3.5 h-3.5" />
          Generate
        </Button>
      </div>

      {preview ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">Legs</p>
              <p className="text-lg font-bold tabular-nums text-foreground">{preview.legs.length}</p>
            </div>
            <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">Payout</p>
              <p className="text-lg font-bold tabular-nums text-foreground">
                {preview.projectedPayoutMultiplier.toFixed(2)}x
              </p>
            </div>
            <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">Proj. hit</p>
              <p className="text-lg font-bold tabular-nums text-foreground">
                {(preview.projectedHitProbability * 100).toFixed(1)}%
              </p>
            </div>
            <div className="rounded-lg bg-background/60 border border-border/60 px-3 py-2">
              <p className="text-[10px] text-muted-foreground">American</p>
              <p className="text-lg font-bold tabular-nums text-foreground">
                {preview.combinedAmericanOdds > 0 ? "+" : ""}{preview.combinedAmericanOdds}
              </p>
            </div>
          </div>

          <ol className="space-y-1.5 text-xs">
            {preview.legs.map((l, i) => (
              <li
                key={l.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="flex items-start gap-2 min-w-0">
                  <span className="text-[10px] font-bold tabular-nums text-sky-600 dark:text-sky-400 mt-0.5">
                    #{i + 1}
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold text-foreground text-sm truncate">{l.selectionLabel}</p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {leagueShort(l.sport)} · {l.gameTimeLabel ?? "time TBD"} ·{" "}
                      {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds} · hit{" "}
                      {((l.modelProbability ?? 0) * 100).toFixed(0)}%
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" className="gap-1" onClick={apply}>
              <Zap className="w-3.5 h-3.5" />
              Apply to slip
            </Button>
            <Button size="sm" variant="outline" onClick={generate}>
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground italic">
          Click Generate to preview a 3-leg cash-out parlay. It will not change your current slip.
        </p>
      )}
    </div>
  );
}

export function ParlayBuilderSection({
  games,
  oddsMap,
  gamesLoading,
  bookOddsLoading = false,
  filterPropsByGameIds,
  tomorrowMode = false,
}: {
  games: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  gamesLoading: boolean;
  bookOddsLoading?: boolean;
  /**
   * When provided, only player-prop candidates whose game_id is in this set
   * are included in the parlay pool. Used by the Tomorrow tab to restrict
   * props to tomorrow's slate only.
   */
  filterPropsByGameIds?: Set<string>;
  /**
   * When true, injects a +0.02 sport-diversification boost into analytics weights.
   * Used by the Tomorrow tab where full-slate visibility makes cross-sport
   * mixes more achievable and valuable.
   */
  tomorrowMode?: boolean;
}) {
  const {
    parlayMode,
    setParlayMode,
    analyticsWeights,
    setAnalyticsWeights,
    builderLegs,
    setBuilderLegs,
    removeValueLeg,
    clearValueBuilder,
    autoBuildFromCandidates,
    rebalance,
    saferSwap,
    higherPayoutSwap,
    triplePreview,
    builderMetrics,
  } = useValueParlay();

  const [tripleOpen, setTripleOpen] = useState(false);

  // Load Platt calibration params once per session — used by candidate
  // builders to scale raw model probabilities to observed hit rates.
  useEffect(() => { loadPlattParams().catch(() => {}); }, []);

  // ── Analytics weights from Supabase RPCs ──────────────────────────────────
  // 30-day window gives a stable baseline; won't overpower live edge/confidence.
  const { data: roiSportData } = useRoiBySport(30);
  const { data: roiMarketData } = useRoiByMarketType(30);

  useEffect(() => {
    if (!roiSportData?.length && !roiMarketData?.length) return;
    const MIN_N = 5; // require at least 5 resolved to trust the weight
    const sportWeights: Record<string, number> = {};
    for (const row of roiSportData ?? []) {
      if (row.resolved_count >= MIN_N && row.roi_pct != null) {
        // roi_pct=12.5 maps to max boost (+0.08); roi_pct=-12.5 → max penalty (-0.08)
        sportWeights[row.sport.toUpperCase()] = 1.0 + Math.min(0.08, Math.max(-0.08, row.roi_pct / 125));
      }
    }
    const marketWeights: Record<string, number> = {};
    for (const row of roiMarketData ?? []) {
      if (row.resolved_count >= MIN_N && row.roi_pct != null) {
        const key = `${row.sport.toUpperCase()}:${row.stat_type.toLowerCase()}`;
        marketWeights[key] = 1.0 + Math.min(0.08, Math.max(-0.08, row.roi_pct / 125));
      }
    }
    setAnalyticsWeights({
      sportWeights,
      marketWeights,
      ...(tomorrowMode ? { diversificationBoost: 0.02 } : {}),
    });
  }, [roiSportData, roiMarketData, setAnalyticsWeights, tomorrowMode]);

  // Pull enriched props from the shared React Query cache (populated by PlayerEdgeSection).
  // staleTime matches PlayerEdgeSection so no extra network call is made.
  const { data: propData } = useQuery({
    queryKey: ["player-edge-v2"],
    queryFn: () => fetchPlayerEdgePredictions("all", "all"),
    staleTime: 3 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const rawCandidates = useMemo(() => {
    const gameCandidates = buildAllValueCandidates(games, oddsMap);
    const rawProps = propData?.items ?? [];
    const filteredProps = filterPropsByGameIds
      ? rawProps.filter((p) => filterPropsByGameIds.has(p.game_id))
      : rawProps;
    const enrichedPropCandidates = buildEnrichedPropCandidates(filteredProps);
    // Merge: game-level candidates first (authoritative), then ML prop candidates.
    // De-duplicate by correlation group so a prop doesn't appear twice when both
    // the game pipeline and ESPN pipeline produce the same player/stat.
    const seenCorrGroups = new Set(gameCandidates.map((c) => c.correlationGroupId));
    const uniqueEnriched = enrichedPropCandidates.filter(
      (c) => !seenCorrGroups.has(c.correlationGroupId)
    );
    return [...gameCandidates, ...uniqueEnriched].sort((a, b) => b.valueScore - a.valueScore);
  }, [games, oddsMap, propData]);

  // Recent-performance enrichment — batch-fetches each player's last 5 games,
  // computes hit rate vs the prop's line, and re-returns the candidate pool
  // with recentHitRate attached. SAFE tier uses this as a hard floor; every
  // mode uses it as a soft leg-score adjustment.
  const candidateKey = useMemo(
    () => rawCandidates.map((c) => `${c.id}:${c.playerId ?? ""}:${c.statType ?? ""}:${c.lineValue ?? ""}`).join("|"),
    [rawCandidates]
  );
  const { data: enrichedCandidates } = useQuery({
    queryKey:  ["parlay-candidates-recent-perf", candidateKey],
    queryFn:   () => enrichCandidatesWithRecentPerformance(rawCandidates),
    staleTime: 10 * 60 * 1000,
    gcTime:    30 * 60 * 1000,
    enabled:   rawCandidates.length > 0,
  });

  // Use enriched candidates when available; fall back to raw until fetch lands.
  // First render shows raw (no recentHitRate), then updates once gamelogs resolve.
  const candidates = enrichedCandidates ?? rawCandidates;

  // ML training coverage: log every prop impression, every rejected candidate
  // for the current mode, and every pre-game team pick. Fire-and-forget —
  // dedup happens both client-side (per session) and server-side (unique keys).
  useEffect(() => {
    if (!candidates.length) return;
    const rawProps = (propData?.items ?? []);
    const filteredProps = filterPropsByGameIds
      ? rawProps.filter((p) => filterPropsByGameIds.has(p.game_id))
      : rawProps;
    logPropImpressions(filteredProps).catch(() => {});
    logGamePredictionSnapshots(candidates).catch(() => {});
    logParlayLegRejections(candidates, parlayMode).catch(() => {});
    // CLV — snapshot lines for candidates inside the close-to-tipoff window
    // and seal closing_line_american on prediction_history once games start.
    snapshotClvForCandidates(candidates).catch(() => {});
    sealClvForPredictions(candidates).catch(() => {});
  }, [candidates, parlayMode, propData, filterPropsByGameIds]);
  const triple = useMemo(() => (tripleOpen ? triplePreview(candidates) : null), [tripleOpen, triplePreview, candidates]);
  // Cash-Out parlays today is shown whenever candidates are loaded — the user
  // shouldn't have to toggle the triple card to see the Cash-Out section.
  const cashoutTriple = useMemo(
    () => (candidates.length ? optimizeSmartParlays(candidates, "cashout", analyticsWeights) : null),
    [candidates, analyticsWeights]
  );

  const shareText = useMemo(
    () => (builderLegs.length ? formatBuilderParlayShare(builderLegs, builderMetrics) : ""),
    [builderLegs, builderMetrics]
  );

  const copyShare = async () => {
    if (!shareText) {
      toast.message("Add legs first");
      return;
    }
    try {
      await navigator.clipboard.writeText(shareText);
      toast.success("Parlay summary copied");
    } catch {
      toast.error("Could not copy");
    }
  };

  const saveSnapshot = () => {
    if (!builderLegs.length) {
      toast.message("Add legs first");
      return;
    }
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const prev = raw ? (JSON.parse(raw) as unknown[]) : [];
      const entry = {
        id: `vp-hist-${Date.now()}`,
        savedAt: new Date().toISOString(),
        mode: parlayMode,
        legs: builderLegs.map((l) => ({ id: l.id, label: l.selectionLabel, edge: l.edge })),
        formattedSummary: shareText,
      };
      const next = [entry, ...prev].slice(0, 15);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      toast.success("Saved to parlay history");
    } catch {
      toast.error("Could not save");
    }
  };

  const actionsDisabled = gamesLoading || !candidates.length;

  return (
    <div className="space-y-8">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-violet-500/[0.07] via-card to-card p-5 sm:p-6 space-y-3">
        <div className="absolute -left-6 -bottom-10 h-36 w-36 rounded-full bg-violet-500/10 blur-2xl pointer-events-none" aria-hidden />
        <div className="relative flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="flex items-center gap-2 text-violet-600 dark:text-violet-400">
              <Wrench className="w-6 h-6 shrink-0" />
              <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">Smart parlay</span>
            </div>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-foreground tracking-tight">Parlay builder</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Mode presets tune how many legs we pull from the value board. You get payout and hit-rate estimates plus
              correlation warnings. Stack legs from <span className="text-foreground font-medium">Best value</span> or use
              the one-tap optimizers below.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 lg:w-[min(100%,22rem)] shrink-0 text-center">
            <div className="rounded-xl border border-border/80 bg-background/70 px-3 py-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Pool</p>
              <p className="text-base font-bold tabular-nums text-foreground">{candidates.length}</p>
            </div>
            <div className="rounded-xl border border-border/80 bg-background/70 px-3 py-2.5">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">On slip</p>
              <p className="text-base font-bold tabular-nums text-foreground">{builderLegs.length}</p>
            </div>
            <div className="rounded-xl border border-border/80 bg-background/70 px-3 py-2.5 col-span-2 sm:col-span-1">
              <p className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wide">Mode</p>
              <p className="text-xs font-bold capitalize text-foreground leading-tight pt-0.5">{parlayMode}</p>
            </div>
          </div>
        </div>
      </div>

      <TierPerformanceStrip />

      <RankedLiveParlayPresets games={games} oddsMap={oddsMap} candidates={candidates} gamesLoading={gamesLoading} />

      {bookOddsLoading && !gamesLoading ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden />
          Sportsbook lines still loading — Auto build and payouts may improve after Odds API completes.
        </p>
      ) : null}

      {gamesLoading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-44 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : null}

      {!gamesLoading && candidates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center space-y-2 max-w-xl mx-auto">
          <p className="text-sm text-muted-foreground leading-relaxed">
            No parlay candidates for this slate yet — we need games with usable lines. Open{" "}
            <span className="text-foreground font-medium">Best value</span> after data loads, or use{" "}
            <span className="text-foreground font-medium">Team picks</span> for straight ML edges on the Edge Card slip.
          </p>
        </div>
      ) : null}

      {!gamesLoading && candidates.length > 0 ? (
        <>
          <div className="grid lg:grid-cols-12 gap-4">
            <div className="lg:col-span-5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.04] p-4 sm:p-5 space-y-3 shadow-sm">
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <Wrench className="w-4 h-4 shrink-0" />
                <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  Regular Parlay
                </p>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Maximise probability all legs hit. Pick a tier:
              </p>
              <div className="inline-flex gap-1 rounded-full bg-muted p-0.5 w-full sm:w-auto">
                {(["safe", "balanced", "aggressive"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setParlayMode(m)}
                    className={cn(
                      "flex-1 sm:flex-none px-3 py-2 rounded-full text-xs font-bold transition-colors capitalize",
                      parlayMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground leading-snug">{MODE_LABEL[parlayMode]}</p>
            </div>
            <div className="lg:col-span-7 rounded-xl border border-border bg-card/70 p-4 sm:p-5 shadow-sm">
              <p className="text-[10px] font-semibold tracking-wider text-muted-foreground mb-3">LIVE ESTIMATES</p>
              {builderMetrics ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground">Payout</p>
                    <p className="text-lg font-bold tabular-nums text-foreground">{builderMetrics.projectedPayoutMultiplier.toFixed(2)}x</p>
                  </div>
                  <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground">Proj. hit</p>
                    <p className="text-lg font-bold tabular-nums text-foreground">
                      {(builderMetrics.projectedHitProbability * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-0.5">
                    <p className="text-[10px] text-muted-foreground">Confidence</p>
                    <p className="text-lg font-bold capitalize text-foreground">{builderMetrics.cardConfidence}</p>
                  </div>
                  <div className="rounded-lg bg-muted/40 px-3 py-2 space-y-0.5 col-span-2 sm:col-span-1">
                    <p className="text-[10px] text-muted-foreground">Corr. / vol</p>
                    <p className="text-sm font-semibold tabular-nums text-risk pt-1">
                      {builderMetrics.correlationPenalty} · {builderMetrics.volatilityPenalty}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center sm:text-left">Add legs to see combined price and hit rate.</p>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border/80 bg-muted/20 p-3 sm:p-4 space-y-3">
            <p className="text-[10px] font-semibold tracking-wider text-muted-foreground px-0.5">ACTIONS</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                className="gap-1 touch-manipulation"
                disabled={actionsDisabled}
                onClick={() => {
                  autoBuildFromCandidates(candidates);
                  toast.success("Auto-built from value board");
                }}
              >
                <Zap className="w-3.5 h-3.5" />
                Auto build
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="gap-1 touch-manipulation"
                disabled={actionsDisabled}
                onClick={() => {
                  rebalance(candidates);
                  toast.success("Rebalanced");
                }}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Rebalance
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="touch-manipulation"
                disabled={actionsDisabled}
                onClick={() => {
                  saferSwap(candidates);
                  toast.success("Applied safer mix");
                }}
              >
                Safer swap
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="touch-manipulation gap-1"
                disabled={actionsDisabled}
                onClick={() => {
                  higherPayoutSwap(candidates);
                  toast.success("Applied higher payout mix");
                }}
              >
                <Wallet className="w-3.5 h-3.5" />
                Higher payout
              </Button>
              <Button variant="outline" size="sm" className="gap-1 touch-manipulation" onClick={() => setTripleOpen((v) => !v)}>
                <Shuffle className="w-3.5 h-3.5" />
                {tripleOpen ? "Hide" : "Show"} triple card
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 pt-1 border-t border-border/60">
              <Button variant="ghost" size="sm" className="touch-manipulation gap-1" onClick={clearValueBuilder} disabled={!builderLegs.length}>
                <Trash2 className="w-3.5 h-3.5" />
                Clear legs
              </Button>
              <Button variant="outline" size="sm" className="gap-1 touch-manipulation" onClick={copyShare} disabled={!builderLegs.length}>
                <Copy className="w-3.5 h-3.5" />
                Copy summary
              </Button>
              <Button variant="secondary" size="sm" className="touch-manipulation" onClick={saveSnapshot} disabled={!builderLegs.length}>
                Save to history
              </Button>
            </div>
          </div>

          {triple ? (
            <div className="space-y-2">
              <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground px-0.5">
                Best parlays today
              </p>
              <div className="grid md:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Best value parlay</p>
                  <p className="text-muted-foreground">{triple.bestValue.legs.length} legs</p>
                  <p className="tabular-nums font-semibold">Score {triple.bestValue.smartParlayScore.toFixed(2)}</p>
                  <p className="tabular-nums text-muted-foreground">Payout {triple.bestValue.projectedPayoutMultiplier.toFixed(2)}x</p>
                  {parlayReasons(triple.bestValue).map((r) => (
                    <p key={r} className="text-[9px] text-muted-foreground/60 italic leading-snug">{r}</p>
                  ))}
                </div>
                <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Safer alternative</p>
                  <p className="text-muted-foreground">{triple.safer.legs.length} legs</p>
                  <p className="tabular-nums font-semibold">Hit {(triple.safer.projectedHitProbability * 100).toFixed(1)}%</p>
                  {parlayReasons(triple.safer).map((r) => (
                    <p key={r} className="text-[9px] text-muted-foreground/60 italic leading-snug">{r}</p>
                  ))}
                </div>
                <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Higher payout</p>
                  <p className="text-muted-foreground">{triple.higherPayout.legs.length} legs</p>
                  <p className="tabular-nums font-semibold">{triple.higherPayout.projectedPayoutMultiplier.toFixed(2)}x</p>
                  {parlayReasons(triple.higherPayout).map((r) => (
                    <p key={r} className="text-[9px] text-muted-foreground/60 italic leading-snug">{r}</p>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {cashoutTriple &&
           (cashoutTriple.bestValue.legs.length +
            cashoutTriple.safer.legs.length +
            cashoutTriple.higherPayout.legs.length) > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-0.5">
                <Hourglass className="w-3.5 h-3.5 text-sky-500" />
                <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  Cash-Out parlays today
                </p>
              </div>
              <div className="grid md:grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl border border-sky-500/30 bg-sky-500/[0.06] p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Best cash-out</p>
                  <p className="text-muted-foreground">{cashoutTriple.bestValue.legs.length} legs · staggered</p>
                  <p className="tabular-nums font-semibold">
                    Hit {(cashoutTriple.bestValue.projectedHitProbability * 100).toFixed(1)}%
                  </p>
                  <p className="tabular-nums text-muted-foreground">
                    Payout {cashoutTriple.bestValue.projectedPayoutMultiplier.toFixed(2)}x
                  </p>
                  <p className="text-[9px] text-muted-foreground/60 italic leading-snug">
                    Legs ordered high-prob → upside. Supports early cash-out offers.
                  </p>
                </div>
                <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.03] p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Safer cash-out</p>
                  <p className="text-muted-foreground">{cashoutTriple.safer.legs.length} legs · safer first</p>
                  <p className="tabular-nums font-semibold">
                    Hit {(cashoutTriple.safer.projectedHitProbability * 100).toFixed(1)}%
                  </p>
                  <p className="tabular-nums text-muted-foreground">
                    Payout {cashoutTriple.safer.projectedPayoutMultiplier.toFixed(2)}x
                  </p>
                  <p className="text-[9px] text-muted-foreground/60 italic leading-snug">
                    Prioritises early-leg resolution. Lower variance.
                  </p>
                </div>
                <div className="rounded-xl border border-sky-400/30 bg-sky-400/[0.05] p-4 space-y-1.5">
                  <p className="font-display font-bold text-foreground">Upside cash-out</p>
                  <p className="text-muted-foreground">{cashoutTriple.higherPayout.legs.length} legs · capper last</p>
                  <p className="tabular-nums font-semibold">
                    Payout {cashoutTriple.higherPayout.projectedPayoutMultiplier.toFixed(2)}x
                  </p>
                  <p className="tabular-nums text-muted-foreground">
                    Hit {(cashoutTriple.higherPayout.projectedHitProbability * 100).toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-muted-foreground/60 italic leading-snug">
                    Safer early legs, bigger payout leg last for cash-out growth.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {builderMetrics && builderMetrics.warnings.length > 0 ? (
            <ul className="text-[11px] text-amber-700 dark:text-amber-400 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 space-y-1 list-disc list-inside">
              {builderMetrics.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b border-border/60 pb-2">
              <h3 className="text-sm font-display font-bold text-foreground">Selected legs</h3>
              <span className="text-[10px] font-semibold tabular-nums text-muted-foreground px-2 py-0.5 rounded-full bg-muted/80">
                {builderLegs.length} / 12
              </span>
            </div>
            {builderLegs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/15 px-4 py-8 text-center">
                <p className="text-sm text-muted-foreground">Add picks from Best value, or run Auto build / Rebalance above.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {builderLegs.map((l) => (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border/80 bg-card/80 px-4 py-3 text-xs shadow-sm"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {leagueShort(l.sport)}
                        </span>
                        {l.pickType === "player_prop" ? (
                          <span className="text-[10px] font-bold tracking-wide text-violet-600 dark:text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">
                            PROP
                          </span>
                        ) : null}
                      </div>
                      <p className="font-semibold text-foreground text-sm">{l.selectionLabel}</p>
                      <p className="text-muted-foreground tabular-nums">
                        {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds} · edge {(l.edge * 100).toFixed(1)}% ·{" "}
                        {l.confidence} · {l.riskBand} risk
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-8 shrink-0 text-destructive hover:text-destructive" onClick={() => removeValueLeg(l.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {builderMetrics && builderLegs.length > 0 ? (
            <div className="rounded-xl border border-dashed border-primary/25 bg-primary/[0.04] p-4 sm:p-5 text-xs space-y-2">
              <p className="font-display font-bold text-foreground text-sm">Combined price</p>
              <p className="tabular-nums text-muted-foreground">
                American {builderMetrics.combinedAmericanOdds > 0 ? "+" : ""}
                {builderMetrics.combinedAmericanOdds} · Parlay grade score{" "}
                <span className="font-semibold text-foreground">{builderMetrics.smartParlayScore.toFixed(2)}</span>
              </p>
            </div>
          ) : null}

          <CashOutParlaySection
            candidates={candidates}
            analyticsWeights={analyticsWeights}
            setBuilderLegs={setBuilderLegs}
            disabled={actionsDisabled}
          />
        </>
      ) : null}
    </div>
  );
}
