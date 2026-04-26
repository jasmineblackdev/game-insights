import { type ReactNode, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Brain,
  Bug,
  ChevronDown,
  ChevronUp,
  Clock,
  Globe,
  Hourglass,
  Shield,
  Sliders,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { GamePrediction, League } from "@/data/mockGames";
import { cn } from "@/lib/utils";
import { buildAllValueCandidates, buildEnrichedPropCandidates } from "@/lib/valueParlay/buildCandidates";
import { optimizeSmartParlays } from "@/lib/valueParlay/parlayOptimizer";
import type { SmartParlayResult } from "@/lib/valueParlay/types";
import { useQuery } from "@tanstack/react-query";
import { fetchPlayerEdgePredictions } from "@/lib/playerEdgeApi";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import type { ParlayBuildMode, ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  type AutoParlay,
  type ParlayEdgeDebugInfo,
  type ParlayEdgeOutput,
  type SportCoverageInfo,
  type SportFilterMode,
  COMBO_WARNINGS,
  TIMING_CONFIGS,
  generateParlayEdge,
  getLearningInsights,
  parlayModeDescription,
  parlayModeLabel,
  SPORT_TIERS,
  timingTagShort,
} from "@/lib/parlayEdge";

// ─── Helpers ─────────────────────────────────────────────────────

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

function formatEdge(n: number) {
  const s = n >= 0 ? "+" : "";
  return `${s}${(n * 100).toFixed(1)}%`;
}

function formatAmerican(n: number) {
  return n > 0 ? `+${n}` : String(n);
}

function sportBadge(sport: string) {
  if (sport === "mma") return "UFC";
  return sport.toUpperCase();
}

function confidenceColor(c: "high" | "medium" | "low") {
  if (c === "high")   return "text-confidence-high";
  if (c === "medium") return "text-amber-500";
  return "text-destructive";
}

function riskColor(mode: ParlayBuildMode) {
  if (mode === "safe")       return "text-confidence-high";
  if (mode === "balanced")   return "text-amber-500";
  if (mode === "cashout")    return "text-sky-500";
  return "text-destructive";
}

function tierLabel(sport: string): string {
  const t = SPORT_TIERS[sport as League];
  if (t === 1) return "Foundation";
  if (t === 2) return "Support";
  return "Selective";
}

function tierColor(sport: string) {
  const t = SPORT_TIERS[sport as League];
  if (t === 1) return "text-confidence-high";
  if (t === 2) return "text-primary";
  return "text-amber-500";
}

const SPORT_LABELS: Record<League, string> = {
  nba: "NBA", wnba: "WNBA", nfl: "NFL", mlb: "MLB", boxing: "Boxing", mma: "UFC/MMA",
};

// ─── Sport Coverage Bar ───────────────────────────────────────────

function SportCoverageBar({ info }: { info: SportCoverageInfo }) {
  const pct = info.totalCandidates > 0
    ? Math.round((info.qualifyingCandidates / Math.max(1, info.totalCandidates)) * 100)
    : 0;
  const isEmpty = info.totalCandidates === 0;

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-16 shrink-0 text-muted-foreground font-semibold">
        {SPORT_LABELS[info.sport]}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-muted/60 overflow-hidden">
        {!isEmpty && (
          <div
            className={cn(
              "h-full rounded-full transition-all",
              pct >= 60 ? "bg-confidence-high" : pct >= 30 ? "bg-primary" : "bg-amber-500"
            )}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      <span className="w-20 text-right text-muted-foreground">
        {isEmpty
          ? "no games"
          : `${info.qualifyingCandidates}/${info.totalCandidates} qualify`
        }
      </span>
    </div>
  );
}

// ─── Debug Panel ──────────────────────────────────────────────────

function DebugPanel({ debug, parlayLegs }: { debug: ParlayEdgeDebugInfo; parlayLegs: { parlay: AutoParlay; label: string }[] }) {
  const [open, setOpen] = useState(false);

  const sportsByParlay = parlayLegs.map(({ parlay, label }) => {
    const counts: Record<string, number> = {};
    for (const leg of parlay.legs) {
      counts[leg.sport] = (counts[leg.sport] ?? 0) + 1;
    }
    return { label, counts };
  });

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        <Bug className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold text-primary">Sport Coverage Debug</span>
        {debug.coverageBug && (
          <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full bg-destructive/20 text-destructive font-bold">
            COVERAGE BUG
          </span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto mr-1">
          {debug.filterMode} · {debug.sportsInPool.length} sports in pool
        </span>
        {open ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-4 border-t border-primary/10 pt-3">
              {/* Candidate pool by sport */}
              <div>
                <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                  Candidate Pool by Sport ({debug.totalCandidatesConsidered} total)
                </p>
                <div className="space-y-1.5">
                  {debug.sportCoverage.map((s) => (
                    <SportCoverageBar key={s.sport} info={s} />
                  ))}
                </div>
              </div>

              {/* Final parlay sport breakdown */}
              {sportsByParlay.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-2">
                    Final Parlay Sport Mix
                  </p>
                  <div className="space-y-1.5">
                    {sportsByParlay.map(({ label, counts }) => (
                      <div key={label} className="flex items-center gap-2 text-[11px]">
                        <span className="w-24 shrink-0 text-muted-foreground">{label}:</span>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(counts).map(([sport, n]) => (
                            <span key={sport} className={cn("font-bold", tierColor(sport))}>
                              {sportBadge(sport)} ×{n}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sports excluded */}
              {(() => {
                const excluded = debug.sportCoverage.filter(
                  (s) => s.qualifyingCandidates === 0 && s.totalCandidates > 0
                );
                const noGames = debug.sportCoverage.filter((s) => s.totalCandidates === 0);
                return (
                  <>
                    {excluded.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
                          Excluded (no qualifying candidates)
                        </p>
                        {excluded.map((s) => (
                          <p key={s.sport} className="text-[11px] text-amber-600 dark:text-amber-500">
                            {SPORT_LABELS[s.sport]}: {s.totalCandidates} candidates but 0 qualify (need edge &gt; 0 + medium/high confidence)
                          </p>
                        ))}
                      </div>
                    )}
                    {noGames.length > 0 && (
                      <div>
                        <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1">
                          No Games Loaded
                        </p>
                        {noGames.map((s) => (
                          <p key={s.sport} className="text-[11px] text-muted-foreground">
                            {SPORT_LABELS[s.sport]}: 0 candidates (no games fetched yet)
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}

              {debug.coverageBug && (
                <div className="rounded bg-destructive/10 border border-destructive/20 p-2 text-[11px] text-destructive">
                  Coverage bug detected: only 1 sport in pool but {debug.sportCoverage.filter(s => s.qualifyingCandidates > 0).length} sports have qualifying candidates.
                  Check that <code className="text-[10px]">allGames</code> includes all sport data.
                </div>
              )}

              <p className="text-[10px] text-muted-foreground">
                Mode: <span className="font-semibold">{debug.filterMode}</span>
                {debug.biasSport && <> · Bias: <span className="font-semibold">{SPORT_LABELS[debug.biasSport]}</span></>}
                {" "}· Sports in pool: {debug.sportsInPool.map((s) => sportBadge(s)).join(", ") || "none"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Mode Selector ────────────────────────────────────────────────

const MODES: { mode: SportFilterMode; label: string; icon: ReactNode; desc: string }[] = [
  {
    mode: "global",
    label: "Global",
    icon: <Globe className="w-3 h-3" />,
    desc: "All sports · strongest EV",
  },
  {
    mode: "biased",
    label: "Biased",
    icon: <Sliders className="w-3 h-3" />,
    desc: "Current sport preferred",
  },
  {
    mode: "sport_only",
    label: "Sport only",
    icon: <Shield className="w-3 h-3" />,
    desc: "Hard single-sport filter",
  },
];

const ALL_SPORTS: League[] = ["nba", "nfl", "mlb", "boxing", "mma"];

function ModeSelector({
  filterMode,
  setFilterMode,
  biasSport,
  setBiasSport,
}: {
  filterMode: SportFilterMode;
  setFilterMode: (m: SportFilterMode) => void;
  biasSport: League;
  setBiasSport: (l: League) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 flex-wrap">
      <div className="inline-flex rounded-full bg-muted p-0.5 gap-0.5">
        {MODES.map(({ mode, label, icon }) => (
          <button
            key={mode}
            type="button"
            onClick={() => setFilterMode(mode)}
            className={cn(
              "flex items-center gap-1.5 min-h-9 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors touch-manipulation shrink-0",
              filterMode === mode
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground active:bg-muted"
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {(filterMode === "biased" || filterMode === "sport_only") && (
        <div className="inline-flex rounded-full bg-muted p-0.5 gap-0.5">
          {ALL_SPORTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setBiasSport(s)}
              className={cn(
                "min-h-9 px-3 py-1.5 rounded-full text-xs font-bold tracking-wide transition-colors touch-manipulation shrink-0",
                biasSport === s
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground active:bg-muted"
              )}
            >
              {sportBadge(s)}
            </button>
          ))}
        </div>
      )}

      <span className="text-[10px] text-muted-foreground hidden sm:block">
        {MODES.find((m) => m.mode === filterMode)?.desc}
        {filterMode !== "global" && ` · ${SPORT_LABELS[biasSport]}`}
      </span>
    </div>
  );
}

// ─── Timing Badge ─────────────────────────────────────────────────

function TimingBadge({ sport, marketType }: { sport: League; marketType: string }) {
  const tag   = timingTagShort(sport, marketType);
  const cfg   = TIMING_CONFIGS[sport];
  // MLB and combat sports show the live uplift more prominently since it's meaningful
  const isNonTrival = sport === "mlb" || sport === "mma" || sport === "boxing";
  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 text-[9px]",
      isNonTrival ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
    )}>
      <Clock className="w-2.5 h-2.5 shrink-0" />
      {tag}
    </span>
  );
}

// ─── Cash-Out Card ───────────────────────────────────────────────
// Renders one variant of the cashout triple produced by optimizeSmartParlays.
// Sky-tinted for visual parity with the dedicated Cash-Out UI elsewhere.

function CashoutCard({
  variant,
  label,
  result,
}: {
  variant: "Best" | "Safer" | "Upside";
  label: string;
  result: SmartParlayResult;
}) {
  const [expanded, setExpanded] = useState(false);
  const legs = result.legs;
  const empty = legs.length === 0;

  const tint =
    variant === "Best"   ? "border-sky-500/40 bg-sky-500/[0.06]"
    : variant === "Safer" ? "border-sky-500/25 bg-sky-500/[0.03]"
    :                       "border-sky-400/40 bg-sky-400/[0.05]";

  return (
    <motion.div layout className={cn("rounded-lg border p-4 space-y-3 transition-colors", tint)}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold tracking-wider text-sky-600 dark:text-sky-400">
              {label.toUpperCase()}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold">
              {legs.length}-LEG
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
            {variant === "Best"
              ? "Staggered starts · high-prob first · cash-out ready"
              : variant === "Safer"
                ? "Safer early legs · prioritises early resolution"
                : "Safer early + upside leg last for cash-out growth"}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold tabular-nums text-foreground">
            {result.combinedAmericanOdds > 0 ? "+" : ""}{result.combinedAmericanOdds}
          </p>
          <p className="text-[10px] tabular-nums text-muted-foreground">
            {result.projectedPayoutMultiplier.toFixed(2)}x payout
          </p>
        </div>
      </div>

      {empty ? (
        <p className="text-[11px] text-muted-foreground italic">
          Not enough qualifying legs today for this variant.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded bg-background/40 border border-border/60 px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Hit prob</p>
            <p className="text-sm font-bold tabular-nums text-foreground">
              {(result.projectedHitProbability * 100).toFixed(1)}%
            </p>
          </div>
          <div className="rounded bg-background/40 border border-border/60 px-2 py-1.5">
            <p className="text-[9px] text-muted-foreground uppercase tracking-wider">Card conf</p>
            <p className="text-sm font-bold capitalize text-foreground">{result.cardConfidence}</p>
          </div>
        </div>
      )}

      {legs.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline flex items-center justify-center gap-1 pt-1"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Hide legs" : "View legs"}
        </button>
      )}

      {expanded && legs.length > 0 && (
        <ol className="space-y-1 text-[11px]">
          {legs.map((l, i) => (
            <li
              key={l.id}
              className="flex items-start gap-2 rounded border border-border/50 bg-background/40 px-2 py-1.5"
            >
              <span className="font-bold tabular-nums text-sky-500 shrink-0 mt-0.5">#{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground text-xs truncate">{l.selectionLabel}</p>
                <p className="text-[10px] text-muted-foreground tabular-nums">
                  {String(l.sport).toUpperCase()} · {l.gameTimeLabel ?? "time TBD"} ·{" "}
                  {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds} · hit{" "}
                  {((l.modelProbability ?? 0) * 100).toFixed(0)}%
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </motion.div>
  );
}

// ─── Parlay Card ─────────────────────────────────────────────────

function ParlayCard({ parlay }: { parlay: AutoParlay }) {
  const [expanded, setExpanded] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const modeColors: Record<ParlayBuildMode, string> = {
    safe:       "border-confidence-high/30 bg-confidence-high/5",
    balanced:   "border-amber-500/30 bg-amber-500/5",
    aggressive: "border-destructive/30 bg-destructive/5",
    cashout:    "border-sky-500/30 bg-sky-500/5",
    bigwin:     "border-violet-500/30 bg-violet-500/5",
    lotto:      "border-fuchsia-500/30 bg-fuchsia-500/5",
  };

  const sportTags = parlay.sportMix.split(",");

  return (
    <motion.div
      layout
      className={cn("rounded-lg border p-4 space-y-3 transition-colors", modeColors[parlay.mode])}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-xs font-bold tracking-wider", riskColor(parlay.mode))}>
              {parlayModeLabel(parlay.mode).toUpperCase()}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold">
              {parlay.legCount}-LEG
            </span>
            <span className={cn("text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold", confidenceColor(parlay.confidence))}>
              {parlay.confidence.toUpperCase()} CONF
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {parlayModeDescription(parlay.mode)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-bold text-foreground">{formatAmerican(parlay.combinedAmericanOdds)}</div>
          <div className="text-[10px] text-muted-foreground">{parlay.payoutMultiplier.toFixed(1)}x payout</div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Hit prob</div>
          <div className="text-xs font-bold text-foreground">{pct(parlay.combinedProbability)}</div>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Avg edge</div>
          <div className="text-xs font-bold text-confidence-high">{formatEdge(parlay.combinedEdge)}</div>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Strength</div>
          <div className="text-xs font-bold text-primary">{Math.round(parlay.strengthScore * 100)}</div>
        </div>
      </div>

      {/* Sport mix */}
      <div className="flex flex-wrap gap-1">
        {sportTags.map((s) => (
          <span key={s} className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-muted", tierColor(s))}>
            {sportBadge(s)} · {tierLabel(s)}
          </span>
        ))}
      </div>

      {/* Warnings */}
      {parlay.warnings.length > 0 && (
        <div className="space-y-1">
          {parlay.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-600 dark:text-amber-500">
              <AlertTriangle className="w-2.5 h-2.5 shrink-0 mt-0.5" />
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Toggles */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 flex items-center justify-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors py-1.5 rounded border border-border bg-muted/30 hover:bg-muted/60"
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? "Hide legs" : "View legs"}
        </button>
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          className="flex-1 flex items-center justify-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors py-1.5 rounded border border-border bg-muted/30 hover:bg-muted/60"
        >
          <Brain className="w-3 h-3" />
          {showWhy ? "Hide why" : "Why this parlay"}
        </button>
      </div>

      {/* Legs */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="space-y-2 overflow-hidden"
          >
            {parlay.legs.map((leg, i) => (
              <LegRow key={leg.id} leg={leg} index={i} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Why */}
      <AnimatePresence>
        {showWhy && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="rounded bg-muted/40 p-3 space-y-1.5">
              {parlay.explanation.map((e, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <span className="text-confidence-high font-bold shrink-0">·</span>
                  {e}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Leg row ──────────────────────────────────────────────────────

function LegRow({ leg, index }: { leg: ValueBetCandidate; index: number }) {
  return (
    <div className="flex items-start gap-2 rounded bg-muted/30 px-3 py-2">
      <span className="text-[10px] font-bold text-muted-foreground w-4 shrink-0 mt-0.5">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {sportBadge(leg.sport)}
          </span>
          <span className="text-[9px] text-muted-foreground">{leg.marketType}</span>
        </div>
        <div className="text-xs font-semibold text-foreground mt-0.5 truncate">{leg.selectionLabel}</div>
        <div className="text-[10px] text-muted-foreground">{leg.matchupLabel}</div>
        <TimingBadge sport={leg.sport} marketType={leg.marketType} />
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs font-bold text-foreground">{formatAmerican(leg.americanOdds)}</div>
        <div className="text-[10px] text-confidence-high">{formatEdge(leg.edge)}</div>
        <div className={cn("text-[9px] font-semibold", confidenceColor(leg.confidence))}>
          {leg.confidence.toUpperCase()}
        </div>
      </div>
    </div>
  );
}

// ─── Candidate card ───────────────────────────────────────────────

function CandidateCard({ c, rank }: { c: ValueBetCandidate; rank: number }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border bg-card/80 p-3 hover:border-primary/25 transition-colors">
      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10 text-primary text-[11px] font-bold shrink-0">
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {sportBadge(c.sport)}
          </span>
          <span className={cn("text-[9px] font-semibold", tierColor(c.sport))}>
            {tierLabel(c.sport)}
          </span>
          <span className="text-[9px] text-muted-foreground">{c.marketType}</span>
        </div>
        <div className="text-xs font-semibold text-foreground truncate">{c.selectionLabel}</div>
        <div className="text-[10px] text-muted-foreground">{c.matchupLabel}</div>
        <TimingBadge sport={c.sport} marketType={c.marketType} />
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-xs font-bold">{formatAmerican(c.americanOdds)}</div>
        <div className="text-[10px] font-semibold text-confidence-high">{formatEdge(c.edge)}</div>
        <div className="flex items-center justify-end gap-1">
          <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full bg-muted font-bold", confidenceColor(c.confidence))}>
            {c.confidence.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Performance placeholder ──────────────────────────────────────

function PerformanceSection() {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5 text-center space-y-2">
      <TrendingUp className="w-6 h-6 text-primary mx-auto opacity-40" />
      <p className="text-sm font-semibold text-foreground">Performance tracking active</p>
      <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
        Hit rates, ROI by tier, and sport-mix performance will appear here as parlays settle.
        Data accumulates in{" "}
        <code className="text-[10px] bg-muted px-1 py-0.5 rounded">auto_parlay_results</code>{" "}
        and rolls up into{" "}
        <code className="text-[10px] bg-muted px-1 py-0.5 rounded">parlay_edge_daily_summary</code>.
      </p>
      <div className="grid grid-cols-3 gap-3 mt-4">
        {(["Safe 3-leg", "Balanced 4-leg", "Aggressive 6-leg"] as const).map((label) => (
          <div key={label} className="rounded-lg bg-muted/40 p-3">
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className="text-sm font-bold text-muted-foreground/50 mt-1">—</div>
            <div className="text-[9px] text-muted-foreground/40">No data yet</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main section ─────────────────────────────────────────────────

interface ParlayEdgeSectionProps {
  allGames: GamePrediction[];
  oddsMap: Map<string, GameOddsBundle>;
  /** The sport tab the user is currently browsing — used as default for biased/sport-only modes. */
  currentLeague?: League;
}

export function ParlayEdgeSection({ allGames, oddsMap, currentLeague = "nba" }: ParlayEdgeSectionProps) {
  const [filterMode, setFilterMode]   = useState<SportFilterMode>("global");
  const [biasSport,  setBiasSport]    = useState<League>(currentLeague);
  const [showWarnings,     setShowWarnings]     = useState(false);
  const [showInsightsAll,  setShowInsightsAll]  = useState(false);

  const { data: propData } = useQuery({
    queryKey: ["player-edge-v2"],
    queryFn: () => fetchPlayerEdgePredictions("all", "all"),
    staleTime: 3 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const candidates = useMemo(() => {
    const gameCandidates = buildAllValueCandidates(allGames, oddsMap);
    const enrichedPropCandidates = buildEnrichedPropCandidates(propData?.items ?? []);
    const seenCorrGroups = new Set(gameCandidates.map((c) => c.correlationGroupId));
    const uniqueEnriched = enrichedPropCandidates.filter(
      (c) => !seenCorrGroups.has(c.correlationGroupId)
    );
    return [...gameCandidates, ...uniqueEnriched].sort((a, b) => b.valueScore - a.valueScore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allGames.map((g) => g.id).join(","), oddsMap.size, propData]);

  const output: ParlayEdgeOutput = useMemo(
    () => generateParlayEdge(candidates, filterMode, filterMode !== "global" ? biasSport : undefined),
    [candidates, filterMode, biasSport]
  );

  // Cash-Out parlays — uses the newer ML-aware optimizer with 3-stage sport-
  // diversity fallback, implied-prob floor, recent-game enrichment, etc.
  // Returns bestValue / safer / higherPayout variants under the cashout tier.
  const cashoutTriple = useMemo(
    () => candidates.length ? optimizeSmartParlays(candidates, "cashout") : null,
    [candidates]
  );
  const cashoutHasLegs = cashoutTriple
    ? (cashoutTriple.bestValue.legs.length +
       cashoutTriple.safer.legs.length +
       cashoutTriple.higherPayout.legs.length) > 0
    : false;

  const insights  = useMemo(() => getLearningInsights(), []);
  const topPool   = output.candidatePool.slice(0, 6);
  const hasAnyParlay = output.safe || output.balanced || output.aggressive;

  const parlayDebugLegs = [
    output.safe       && { parlay: output.safe,       label: "Safe 3-leg" },
    output.balanced   && { parlay: output.balanced,   label: "Balanced 4-leg" },
    output.aggressive && { parlay: output.aggressive, label: "Aggressive 6-leg" },
  ].filter(Boolean) as { parlay: AutoParlay; label: string }[];

  // Count how many sports have qualifying candidates (for header display)
  const activeSportCount = output.debug.sportCoverage.filter((s) => s.qualifyingCandidates > 0).length;

  return (
    <div className="space-y-8">

      {/* ── Mode selector ── */}
      <div className="space-y-3">
        <ModeSelector
          filterMode={filterMode}
          setFilterMode={setFilterMode}
          biasSport={biasSport}
          setBiasSport={setBiasSport}
        />
        {/* Mini sport coverage summary */}
        <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">
            {activeSportCount} of 5 sports active
          </span>
          {output.debug.sportCoverage.map((s) => (
            <span key={s.sport} className={cn("flex items-center gap-1", s.qualifyingCandidates === 0 ? "opacity-35" : "")}>
              <span className={cn("w-1.5 h-1.5 rounded-full", s.qualifyingCandidates > 0 ? "bg-confidence-high" : "bg-muted-foreground")} />
              {sportBadge(s.sport)} {s.qualifyingCandidates > 0 ? `(${s.qualifyingCandidates})` : "—"}
            </span>
          ))}
        </div>
      </div>

      {/* ── Debug panel ── */}
      <DebugPanel debug={output.debug} parlayLegs={parlayDebugLegs} />

      {/* ── Section 1: Best Parlays Today ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-base text-foreground">Best Parlays Today</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            AUTO-GENERATED
          </span>
          {filterMode === "global" && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-semibold">
              ALL SPORTS
            </span>
          )}
        </div>

        {!hasAnyParlay ? (
          <div className="rounded-lg border border-border bg-card/40 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No qualifying legs found today — needs positive-edge, medium/high-confidence candidates
              across at least 2 sports.{" "}
              {filterMode === "sport_only" && (
                <span className="text-amber-500">
                  You&apos;re in sport-only mode — switch to Global for more candidates.
                </span>
              )}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {output.safe       && <ParlayCard parlay={output.safe} />}
            {output.balanced   && <ParlayCard parlay={output.balanced} />}
            {output.aggressive && <ParlayCard parlay={output.aggressive} />}
          </div>
        )}
      </section>

      {/* ── Section 1b: Cash-Out Parlays Today ── */}
      {cashoutTriple && cashoutHasLegs && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Hourglass className="w-4 h-4 text-sky-500" />
            <h3 className="font-display font-bold text-base text-foreground">Cash-Out Parlays Today</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 font-semibold">
              STAGGERED
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CashoutCard variant="Best"   label="Best cash-out"   result={cashoutTriple.bestValue} />
            <CashoutCard variant="Safer"  label="Safer cash-out"  result={cashoutTriple.safer} />
            <CashoutCard variant="Upside" label="Upside cash-out" result={cashoutTriple.higherPayout} />
          </div>
        </section>
      )}

      {/* ── Section 2: Top Ranked Legs ── */}
      {topPool.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h3 className="font-display font-bold text-base text-foreground">Top Ranked Legs</h3>
            <span className="text-[10px] text-muted-foreground">Candidate pool used by the engine</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {topPool.map((c, i) => (
              <CandidateCard key={c.id} c={c} rank={i + 1} />
            ))}
          </div>
        </section>
      )}

      {/* ── Section 3: Combo Warnings ── */}
      <section>
        <button
          type="button"
          onClick={() => setShowWarnings((v) => !v)}
          className="flex items-center gap-2 w-full text-left group mb-1"
        >
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <h3 className="font-display font-bold text-base text-foreground group-hover:text-primary transition-colors">
            Combo Warnings
          </h3>
          <span className="text-[10px] text-muted-foreground ml-1">Patterns the engine actively avoids</span>
          {showWarnings
            ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-auto" />}
        </button>
        <AnimatePresence>
          {showWarnings && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3">
                {COMBO_WARNINGS.map((w) => (
                  <div
                    key={w.type}
                    className={cn(
                      "rounded-lg border p-3 space-y-1",
                      w.severity === "high"
                        ? "border-destructive/20 bg-destructive/5"
                        : w.severity === "medium"
                          ? "border-amber-500/20 bg-amber-500/5"
                          : "border-border bg-muted/20"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle
                        className={cn(
                          "w-3 h-3 shrink-0",
                          w.severity === "high" ? "text-destructive" : w.severity === "medium" ? "text-amber-500" : "text-muted-foreground"
                        )}
                      />
                      <span className="text-xs font-semibold text-foreground">{w.title}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{w.description}</p>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* ── Section 4: Learning Insights ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Brain className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-base text-foreground">Learning Insights</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">PHASE 1</span>
        </div>

        {/* Timing weights reference */}
        <div className="rounded-lg border border-border bg-card/60 p-3 mb-4 space-y-2">
          <p className="text-[10px] font-bold tracking-wider text-muted-foreground uppercase">
            Timing weights — pregame vs live signal strength
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            {(["nba","nfl","mlb","mma","boxing"] as League[]).map((sport) => {
              const cfg = TIMING_CONFIGS[sport];
              return (
                <div key={sport} className="rounded bg-muted/40 px-2 py-1.5 text-center">
                  <div className="text-[9px] font-bold text-muted-foreground uppercase mb-1">
                    {sport === "mma" ? "UFC" : sport.toUpperCase()}
                  </div>
                  <div className="text-[10px] font-semibold text-foreground">
                    {cfg.pregameWeight}x pregame
                  </div>
                  <div className="text-[9px] text-amber-500 font-semibold">
                    {cfg.liveWeight}x {cfg.liveCheckpoint}
                  </div>
                  <div className="text-[9px] text-confidence-high mt-0.5">
                    ↑{Math.round(cfg.liveUplift * 100)}% uplift
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            MLB gets the highest live uplift (+12% after 5th) because bullpen exposure, starter performance, and live totals shift dramatically mid-game.
            NBA/NFL confirm rotations after Q1 (+20%/+16%). Combat sports improve post-round-1 when fight style is readable.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(showInsightsAll ? insights : insights.slice(0, 4)).map((ins) => (
            <div key={ins.label} className="rounded-lg border border-border bg-card/80 p-3 space-y-1">
              <div className="text-[9px] font-bold tracking-wider text-muted-foreground uppercase">{ins.category}</div>
              <div className="text-xs font-semibold text-foreground">{ins.label}</div>
              <div className="text-xs text-primary font-bold">{ins.value}</div>
              <div className="text-[10px] text-muted-foreground leading-relaxed">{ins.note}</div>
            </div>
          ))}
        </div>
        {insights.length > 4 && (
          <button
            type="button"
            onClick={() => setShowInsightsAll((v) => !v)}
            className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            {showInsightsAll
              ? <><ChevronUp className="w-3 h-3" /> Show less</>
              : <><ChevronDown className="w-3 h-3" /> Show all {insights.length} insights</>}
          </button>
        )}
      </section>

      {/* ── Section 5: Performance ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-base text-foreground">Performance</h3>
        </div>
        <PerformanceSection />
      </section>
    </div>
  );
}
