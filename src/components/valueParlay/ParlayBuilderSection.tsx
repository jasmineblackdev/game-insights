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
import { syncPlattParamsFromSupabase } from "@/lib/ml/calibration";
import { logRecommendedParlay, type SaveStatus } from "@/lib/parlayTracking/recommendedParlayLogger";
import { AutoProfitBuilderHint } from "@/components/dailyPlan/AutoProfitBuilderHint";
import { DkExecutionAssistant } from "@/components/valueParlay/DkExecutionAssistant";
import { CandidatePoolGroups } from "@/components/valueParlay/CandidatePoolGroups";
import { PropScanner } from "@/components/playerProps/PropScanner";
import { legAudit } from "@/lib/valueParlay/executionAssistant";

const MODE_LABEL: Record<ParlayBuildMode, string> = {
  safe: "Safe (2 legs · +120 to +320)",
  balanced: "Balanced (3 legs · +250 to +550)",
  aggressive: "Aggressive (5–6 legs)",
  cashout: "Cash-Out (3 legs, staggered)",
  bigwin: "Big Win (4 legs · +800 to +1200, strict floors)",
  lotto: "Lotto (5–7 legs · high upside, clearly risky)",
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

// ── Per-card transparency widgets ───────────────────────────────────────────
// "Would I take it" pill + per-card leg breakdown showing the strongest /
// weakest leg picked by scoreParlay() so the user can see exactly which leg
// is dragging the card down.

// ── Save Status indicator ───────────────────────────────────────────────────
// Shows the result of every auto-save so the user can tell when Supabase
// is rejecting the insert (e.g. table missing) vs everything healthy.

const STATUS_COLOR: Record<SaveStatus, string> = {
  saved:         "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  duplicate:     "bg-muted text-muted-foreground",
  failed:        "bg-red-500/15 text-red-600 dark:text-red-400",
  missing_table: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  waiting:       "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  no_supabase:   "bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<SaveStatus, string> = {
  saved:         "Saved",
  duplicate:     "Already saved",
  failed:        "Failed",
  missing_table: "DB missing",
  waiting:       "Saving…",
  no_supabase:   "No DB",
};

function SaveStatusIndicator({ statuses }: { statuses: Record<string, SaveStatus> }) {
  const entries = Object.entries(statuses);
  if (!entries.length) return null;
  const missing = entries.some(([, s]) => s === "missing_table");
  const failed  = entries.some(([, s]) => s === "failed");
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px] pt-1">
      <span className="font-semibold text-muted-foreground tracking-wider">SAVE STATUS</span>
      {entries.map(([variant, status]) => (
        <span key={variant} className={cn("px-1.5 py-0.5 rounded font-semibold", STATUS_COLOR[status])}>
          {variant}: {STATUS_LABEL[status]}
        </span>
      ))}
      {missing && (
        <span className="ml-2 text-amber-700 dark:text-amber-400 italic">
          Run the recommended_parlays migration to enable history.
        </span>
      )}
      {failed && !missing && (
        <span className="ml-2 text-red-600 dark:text-red-400 italic">
          Auto-save failed — check console.
        </span>
      )}
    </div>
  );
}

function WouldITakePill({ result }: { result: SmartParlayResult }) {
  if (result.wouldITakeIt == null) return null;
  const yes = result.wouldITakeIt;
  return (
    <span
      title={result.wouldITakeItReason ?? ""}
      className={cn(
        "text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded-full border",
        yes
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30"
      )}
    >
      {yes ? "I'd TAKE" : "I'd PASS"}
    </span>
  );
}

