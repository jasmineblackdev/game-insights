import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { GamePrediction } from "@/data/mockGames";
import { cn } from "@/lib/utils";
import { buildAllValueCandidates } from "@/lib/valueParlay/buildCandidates";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import type { ParlayBuildMode, ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  type AutoParlay,
  type ParlayEdgeOutput,
  COMBO_WARNINGS,
  generateParlayEdge,
  getLearningInsights,
  parlayModeDescription,
  parlayModeLabel,
  SPORT_TIERS,
} from "@/lib/parlayEdge";
import type { League } from "@/data/mockGames";

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

// ─── Parlay Card ─────────────────────────────────────────────────

function ParlayCard({ parlay }: { parlay: AutoParlay }) {
  const [expanded, setExpanded] = useState(false);
  const [showWhy, setShowWhy] = useState(false);

  const modeColors: Record<ParlayBuildMode, string> = {
    safe: "border-confidence-high/30 bg-confidence-high/5",
    balanced: "border-amber-500/30 bg-amber-500/5",
    aggressive: "border-destructive/30 bg-destructive/5",
  };

  return (
    <motion.div
      layout
      className={cn(
        "rounded-lg border p-4 space-y-3 transition-colors",
        modeColors[parlay.mode]
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("text-xs font-bold tracking-wider", riskColor(parlay.mode))}>
              {parlayModeLabel(parlay.mode).toUpperCase()}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-semibold">
              {parlay.legCount}-LEG
            </span>
            <span
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full bg-muted font-semibold",
                confidenceColor(parlay.confidence)
              )}
            >
              {parlay.confidence.toUpperCase()} CONF
            </span>
          </div>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {parlayModeDescription(parlay.mode)}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-bold text-foreground">
            {formatAmerican(parlay.combinedAmericanOdds)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {parlay.payoutMultiplier.toFixed(1)}x payout
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Hit prob</div>
          <div className="text-xs font-bold text-foreground">
            {pct(parlay.combinedProbability)}
          </div>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Avg edge</div>
          <div className="text-xs font-bold text-confidence-high">
            {formatEdge(parlay.combinedEdge)}
          </div>
        </div>
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground">Strength</div>
          <div className="text-xs font-bold text-primary">
            {Math.round(parlay.strengthScore * 100)}
          </div>
        </div>
      </div>

      {/* Sport mix tags */}
      <div className="flex flex-wrap gap-1">
        {parlay.sportMix.split(",").map((s) => (
          <span
            key={s}
            className={cn(
              "text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-muted",
              tierColor(s)
            )}
          >
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

      {/* Toggle buttons */}
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

      {/* Leg list */}
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

      {/* Why this parlay */}
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
      <span className="text-[10px] font-bold text-muted-foreground w-4 shrink-0 mt-0.5">
        {index + 1}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {sportBadge(leg.sport)}
          </span>
          <span className="text-[9px] text-muted-foreground">{leg.marketType}</span>
        </div>
        <div className="text-xs font-semibold text-foreground mt-0.5 truncate">
          {leg.selectionLabel}
        </div>
        <div className="text-[10px] text-muted-foreground">{leg.matchupLabel}</div>
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

// ─── Candidate leg card ───────────────────────────────────────────

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
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        <div className="text-xs font-bold">{formatAmerican(c.americanOdds)}</div>
        <div className="text-[10px] font-semibold text-confidence-high">{formatEdge(c.edge)}</div>
        <div className="flex items-center justify-end gap-1">
          <span
            className={cn(
              "text-[9px] px-1.5 py-0.5 rounded-full bg-muted font-bold",
              confidenceColor(c.confidence)
            )}
          >
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
        Data accumulates in <code className="text-[10px] bg-muted px-1 py-0.5 rounded">auto_parlay_results</code>{" "}
        and rolls up into <code className="text-[10px] bg-muted px-1 py-0.5 rounded">parlay_edge_daily_summary</code>.
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
}

export function ParlayEdgeSection({ allGames, oddsMap }: ParlayEdgeSectionProps) {
  const [showWarnings, setShowWarnings] = useState(false);
  const [showInsightsAll, setShowInsightsAll] = useState(false);

  const candidates = useMemo(
    () => buildAllValueCandidates(allGames, oddsMap),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allGames.map((g) => g.id).join(","), oddsMap.size]
  );

  const output: ParlayEdgeOutput = useMemo(
    () => generateParlayEdge(candidates),
    [candidates]
  );

  const insights = useMemo(() => getLearningInsights(), []);
  const topPool  = output.candidatePool.slice(0, 6);

  const hasAnyParlay = output.safe || output.balanced || output.aggressive;

  return (
    <div className="space-y-8">
      {/* ── Section 1: Best Parlays Today ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-4 h-4 text-primary" />
          <h3 className="font-display font-bold text-base text-foreground">Best Parlays Today</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            AUTO-GENERATED
          </span>
        </div>

        {!hasAnyParlay ? (
          <div className="rounded-lg border border-border bg-card/40 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No qualifying legs found today — needs positive-edge, medium/high-confidence candidates
              across at least 2 sports.
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
          <span className="text-[10px] text-muted-foreground ml-1">
            Patterns the engine actively avoids
          </span>
          {showWarnings
            ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
          }
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
                          w.severity === "high"
                            ? "text-destructive"
                            : w.severity === "medium"
                              ? "text-amber-500"
                              : "text-muted-foreground"
                        )}
                      />
                      <span className="text-xs font-semibold text-foreground">{w.title}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {w.description}
                    </p>
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
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            PHASE 1
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(showInsightsAll ? insights : insights.slice(0, 4)).map((ins) => (
            <div
              key={ins.label}
              className="rounded-lg border border-border bg-card/80 p-3 space-y-1"
            >
              <div className="text-[9px] font-bold tracking-wider text-muted-foreground uppercase">
                {ins.category}
              </div>
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
              : <><ChevronDown className="w-3 h-3" /> Show all {insights.length} insights</>
            }
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
