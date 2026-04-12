import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ParlayBuildMode, SmartParlayResult, ValueBetCandidate } from "@/lib/valueParlay/types";
import { optimizeForMode, optimizeSmartParlays, type AnalyticsWeights } from "@/lib/valueParlay/parlayOptimizer";
import {
  parlayAmericanOdds,
  parlayHitProbability,
  payoutMultiplierFromAmerican,
} from "@/lib/valueParlay/oddsMath";

interface ValueParlayContextValue {
  parlayMode: ParlayBuildMode;
  setParlayMode: (m: ParlayBuildMode) => void;
  analyticsWeights: AnalyticsWeights;
  setAnalyticsWeights: (w: AnalyticsWeights) => void;
  builderLegs: ValueBetCandidate[];
  setBuilderLegs: (legs: ValueBetCandidate[]) => void;
  addValueLeg: (c: ValueBetCandidate) => { ok: boolean; message?: string };
  removeValueLeg: (id: string) => void;
  clearValueBuilder: () => void;
  replaceValueLeg: (id: string, c: ValueBetCandidate) => void;
  autoBuildFromCandidates: (candidates: ValueBetCandidate[]) => void;
  rebalance: (candidates: ValueBetCandidate[]) => void;
  saferSwap: (candidates: ValueBetCandidate[]) => void;
  higherPayoutSwap: (candidates: ValueBetCandidate[]) => void;
  triplePreview: (candidates: ValueBetCandidate[]) => ReturnType<typeof optimizeSmartParlays>;
  builderMetrics: SmartParlayResult | null;
  isValueLegAdded: (id: string) => boolean;
}

const ValueParlayContext = createContext<ValueParlayContextValue | null>(null);

const MAX_BUILDER_LEGS = 12;

function scoreBuilder(legs: ValueBetCandidate[]): SmartParlayResult | null {
  if (!legs.length) return null;
  const combined = parlayAmericanOdds(legs.map((l) => l.americanOdds));
  const hit = parlayHitProbability(legs.map((l) => l.modelProbability));
  const mult = payoutMultiplierFromAmerican(combined);
  const corr = legs.reduce((s, l, _, arr) => {
    const same = arr.filter((x) => x.gameId === l.gameId).length;
    return s + (same > 1 ? 8 : 0);
  }, 0);
  const volPen = legs.reduce((s, l) => s + l.volatilityScore, 0) / legs.length;
  const uncPen = legs.reduce((s, l) => s + l.uncertaintyScore, 0) / legs.length;
  let cardConf: SmartParlayResult["cardConfidence"] = "high";
  const avg =
    legs.reduce((s, l) => s + (l.confidence === "high" ? 3 : l.confidence === "medium" ? 2 : 1), 0) /
    legs.length;
  if (avg < 1.6 || hit < 0.1) cardConf = "low";
  else if (avg < 2.3 || hit < 0.18) cardConf = "medium";

  const warnings: string[] = [];
  const byGame = new Map<string, number>();
  for (const l of legs) {
    byGame.set(l.gameId, (byGame.get(l.gameId) ?? 0) + 1);
  }
  if ([...byGame.values()].some((n) => n >= 2)) {
    warnings.push("Multiple legs from the same game — correlated outcomes.");
  }
  if (legs.some((l) => l.volatilityScore >= 58)) {
    warnings.push("Volatility elevated on one or more legs.");
  }

  return {
    legs,
    projectedHitProbability: Math.round(hit * 1000) / 1000,
    projectedPayoutMultiplier: Math.round(mult * 100) / 100,
    combinedAmericanOdds: combined,
    cardConfidence: cardConf,
    correlationPenalty: Math.min(100, corr),
    volatilityPenalty: Math.round(volPen),
    uncertaintyPenalty: Math.round(uncPen),
    smartParlayScore: legs.reduce((s, l) => s + l.valueScore, 0),
    warnings,
  };
}