function LegBreakdown({ result }: { result: SmartParlayResult }) {
  if (!result.legs.length) return null;
  const strongIdx = result.legs.findIndex((l) => l.id === result.strongestLegId);
  const weakIdx   = result.legs.findIndex((l) => l.id === result.weakestLegId);
  const strong = strongIdx >= 0 ? result.legs[strongIdx] : null;
  const weak   = weakIdx   >= 0 ? result.legs[weakIdx]   : null;
  // Surface the WHY for the weakest leg — runs the same legAudit
  // logic the per-card DecisionPill uses, so the reason language is
  // consistent across the page.
  const weakReason = weak ? legAudit(weak).reason : null;
  return (
    <div className="space-y-0.5 pt-1 border-t border-border/40">
      {strong && (
        <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
          <span className="font-bold">Strongest:</span>{" "}
          <span className="text-foreground/80">{strong.selectionLabel}</span>
        </p>
      )}
      {weak && weakIdx !== strongIdx && (
        <p className="text-[10px] text-amber-700 dark:text-amber-400">
          <span className="font-bold">Weakest:</span>{" "}
          <span className="text-foreground/80">{weak.selectionLabel}</span>
          {weakReason ? (
            <span className="text-muted-foreground"> — {weakReason}</span>
          ) : null}
        </p>
      )}
    </div>
  );
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
    publishCandidatePool,
  } = useValueParlay();

  // Default OPEN — users were missing the "Best parlays today" card
  // because they didn't realize they had to toggle "Show triple card".
  // The cash-out triple already shows automatically; this brings the
  // regular triple to parity. Toggle still available for users who
  // want the surface compacted.
  const [tripleOpen, setTripleOpen] = useState(true);

  // Load Platt calibration params once per session — used by candidate
  // builders to scale raw model probabilities to observed hit rates.
  useEffect(() => {
    // Pull nightly-fitted Platt params into the in-memory cache AND mirror
    // the Supabase rows into localStorage so the blending layer's
    // loadPlattParams reads calibrated values instead of identity defaults.
    loadPlattParams().catch(() => {});
    syncPlattParamsFromSupabase().catch(() => {});
  }, []);

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

  // Publish to context so the sticky slip drawer's Replace Weakest can
  // search this pool when the user taps Replace from the slip.
  useEffect(() => {
    publishCandidatePool(candidates);
  }, [candidates, publishCandidatePool]);

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

  // Auto-save every recommended parlay to recommended_parlays so the user
  // has a full history regardless of whether they actually placed it.
  // Status surfaces in the Save Status indicator below.
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({});
  useEffect(() => {
    const update = (key: string, status: SaveStatus) =>
      setSaveStatuses((s) => ({ ...s, [key]: status }));

    const fire = (key: string, args: Parameters<typeof logRecommendedParlay>[0]) => {
      update(key, "waiting");
      logRecommendedParlay(args).then(
        (status) => update(key, status),
        () => update(key, "failed"),
      );
    };

    if (triple) {
      fire("best_value",    { tier: parlayMode, variant: "best_value",    result: triple.bestValue,    source: "parlay_builder" });
      fire("safer",         { tier: parlayMode, variant: "safer",         result: triple.safer,        source: "parlay_builder" });
      fire("higher_payout", { tier: parlayMode, variant: "higher_payout", result: triple.higherPayout, source: "parlay_builder" });
    }
    if (cashoutTriple) {
      fire("cashout_best",   { tier: "cashout", variant: "cashout_best",   result: cashoutTriple.bestValue,    source: "parlay_builder" });
      fire("cashout_safer",  { tier: "cashout", variant: "cashout_safer",  result: cashoutTriple.safer,         source: "parlay_builder" });
      fire("cashout_upside", { tier: "cashout", variant: "cashout_upside", result: cashoutTriple.higherPayout, source: "parlay_builder" });
    }
  }, [triple, cashoutTriple, parlayMode]);

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

  // ── Strategy card data — drives Step 1 ───────────────────────────────
  // Three primary strategies map to the existing parlayMode state. Each
  // card displays the optimizer's projected hit + payout for THAT mode
  // by reading off optimizeSmartParlays(mode).bestValue. Cheap because
  // optimizeSmartParlays is pure + memoized in context callbacks.
  const strategyCards = [
    {
      mode: "safe" as ParlayBuildMode,
      label: "SAFE",
      tagline: "High probability · lower payout",
      legHint: "2–3 legs",
      tone: "border-emerald-500/40 bg-emerald-500/[0.06]",
      activeTone: "border-emerald-500 bg-emerald-500/[0.12] ring-2 ring-emerald-500/30",
    },
    {
      mode: "balanced" as ParlayBuildMode,
      label: "BALANCED",
      tagline: "Medium risk · medium reward",
      legHint: "3–4 legs",
      tone: "border-amber-500/40 bg-amber-500/[0.06]",
      activeTone: "border-amber-500 bg-amber-500/[0.12] ring-2 ring-amber-500/30",
    },
    {
      mode: "aggressive" as ParlayBuildMode,
      label: "AGGRESSIVE",
      tagline: "High payout · lower probability",
      legHint: "5–8 legs",
      tone: "border-violet-500/40 bg-violet-500/[0.06]",
      activeTone: "border-violet-500 bg-violet-500/[0.12] ring-2 ring-violet-500/30",
    },
  ];

  return (
    <div className="space-y-6">
      {/* ─────────────────────────────────────────────────────────────
          STEP 1 — Pick a strategy.
          Single decision-first entry point. Click → set parlayMode +
          autoBuild. Replaces the old "Smart Parlay vs Regular Parlay"
          two-card distinction.
         ───────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="font-display font-bold text-xl sm:text-2xl text-foreground">Build Your Parlay</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {strategyCards.map((s) => {
            const preview = candidates.length > 0 ? optimizeSmartParlays(candidates, s.mode, analyticsWeights) : null;
            const card = preview?.bestValue ?? null;
            const isActive = parlayMode === s.mode;
            return (
              <button
                key={s.mode}
                type="button"
                onClick={() => {
                  setParlayMode(s.mode);
                  if (candidates.length > 0) {
                    autoBuildFromCandidates(candidates);
                    toast.success(`${s.label} parlay built`);
                  }
                }}
                disabled={actionsDisabled}
                className={cn(
                  "rounded-xl border text-left p-4 transition-all touch-manipulation",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  isActive ? s.activeTone : `${s.tone} hover:brightness-110`,
                )}
              >
                <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                  {s.legHint}
                </p>
                <p className="font-display font-bold text-base text-foreground mt-0.5">{s.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.tagline}</p>
                {card && card.legs.length > 0 ? (
                  <div className="mt-2 grid grid-cols-2 gap-1 text-[11px]">
                    <div>
                      <span className="text-muted-foreground">Hit </span>
                      <span className="tabular-nums font-bold text-foreground">
                        {(card.projectedHitProbability * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Pay </span>
                      <span className="tabular-nums font-bold text-foreground">
                        {card.projectedPayoutMultiplier.toFixed(2)}x
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground mt-2 italic">
                    {gamesLoading ? "Loading slate…" : "No qualifying legs"}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Stale-line / book-loading notice — single line, no banner. */}
      {bookOddsLoading && !gamesLoading ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden />
          Sportsbook lines still loading — payouts may improve.
        </p>
      ) : null}

      {/* Slate-empty fallback */}
      {!gamesLoading && candidates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No parlay candidates for this slate yet — refresh once games load with usable lines.
          </p>
        </div>
      ) : null}

      {!gamesLoading && candidates.length > 0 ? (
        <>
          {/* ─────────────────────────────────────────────────────────
              STEP 2 — Your Parlay (the slip).
              Shows current legs + combined odds + projected hit prob +
              warnings. Empty state guides user to Auto Build or Add.
             ───────────────────────────────────────────────────────── */}
          <section className="rounded-xl border border-border/80 bg-card/70 p-4 sm:p-5 space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-display font-bold text-foreground">Your Parlay</h3>
              <span className="text-[10px] font-semibold tabular-nums text-muted-foreground">
                {builderLegs.length} / 12 legs
              </span>
            </div>

            {builderLegs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/15 px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  Tap <span className="font-medium text-foreground">Auto Build</span> or add picks below.
                </p>
              </div>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {builderLegs.map((l) => (
                    <li
                      key={l.id}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-background/50 px-2.5 py-2 text-xs"
                    >
                      <span className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">
                        {leagueShort(l.sport)}
                      </span>
                      {l.pickType === "player_prop" ? (
                        <span className="text-[10px] font-bold tracking-wide text-violet-600 dark:text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded-full shrink-0">
                          PROP
                        </span>
                      ) : null}
                      <span className="flex-1 min-w-0 truncate font-semibold text-foreground">
                        {l.selectionLabel}
                      </span>
                      <span className="font-mono tabular-nums text-[11px] text-muted-foreground shrink-0">
                        {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => removeValueLeg(l.id)}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
                {builderMetrics ? (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">Combined</p>
                      <p className="font-bold tabular-nums text-foreground">
                        {builderMetrics.combinedAmericanOdds > 0 ? "+" : ""}{builderMetrics.combinedAmericanOdds}
                      </p>
                    </div>
                    <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">Hit prob</p>
                      <p className="font-bold tabular-nums text-foreground">
                        {(builderMetrics.projectedHitProbability * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                      <p className="text-[10px] text-muted-foreground">Payout</p>
                      <p className="font-bold tabular-nums text-foreground">
                        {builderMetrics.projectedPayoutMultiplier.toFixed(2)}x
                      </p>
                    </div>
                  </div>
                ) : null}
                {builderMetrics && builderMetrics.warnings.length > 0 ? (
                  <ul className="text-[11px] text-amber-700 dark:text-amber-400 rounded-md bg-amber-500/[0.06] px-2.5 py-1.5 space-y-0.5">
                    {builderMetrics.warnings.slice(0, 3).map((w) => (
                      <li key={w}>⚠ {w}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </section>

          {/* ─────────────────────────────────────────────────────────
              STEP 3 — Actions.
              Primary: Auto Build (visible when slip is empty OR user
              wants to rebuild). Secondary: Rebalance / Safer / Higher
              payout (visible when slip has legs).
             ───────────────────────────────────────────────────────── */}
          <section className="flex flex-wrap gap-2">
            <Button
              variant="default"
              size="sm"
              className="gap-1 touch-manipulation"
              disabled={actionsDisabled}
              onClick={() => {
                autoBuildFromCandidates(candidates);
                toast.success("Auto-built parlay");
              }}
            >
              <Zap className="w-3.5 h-3.5" />
              Auto Build Parlay
            </Button>
            {builderLegs.length > 0 ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1 touch-manipulation"
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
                  onClick={() => {
                    saferSwap(candidates);
                    toast.success("Safer mix applied");
                  }}
                >
                  Safer version
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="touch-manipulation gap-1"
                  onClick={() => {
                    higherPayoutSwap(candidates);
                    toast.success("Higher payout mix applied");
                  }}
                >
                  <Wallet className="w-3.5 h-3.5" />
                  Higher payout
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="touch-manipulation gap-1 ml-auto"
                  onClick={clearValueBuilder}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear
                </Button>
              </>
            ) : null}
          </section>

          {/* ─────────────────────────────────────────────────────────
              STEP 4 — Best Picks Right Now.
              Compact prop scanner. Tapping any row adds it to the
              slip. The full grouped pool + Cash-Out builder live in
              Advanced (Step 5) so this section stays scannable.
             ───────────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <h3 className="text-sm font-display font-bold text-foreground">Best Picks Right Now</h3>
            <PropScanner candidates={candidates} />
          </section>

          {/* DraftKings Execution Assistant — kept visible per spec
              ("Keep: execution assistant in Builder only"). It acts on
              the current slip + pool, so it lives between Best Picks
              and the collapsed Advanced section. */}
          <DkExecutionAssistant slipLegs={builderLegs} candidatePool={candidates} />

          {/* ─────────────────────────────────────────────────────────
              STEP 5 — Advanced (collapsible).
              Pool count, mode dropdown (5-tier full control), odds
              status, full candidate pool browser, cash-out builder,
              parlay alternative cards, save/copy actions. Hidden by
              default — power-user surface.
             ───────────────────────────────────────────────────────── */}
          <details className="rounded-xl border border-border/60 bg-muted/15 p-4 group">
            <summary className="cursor-pointer select-none text-sm font-semibold text-foreground flex items-center gap-2">
              <Wrench className="w-4 h-4 text-muted-foreground group-open:text-foreground" />
              Advanced settings
              <span className="text-[10px] text-muted-foreground ml-auto">
                pool {candidates.length} · {parlayMode} mode
              </span>
            </summary>

            <div className="space-y-4 pt-4">
              {/* Mode dropdown — 5 tiers including bigwin/lotto for power users */}
              <div className="space-y-1">
                <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">Build mode</p>
                <div className="inline-flex gap-1 rounded-full bg-muted p-0.5">
                  {(["safe", "balanced", "bigwin", "aggressive", "lotto"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setParlayMode(m)}
                      className={cn(
                        "px-3 py-1.5 rounded-full text-xs font-bold transition-colors capitalize",
                        parlayMode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{MODE_LABEL[parlayMode]}</p>
              </div>

              {/* Pool integrity callout */}
              {(() => {
                const stale = candidates.filter((c) => c.staleLineFlag).length;
                const late = candidates.filter((c) => c.lateChangeInvalidated).length;
                if (stale + late === 0) return null;
                return (
                  <p
                    className="text-[11px] text-amber-700 dark:text-amber-400"
                    title="Excluded from parlay recommendation by integrity gates."
                  >
                    {stale ? `${stale} stale` : null}
                    {stale && late ? " · " : null}
                    {late ? `${late} late change` : null} excluded
                  </p>
                );
              })()}

              <RankedLiveParlayPresets games={games} oddsMap={oddsMap} candidates={candidates} gamesLoading={gamesLoading} />

              {/* Triple-card alternatives — power-user view of the
                  optimizer's three variants for the active mode. */}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="gap-1" onClick={() => setTripleOpen((v) => !v)}>
                  <Shuffle className="w-3.5 h-3.5" />
                  {tripleOpen ? "Hide" : "Show"} three-variant view
                </Button>
                <Button variant="outline" size="sm" className="gap-1" onClick={copyShare} disabled={!builderLegs.length}>
                  <Copy className="w-3.5 h-3.5" />
                  Copy summary
                </Button>
                <Button variant="secondary" size="sm" onClick={saveSnapshot} disabled={!builderLegs.length}>
                  Save to history
                </Button>
              </div>
              <SaveStatusIndicator statuses={saveStatuses} />

              {triple && tripleOpen ? (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">
                    Optimizer variants ({parlayMode} mode)
                  </p>
                  <div className="grid md:grid-cols-3 gap-3 text-xs">
                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.06] p-4 space-y-1.5 flex flex-col">
                      <div className="flex items-center justify-between">
                        <p className="font-display font-bold text-foreground">Best value</p>
                        <WouldITakePill result={triple.bestValue} />
                      </div>
                      <p className="text-muted-foreground">{triple.bestValue.legs.length} legs</p>
                      <p className="tabular-nums font-semibold">Score {triple.bestValue.smartParlayScore.toFixed(2)}</p>
                      <p className="tabular-nums text-muted-foreground">Payout {triple.bestValue.projectedPayoutMultiplier.toFixed(2)}x</p>
                      <LegBreakdown result={triple.bestValue} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-auto w-full h-8 text-xs"
                        onClick={() => {
                          setBuilderLegs(triple.bestValue.legs);
                          toast.success("Best value parlay applied");
                        }}
                      >
                        Apply to slip
                      </Button>
                    </div>
                    <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-1.5 flex flex-col">
                      <div className="flex items-center justify-between">
                        <p className="font-display font-bold text-foreground">Safer alternative</p>
                        <WouldITakePill result={triple.safer} />
                      </div>
                      <p className="text-muted-foreground">{triple.safer.legs.length} legs</p>
                      <p className="tabular-nums font-semibold">Hit {(triple.safer.projectedHitProbability * 100).toFixed(1)}%</p>
                      <LegBreakdown result={triple.safer} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-auto w-full h-8 text-xs"
                        onClick={() => {
                          setBuilderLegs(triple.safer.legs);
                          toast.success("Safer alternative applied");
                        }}
                      >
                        Apply to slip
                      </Button>
                    </div>
                    <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.06] p-4 space-y-1.5 flex flex-col">
                      <div className="flex items-center justify-between">
                        <p className="font-display font-bold text-foreground">Higher payout</p>
                        <WouldITakePill result={triple.higherPayout} />
                      </div>
                      <p className="text-muted-foreground">{triple.higherPayout.legs.length} legs</p>
                      <p className="tabular-nums font-semibold">{triple.higherPayout.projectedPayoutMultiplier.toFixed(2)}x</p>
                      <LegBreakdown result={triple.higherPayout} />
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-auto w-full h-8 text-xs"
                        onClick={() => {
                          setBuilderLegs(triple.higherPayout.legs);
                          toast.success("Higher payout applied");
                        }}
                      >
                        Apply to slip
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              <CashOutParlaySection
                candidates={candidates}
                analyticsWeights={analyticsWeights}
                setBuilderLegs={setBuilderLegs}
                disabled={actionsDisabled}
              />

              <CandidatePoolGroups candidates={candidates} />

              <details className="rounded-md border border-border/40 bg-background/40 p-2">
                <summary className="cursor-pointer text-[11px] text-muted-foreground select-none">
                  Diagnostics — tier performance + auto-profit hint
                </summary>
                <div className="mt-2 space-y-3">
                  <TierPerformanceStrip />
                  <AutoProfitBuilderHint />
                </div>
              </details>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
