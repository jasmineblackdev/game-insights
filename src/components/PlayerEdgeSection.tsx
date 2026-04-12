import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Star, Clock, Copy, ChevronDown, ChevronUp, TrendingUp, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchPlayerEdgePredictions,
  isPlayerEdgeLiveConfigured,
} from "@/lib/playerEdgeApi";
import { usePlayerEdgeFavorites } from "@/hooks/usePlayerEdgeFavorites";
import { logPick, fetchAccuracyStats } from "@/lib/picksLog";
import {
  type PlayerEdgePrediction,
  type PlayerEdgeSportFilter,
  type PlayerEdgeStatFilter,
  type PlayerRiskTier,
  computePlayerEdgeScore,
  filterPlayerEdgePredictions,
  sortPlayerEdgePredictions,
  statFilterLabel,
} from "@/data/playerEdgeMock";

// ── Sport / Stat filters (Soccer removed, Boxing + MMA added) ─────────────────

const SPORT_FILTERS: PlayerEdgeSportFilter[] = ["all", "NBA", "NFL", "MLB", "Boxing", "MMA"];

const STAT_FILTERS: PlayerEdgeStatFilter[] = [
  "all",
  "points", "rebounds", "assists",
  "passing_yards", "rushing_yards", "receiving_yards",
  "strikeouts", "hits", "total_bases",
  "fight_winner", "ko_tko", "submission", "decision", "draw", "total_rounds",
];

// ── Confidence / risk colour helpers ─────────────────────────────────────────

function confColor(p: PlayerEdgePrediction): string {
  if (p.confidence === "HIGH" && p.consistency_label === "stable")
    return "border-l-emerald-500/70 bg-emerald-500/5";          // green
  if (p.confidence === "HIGH")
    return "border-l-emerald-500/50 bg-emerald-500/5";
  if (p.risk_tier === "high_upside" || p.risk_tier === "longshot")
    return "border-l-amber-500/60 bg-amber-500/5";              // orange
  if (p.confidence === "LOW" || p.consistency_label === "volatile")
    return "border-l-red-500/50 bg-red-500/5";                  // red
  return "border-l-primary/30 bg-primary/5";                    // blue (balanced)
}

function confBadgeClass(p: PlayerEdgePrediction): string {
  if (p.confidence === "HIGH") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (p.confidence === "MED") return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

function riskBadgeClass(t: PlayerRiskTier): string {
  const m: Record<PlayerRiskTier, string> = {
    safe: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    balanced: "bg-primary/10 text-primary",
    high_upside: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    longshot: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  };
  return m[t];
}

function riskLabel(t: PlayerRiskTier): string {
  return { safe: "Safe", balanced: "Balanced", high_upside: "High upside", longshot: "Longshot" }[t];
}

// ── Bet label (DK-style headline for the card) ────────────────────────────────

function betHeadline(p: PlayerEdgePrediction): string {
  const stat = statFilterLabel(p.stat_type as PlayerEdgeStatFilter) || p.stat_type.replace(/_/g, " ");
  if (p.stat_type === "fight_winner")  return "To Win";
  if (p.stat_type === "ko_tko")        return "Win by KO/TKO";
  if (p.stat_type === "submission")    return "Win by Submission";
  if (p.stat_type === "decision")      return "Win by Decision";
  if (p.stat_type === "draw")          return "Fight Ends in Draw";
  if (p.stat_type === "goes_distance") return "Goes Distance";
  if (p.stat_type === "total_rounds")
    return `${p.prediction_direction === "MORE" ? "Over" : "Under"} ${p.line_value} Rounds`;
  return `${p.prediction_direction === "MORE" ? "Over" : "Under"} ${p.line_value} ${stat}`;
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function isCombat(sport: string): boolean {
  return sport === "Boxing" || sport === "MMA";
}

// ── Timing badge ─────────────────────────────────────────────────────────────

function TimingBadge({
  note,
  urgency,
}: {
  note: string;
  urgency?: "now" | "wait" | "monitor";
}) {
  const isNow  = urgency === "now";
  const isWait = urgency === "wait";
  const colorClass = isNow
    ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/12"
    : isWait
    ? "text-muted-foreground bg-muted/70"
    : "text-amber-700 dark:text-amber-400 bg-amber-500/10";

  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full",
      colorClass
    )}>
      <Clock className="w-2.5 h-2.5" />
      {note}
    </span>
  );
}