export function ValueParlayProvider({ children }: { children: ReactNode }) {
  const [parlayMode, setParlayMode] = useState<ParlayBuildMode>("balanced");
  const [builderLegs, setBuilderLegs] = useState<ValueBetCandidate[]>([]);
  const [analyticsWeights, setAnalyticsWeights] = useState<AnalyticsWeights>({});

  const addValueLeg = useCallback((c: ValueBetCandidate): { ok: boolean; message?: string } => {
    if (builderLegs.some((x) => x.id === c.id)) {
      return { ok: false, message: "Already on parlay builder" };
    }
    if (builderLegs.length >= MAX_BUILDER_LEGS) {
      return { ok: false, message: `Max ${MAX_BUILDER_LEGS} legs` };
    }
    const byGame = builderLegs.filter((x) => x.gameId === c.gameId).length;
    if (byGame >= 2) {
      return { ok: false, message: "Max 2 legs per game in smart parlay" };
    }
    setBuilderLegs((s) => [...s, c]);
    return { ok: true };
  }, [builderLegs]);

  const removeValueLeg = useCallback((id: string) => {
    setBuilderLegs((s) => s.filter((x) => x.id !== id));
  }, []);

  const clearValueBuilder = useCallback(() => setBuilderLegs([]), []);

  const replaceValueLeg = useCallback((id: string, c: ValueBetCandidate) => {
    setBuilderLegs((s) => s.map((x) => (x.id === id ? c : x)));
  }, []);

  const autoBuildFromCandidates = useCallback(
    (candidates: ValueBetCandidate[]) => {
      const r = optimizeForMode(candidates, parlayMode, analyticsWeights);
      setBuilderLegs(r.legs);
    },
    [parlayMode, analyticsWeights]
  );

  const rebalance = useCallback(
    (candidates: ValueBetCandidate[]) => {
      const t = optimizeSmartParlays(candidates, parlayMode, analyticsWeights);
      setBuilderLegs(t.bestValue.legs);
    },
    [parlayMode, analyticsWeights]
  );

  const saferSwap = useCallback(
    (candidates: ValueBetCandidate[]) => {
      const t = optimizeSmartParlays(candidates, parlayMode, analyticsWeights);
      setBuilderLegs(t.safer.legs);
    },
    [parlayMode, analyticsWeights]
  );

  const higherPayoutSwap = useCallback(
    (candidates: ValueBetCandidate[]) => {
      const t = optimizeSmartParlays(candidates, parlayMode, analyticsWeights);
      setBuilderLegs(t.higherPayout.legs);
    },
    [parlayMode, analyticsWeights]
  );

  const triplePreview = useCallback((candidates: ValueBetCandidate[]) => {
    return optimizeSmartParlays(candidates, parlayMode, analyticsWeights);
  }, [parlayMode, analyticsWeights]);

  const builderMetrics = useMemo(() => scoreBuilder(builderLegs), [builderLegs]);

  const isValueLegAdded = useCallback(
    (id: string) => builderLegs.some((x) => x.id === id),
    [builderLegs]
  );

  const value = useMemo(
    () => ({
      parlayMode,
      setParlayMode,
      analyticsWeights,
      setAnalyticsWeights,
      builderLegs,
      setBuilderLegs,
      addValueLeg,
      removeValueLeg,
      clearValueBuilder,
      replaceValueLeg,
      autoBuildFromCandidates,
      rebalance,
      saferSwap,
      higherPayoutSwap,
      triplePreview,
      builderMetrics,
      isValueLegAdded,
    }),
    [
      parlayMode,
      analyticsWeights,
      builderLegs,
      addValueLeg,
      removeValueLeg,
      clearValueBuilder,
      replaceValueLeg,
      autoBuildFromCandidates,
      rebalance,
      saferSwap,
      higherPayoutSwap,
      triplePreview,
      builderMetrics,
      isValueLegAdded,
    ]
  );

  return <ValueParlayContext.Provider value={value}>{children}</ValueParlayContext.Provider>;
}

export function useValueParlay(): ValueParlayContextValue {
  const ctx = useContext(ValueParlayContext);
  if (!ctx) throw new Error("useValueParlay must be used within ValueParlayProvider");
  return ctx;
}