// ── Individual card ───────────────────────────────────────────────────────────

function PlayerEdgeCard({
  pred,
  rank,
  favorited,
  onToggleFavorite,
  favoritesUi,
}: {
  pred: PlayerEdgePrediction;
  rank?: number;
  favorited: boolean;
  onToggleFavorite: () => void;
  favoritesUi: boolean;
}) {
  const score = computePlayerEdgeScore(pred);
  const headline = betHeadline(pred);
  const isCombatSport = isCombat(pred.sport);
  const dirClass = pred.prediction_direction === "MORE"
    ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
    : "bg-red-500/15 text-red-600 dark:text-red-400";

  // Copy pick text to clipboard and log it
  const copyPick = () => {
    const text = `${pred.player_name} — ${headline} · ${pred.sport} · Edge ${pred.prediction_direction === "MORE" ? "+" : "−"}${Math.abs(pred.edge).toFixed(1)} · Conf ${pred.confidence}`;
    navigator.clipboard?.writeText(text).then(
      () => {
        toast.success("Pick copied & logged");
        void logPick(pred);
      },
      () => toast.message("Copy failed")
    );
  };

  return (
    <div
      className={cn(
        "card-shine rounded-lg border border-border border-l-4 p-4 flex flex-col gap-3 h-full",
        confColor(pred)
      )}
    >
      {/* ── Header row: player identity ────────────────── */}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <div className="w-11 h-11 rounded-full bg-primary/10 border border-border flex items-center justify-center text-xs font-bold text-primary">
            {initials(pred.player_name)}
          </div>
          {rank != null && rank <= 10 && (
            <span className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-primary text-[9px] font-black text-primary-foreground flex items-center justify-center shadow">
              {rank}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 relative pr-8">
          {favoritesUi && (
            <button
              type="button"
              onClick={onToggleFavorite}
              className={cn(
                "absolute right-0 top-0 p-1 rounded-md border border-transparent transition-colors",
                favorited
                  ? "text-amber-500 hover:bg-amber-500/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/80"
              )}
              aria-label={favorited ? "Remove favorite" : "Add favorite"}
            >
              <Star className={cn("w-4 h-4", favorited && "fill-current")} />
            </button>
          )}
          {/* Sport badge only — confidence moves below headline */}
          <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {pred.sport}
          </span>
          <p className="font-display font-bold text-sm text-foreground mt-1 truncate">{pred.player_name}</p>
          <p className="text-xs text-muted-foreground">
            {isCombatSport ? `vs ${pred.opponent}` : `${pred.team} vs ${pred.opponent}`}
            {pred.game_time ? ` · ${pred.game_time}` : ""}
          </p>
        </div>
      </div>

      {/* ── BIG: Bet recommendation ───────────────────────── */}
      <div className="bg-muted/40 rounded-md px-3 py-3 text-center">
        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-1">
          {isCombatSport ? "Fight Prop" : "Bet Recommendation"}
        </p>
        <p className="font-display font-bold text-xl text-foreground leading-tight">{headline}</p>
      </div>

      {/* ── MEDIUM: Confidence + risk tier ───────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Confidence</span>
          <span className={cn("text-sm font-bold px-2.5 py-0.5 rounded-full", confBadgeClass(pred))}>
            {pred.confidence === "HIGH" ? "High" : pred.confidence === "MED" ? "Medium" : "Low"}
          </span>
        </div>
        {pred.risk_tier && (
          <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", riskBadgeClass(pred.risk_tier))}>
            {riskLabel(pred.risk_tier)}
          </span>
        )}
        {/* ML volatility flag — only shown when ML flags variance not already visible in consistency_label */}
        {pred.volatility_flag && pred.consistency_label !== "volatile" && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-600 dark:text-orange-400">
            Volatile
          </span>
        )}
        {pred.trend_note && (
          <span className="text-[10px] text-primary font-medium">{pred.trend_note}</span>
        )}
      </div>

      {/* ── SMALL: Projection + Edge (supporting math) ───── */}
      <div className="flex items-center gap-4 text-[11px]">
        <div>
          <span className="text-muted-foreground">Projection </span>
          <span className="font-bold text-foreground tabular-nums">
            {isCombatSport && pred.stat_type === "fight_winner"
              ? `${pred.projected_value}%`
              : pred.projected_value}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Edge </span>
          <span className={cn("font-bold tabular-nums", pred.prediction_direction === "MORE" ? "text-emerald-600 dark:text-emerald-400" : "text-red-500")}>
            {pred.prediction_direction === "MORE" ? "+" : "−"}{Math.abs(pred.edge).toFixed(1)}
            {isCombatSport && pred.stat_type === "fight_winner" ? "%" : ""}
          </span>
        </div>
        {pred.consistency_label && (
          <div>
            <span className="text-muted-foreground">Form </span>
            <span className={cn(
              "font-bold capitalize",
              pred.consistency_label === "stable" && "text-emerald-600 dark:text-emerald-400",
              pred.consistency_label === "medium" && "text-amber-600 dark:text-amber-400",
              pred.consistency_label === "volatile" && "text-red-500"
            )}>
              {pred.consistency_label}
            </span>
          </div>
        )}
      </div>

      {/* ── Timing + line movement ────────────────────────── */}
      {(pred.best_time_to_bet || pred.timing_note || (pred.line_delta != null && Math.abs(pred.line_delta) >= 0.1)) && (
        <div className="flex flex-wrap items-center gap-2">
          {/* ML timing recommendation — prefer best_time_to_bet, fall back to timing_note */}
          {(pred.best_time_to_bet || pred.timing_note) && (
            <TimingBadge
              note={pred.best_time_to_bet ?? pred.timing_note!}
              urgency={pred.timing_urgency}
            />
          )}
          {pred.line_delta != null && Math.abs(pred.line_delta) >= 0.1 && (
            <span className={cn(
              "inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full",
              pred.line_delta > 0
                ? "bg-red-500/10 text-red-500"
                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            )}>
              <TrendingUp className={cn("w-2.5 h-2.5", pred.line_delta > 0 && "rotate-180")} />
              Avg {pred.line_delta > 0 ? "+" : ""}{pred.line_delta} from open
            </span>
          )}
        </div>
      )}

      {/* ── Why strong + Risk ────────────────────────────── */}
      <div className="space-y-2 text-[11px] flex-1">
        <p className="text-emerald-600 dark:text-emerald-400 font-semibold">Why strong</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
          {(pred.explanations?.length
            ? pred.explanations
            : [pred.reason_1, pred.reason_2].filter(Boolean)
          ).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
        <div className="flex gap-1.5 items-start pt-0.5">
          <span className="text-red-500/80 font-semibold shrink-0">Risk:</span>
          <span className="text-muted-foreground">{pred.risk_factor}</span>
        </div>
      </div>

      {/* ── Actions ──────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-2 pt-1 border-t border-border">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 font-semibold min-h-11 sm:min-h-9 touch-manipulation gap-1.5"
          onClick={copyPick}
        >
          <Copy className="w-3.5 h-3.5" />
          Copy Pick
        </Button>
        <Button variant="outline" size="sm" className="flex-1 min-h-11 sm:min-h-9 touch-manipulation" asChild>
          <Link to={`/player-edge/${pred.id}`}>View Details</Link>
        </Button>
      </div>
    </div>
  );
}

// ── Section header component ──────────────────────────────────────────────────

function SectionHeading({ title, count, subtitle }: { title: string; count?: number; subtitle?: string }) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <h3 className="font-display font-bold text-base text-foreground">{title}</h3>
      {count != null && (
        <span className="text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full tabular-nums">
          {count}
        </span>
      )}
      {subtitle && <span className="text-xs text-muted-foreground hidden sm:inline">{subtitle}</span>}
    </div>
  );
}

// ── Sport section (best N props per sport) ────────────────────────────────────

function SportSection({
  label, sport, all, favs, rankOffset,
}: {
  label: string;
  sport: PlayerEdgeSportFilter;
  all: PlayerEdgePrediction[];
  favs: ReturnType<typeof import("@/hooks/usePlayerEdgeFavorites").usePlayerEdgeFavorites>;
  rankOffset: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => {
    const filtered = all.filter((p) => p.sport === sport);
    return sortPlayerEdgePredictions(filtered);
  }, [all, sport]);

  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, 3);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <SectionHeading title={label} count={items.length} />
        {items.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-primary flex items-center gap-1 hover:opacity-80"
          >
            {expanded ? <><ChevronUp className="w-3 h-3" /> Less</> : <><ChevronDown className="w-3 h-3" /> +{items.length - 3} more</>}
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {visible.map((pred, i) => (
          <PlayerEdgeCard
            key={pred.id}
            pred={pred}
            rank={rankOffset + i + 1}
            favorited={favs.showFavoritesUi && favs.isFav(pred)}
            onToggleFavorite={() => favs.toggleFavorite(pred)}
            favoritesUi={favs.showFavoritesUi}
          />
        ))}
      </div>
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function PlayerEdgeSection() {
  const [sport, setSport] = useState<PlayerEdgeSportFilter>("all");
  const [stat, setStat] = useState<PlayerEdgeStatFilter>("all");
  const [showAllTop, setShowAllTop] = useState(false);
  const favs = usePlayerEdgeFavorites();

  const { data, isPending } = useQuery({
    queryKey: ["player-edge-v2"],
    queryFn: () => fetchPlayerEdgePredictions("all", "all"),
    staleTime: 3 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  const { data: accuracy } = useQuery({
    queryKey: ["picks-accuracy"],
    queryFn: fetchAccuracyStats,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const allItems = useMemo(() => sortPlayerEdgePredictions(data?.items ?? []), [data]);

  // Filtered view (when user picks a sport/stat)
  const filtered = useMemo(
    () => filterPlayerEdgePredictions(allItems, sport, stat),
    [allItems, sport, stat]
  );

  // Section groupings
  const topProps  = useMemo(() => allItems.slice(0, showAllTop ? 12 : 6), [allItems, showAllTop]);
  const highConf  = useMemo(() => allItems.filter((p) => p.confidence === "HIGH"), [allItems]);
  const highUp    = useMemo(() => allItems.filter((p) => p.risk_tier === "high_upside" || p.risk_tier === "longshot"), [allItems]);
  const volatile  = useMemo(() => allItems.filter((p) => p.consistency_label === "volatile"), [allItems]);

  const isFiltering = sport !== "all" || stat !== "all";

  return (
    <section className="mt-12 pt-10 border-t border-border space-y-8" aria-labelledby="player-edge-heading">
      {/* ── Page header ───────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <h2 id="player-edge-heading" className="font-display font-bold text-xl sm:text-2xl md:text-3xl text-foreground">
            Player Edge <span className="text-primary text-base font-semibold ml-1">AI</span>
          </h2>
          <Link
            to="/picks"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground border border-border rounded-lg px-3 py-1.5 transition-colors shrink-0"
          >
            <ClipboardList className="w-3.5 h-3.5" />
            My Picks
          </Link>
        </div>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Daily AI prop scanner — NBA, NFL, MLB, Boxing, and UFC/MMA fights ranked by model edge, confidence, and matchup advantage.
        </p>
        {isPlayerEdgeLiveConfigured() && (
          <p className="text-[10px] text-primary/70">Enhanced props: custom endpoint active.</p>
        )}
        {accuracy && accuracy.total >= 5 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-foreground">30-day accuracy:</span>
            {accuracy.winPct != null && (
              <span className={cn(
                "font-bold px-2 py-0.5 rounded-full",
                accuracy.winPct >= 60 ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" :
                accuracy.winPct >= 50 ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" :
                "bg-red-500/15 text-red-500"
              )}>
                {accuracy.winPct}% overall
              </span>
            )}
            {(["HIGH", "MED", "LOW"] as const).map((c) => {
              const tier = accuracy.byConfidence[c];
              if (!tier || tier.wins + tier.losses < 3) return null;
              const pct = Math.round(tier.wins / (tier.wins + tier.losses) * 100);
              return (
                <span key={c} className="text-muted-foreground">
                  {c}: <span className="font-semibold text-foreground">{pct}%</span> ({tier.wins}W-{tier.losses}L)
                </span>
              );
            })}
            <Link to="/picks" className="text-primary hover:underline">view all →</Link>
          </div>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{allItems.length} props scanned</span>
          <span className="text-border">·</span>
          <span>{highConf.length} high confidence</span>
          <span className="text-border">·</span>
          <span>{highUp.length} high upside</span>
        </div>
      </div>

      {/* ── Filters ────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">SPORT</p>
          <div className="flex flex-wrap gap-2 sm:gap-1.5">
            {SPORT_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSport(s)}
                className={cn(
                  "min-h-10 px-3 py-2 sm:min-h-0 sm:py-1 rounded-full text-xs font-semibold border transition-colors touch-manipulation",
                  sport === s
                    ? "bg-card text-foreground border-primary/40 shadow-sm"
                    : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground active:bg-muted"
                )}
              >
                {s === "all" ? "All Sports" : s}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-semibold tracking-wider text-muted-foreground">STAT / MARKET</p>
          <div className="flex flex-wrap gap-2 sm:gap-1.5">
            {STAT_FILTERS.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStat(st)}
                className={cn(
                  "min-h-10 px-2.5 py-2 sm:min-h-0 sm:py-1 rounded-full text-[11px] font-medium border transition-colors touch-manipulation",
                  stat === st
                    ? "bg-card text-foreground border-primary/40 shadow-sm"
                    : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground active:bg-muted"
                )}
              >
                {statFilterLabel(st)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Loading skeleton ────────────────────────────── */}
      {isPending && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-80 rounded-lg border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      )}

      {/* ── Filtered view (when user has selected sport/stat) ── */}
      {!isPending && isFiltering && (
        filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center rounded-lg border border-border bg-card/40">
            No props match these filters. Try "All Sports" or a different stat type.
          </p>
        ) : (
          <div>
            <SectionHeading
              title={`${sport === "all" ? "All Sports" : sport} · ${stat === "all" ? "All Stats" : statFilterLabel(stat)}`}
              count={filtered.length}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((pred, i) => (
                <PlayerEdgeCard
                  key={pred.id}
                  pred={pred}
                  rank={i + 1}
                  favorited={favs.showFavoritesUi && favs.isFav(pred)}
                  onToggleFavorite={() => favs.toggleFavorite(pred)}
                  favoritesUi={favs.showFavoritesUi}
                />
              ))}
            </div>
          </div>
        )
      )}

      {/* ── Full section layout (no filter active) ─────── */}
      {!isPending && !isFiltering && allItems.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center rounded-lg border border-border bg-card/40">
          Scanning today's slate… Props load from ESPN and The Odds API. Check back once today's games are posted.
        </p>
      )}

      {!isPending && !isFiltering && allItems.length > 0 && (
        <div className="space-y-10">

          {/* 1. Top AI Props Today */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <SectionHeading
                title="Top AI Props Today"
                count={allItems.length}
                subtitle="Ranked by composite edge score"
              />
              {allItems.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllTop((v) => !v)}
                  className="text-xs text-primary flex items-center gap-1 hover:opacity-80"
                >
                  {showAllTop ? <><ChevronUp className="w-3 h-3" /> Fewer</> : <><ChevronDown className="w-3 h-3" /> +{allItems.length - 6} more</>}
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {topProps.map((pred, i) => (
                <PlayerEdgeCard
                  key={pred.id}
                  pred={pred}
                  rank={i + 1}
                  favorited={favs.showFavoritesUi && favs.isFav(pred)}
                  onToggleFavorite={() => favs.toggleFavorite(pred)}
                  favoritesUi={favs.showFavoritesUi}
                />
              ))}
            </div>
          </div>

          {/* 2. Best by Sport */}
          <div className="space-y-8">
            <h3 className="font-display font-bold text-base text-foreground border-b border-border pb-2">
              Best by Sport
            </h3>
            {(["NBA", "NFL", "MLB", "Boxing", "MMA"] as const).map((s) => {
              const count = allItems.filter((p) => p.sport === s).length;
              if (count === 0) return null;
              const labels: Record<string, string> = {
                NBA: "🏀 NBA", NFL: "🏈 NFL", MLB: "⚾ MLB",
                Boxing: "🥊 Boxing", MMA: "🥋 UFC / MMA",
              };
              return (
                <SportSection
                  key={s}
                  label={labels[s]}
                  sport={s}
                  all={allItems}
                  favs={favs}
                  rankOffset={0}
                />
              );
            })}
          </div>

          {/* 3. High Confidence Props */}
          {highConf.length > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-1">
                <SectionHeading title="🟢 High Confidence Props" count={highConf.length} />
              </div>
              <p className="text-xs text-muted-foreground mb-4">High edge · stable role · low volatility</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {highConf.slice(0, 6).map((pred, i) => (
                  <PlayerEdgeCard
                    key={pred.id}
                    pred={pred}
                    rank={i + 1}
                    favorited={favs.showFavoritesUi && favs.isFav(pred)}
                    onToggleFavorite={() => favs.toggleFavorite(pred)}
                    favoritesUi={favs.showFavoritesUi}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 4. High Upside Props */}
          {highUp.length > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-1">
                <SectionHeading title="🟠 High Upside Props" count={highUp.length} />
              </div>
              <p className="text-xs text-muted-foreground mb-4">Higher payout potential · accept more variance</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {highUp.slice(0, 6).map((pred, i) => (
                  <PlayerEdgeCard
                    key={pred.id}
                    pred={pred}
                    rank={i + 1}
                    favorited={favs.showFavoritesUi && favs.isFav(pred)}
                    onToggleFavorite={() => favs.toggleFavorite(pred)}
                    favoritesUi={favs.showFavoritesUi}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 5. Props to Avoid (volatile) */}
          {volatile.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground select-none">
                <ChevronDown className="w-4 h-4 group-open:rotate-180 transition-transform" />
                🔴 Props to Avoid ({volatile.length} volatile)
              </summary>
              <p className="text-xs text-muted-foreground mt-2 mb-4">High variance — game script changes or role instability could sink these</p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-3">
                {volatile.slice(0, 3).map((pred, i) => (
                  <PlayerEdgeCard
                    key={pred.id}
                    pred={pred}
                    favorited={favs.showFavoritesUi && favs.isFav(pred)}
                    onToggleFavorite={() => favs.toggleFavorite(pred)}
                    favoritesUi={favs.showFavoritesUi}
                  />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
