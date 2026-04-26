import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEdgeCardOptional } from "@/context/EdgeCardContext";
import type { DraftEdgeCard, DraftEdgeFilterId } from "@/data/draftEdgeTypes";
import type { League } from "@/data/mockGames";
import {
  fetchDraftEdgeCards,
  type DraftEdgeDataSource,
  type DraftEdgeMockReason,
} from "@/lib/draftEdgeApi";
import {
  fetchNflDraftOddsBoard,
  formatAmericanOdds,
  hasTheOddsApiKey,
  type DraftOddsSection,
} from "@/lib/draftOddsApi";
import { TrendingUp, Users, Target, Zap, LineChart } from "lucide-react";

const DRAFT_EDGE_YEAR: Record<League, number> = {
  nfl: 2026,
  nba: 2026,
  wnba: 2026,
  mlb: 2026,
  boxing: 2026,
  mma: 2026,
};

function round1PickCap(league: League): number {
  if (league === "nfl") return 32;
  if (league === "nba" || league === "mlb") return 30;
  return 20;
}

const FILTER_CHIPS: { id: DraftEdgeFilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "top10", label: "Picks 1–10" },
  { id: "round1", label: "Round 1" },
  { id: "position_props", label: "Position props" },
  { id: "team_needs", label: "Team needs" },
  { id: "high_confidence", label: "High confidence" },
  { id: "big_movers", label: "Big movers" },
];

const gradeClass = (g: string) => {
  if (g.startsWith("A")) return "text-confidence-high bg-confidence-high/15";
  if (g.startsWith("B")) return "text-primary bg-primary/15";
  return "text-muted-foreground bg-muted";
};

const confClass = (c: DraftEdgeCard["confidence"]) =>
  c === "HIGH"
    ? "text-confidence-high bg-confidence-high/15"
    : c === "MED"
      ? "text-amber-600 dark:text-amber-400 bg-amber-500/15"
      : "text-muted-foreground bg-muted";

function kindLabel(k: DraftEdgeCard["kind"]): string {
  switch (k) {
    case "exact_pick":
      return "Exact pick";
    case "position_ou":
      return "Draft position O/U";
    case "round_yes_no":
      return "Round 1 · Yes/No";
    case "team_position":
      return "Team · position";
    case "position_first":
      return "First at position";
    default:
      return "Draft";
  }
}

function passesFilter(card: DraftEdgeCard, f: DraftEdgeFilterId, league: League): boolean {
  if (f === "all") return true;
  if (f === "high_confidence") return card.confidence === "HIGH";
  if (f === "big_movers") return card.tags.includes("mover") || Boolean(card.mover_note);
  if (f === "team_needs") return card.tags.includes("team_needs");
  if (f === "top10") {
    if (card.tags.includes("top10")) return true;
    if (card.kind === "exact_pick" && card.pick_number != null && card.pick_number <= 10) return true;
    return false;
  }
  if (f === "round1") {
    if (card.tags.includes("round1")) return true;
    const cap = round1PickCap(league);
    if (card.kind === "exact_pick" && card.pick_number != null && card.pick_number <= cap) return true;
    return false;
  }
  if (f === "position_props") {
    return (
      card.kind === "position_ou" ||
      card.kind === "round_yes_no" ||
      card.kind === "team_position" ||
      card.kind === "position_first"
    );
  }
  return true;
}

function DraftEdgeCardView({ card, league }: { card: DraftEdgeCard; league: League }) {
  const edge = useEdgeCardOptional();
  const added = edge?.slip.some((x) => x.kind === "draft_edge" && x.id === card.id) ?? false;
  const full = edge?.slipFull && !added;

  return (
    <div className="card-shine bg-card rounded-lg border border-border p-4 flex flex-col gap-3 h-full">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {kindLabel(card.kind)}
        </span>
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", confClass(card.confidence))}>
          {card.confidence}
        </span>
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", gradeClass(card.grade))}>
          {card.grade}
        </span>
        {card.tier ? (
          <span className="text-[10px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">{card.tier}</span>
        ) : null}
      </div>

      <div>
        <p className="font-display font-bold text-sm text-foreground">
          {card.kind === "exact_pick" && card.pick_number != null ? (
            <span className="text-muted-foreground font-semibold mr-2">#{card.pick_number}</span>
          ) : null}
          {card.player_name}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {card.position} · {card.college}
        </p>
      </div>

      {card.kind === "exact_pick" ? (
        <div className="text-xs space-y-1 border-t border-border pt-2">
          <p>
            <span className="text-muted-foreground">Predicted team · </span>
            <span className="font-semibold text-foreground">
              {card.predicted_team ?? card.predicted_team_abbr ?? "—"}
            </span>
          </p>
          {card.probability != null ? (
            <p>
              <span className="text-muted-foreground">Probability · </span>
              <span className="font-bold tabular-nums text-foreground">{Math.round(card.probability)}%</span>
              {card.prob_low != null && card.prob_high != null ? (
                <span className="text-muted-foreground tabular-nums">
                  {" "}
                  (range {Math.round(card.prob_low)}–{Math.round(card.prob_high)}%)
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      {card.kind === "position_ou" ? (
        <div className="text-xs space-y-1 border-t border-border pt-2">
          <p>
            <span className="text-muted-foreground">
              Draft position O/U {card.ou_line ?? "—"} ·{" "}
            </span>
            <span className="font-bold text-foreground">{card.ou_prediction ?? "—"}</span>
          </p>
          {card.projected_pick != null ? (
            <p>
              <span className="text-muted-foreground">Projection · </span>
              <span className="font-semibold tabular-nums">Pick {card.projected_pick}</span>
            </p>
          ) : null}
          {card.prob_low != null && card.prob_high != null ? (
            <p className="text-muted-foreground tabular-nums">
              Range · {Math.round(card.prob_low)}–{Math.round(card.prob_high)}%
            </p>
          ) : null}
        </div>
      ) : null}

      {card.kind === "round_yes_no" ? (
        <div className="text-xs border-t border-border pt-2">
          <span className="text-muted-foreground">
            1st round ·{" "}
          </span>
          <span className="font-bold text-foreground">{card.round_prediction === "yes" ? "Yes" : "No"}</span>
          {card.probability != null ? (
            <span className="text-muted-foreground tabular-nums ml-2">· {Math.round(card.probability)}%</span>
          ) : null}
        </div>
      ) : null}

      {card.kind === "team_position" ? (
        <div className="text-xs border-t border-border pt-2">
          <span className="text-muted-foreground">
            {card.team_target_abbr ?? "?"} · Round 1 ·{" "}
          </span>
          <span className="font-bold text-foreground">{card.team_need_position ?? "—"}</span>
          {card.probability != null ? (
            <span className="text-muted-foreground tabular-nums ml-2">· {Math.round(card.probability)}%</span>
          ) : null}
        </div>
      ) : null}

      {card.kind === "position_first" ? (
        <div className="text-xs border-t border-border pt-2">
          <span className="text-muted-foreground">First {card.first_position_label ?? card.position} · </span>
          <span className="font-bold text-foreground">{card.player_name}</span>
          {card.probability != null ? (
            <span className="text-muted-foreground tabular-nums ml-2">· {Math.round(card.probability)}%</span>
          ) : null}
        </div>
      ) : null}

      {card.mover_note ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
          <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {card.mover_note}
        </p>
      ) : null}

      <div className="space-y-1.5 text-[11px] flex-1 border-t border-border pt-2">
        <p className="text-confidence-high font-semibold flex items-center gap-1">
          <Zap className="w-3 h-3" />
          Why
        </p>
        <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
          <li>{card.reason_1}</li>
          <li>{card.reason_2}</li>
        </ul>
        <p className="text-risk pt-1">
          <span className="font-semibold">Risk · </span>
          {card.risk_factor}
        </p>
      </div>

      <Button
        size="sm"
        className="w-full font-semibold touch-manipulation min-h-11 sm:min-h-9"
        disabled={!edge || added || full}
        onClick={() => {
          if (!edge) {
            toast.message("Edge Card unavailable");
            return;
          }
          const r = edge.addDraftEdge(card);
          if (r.ok) toast.success("Added Draft Edge pick to Edge Card");
          else toast.message(r.message ?? "Could not add");
        }}
      >
        {added ? "On Edge Card" : "Add to Edge Card"}
      </Button>
    </div>
  );
}

function leagueDraftTitle(league: League): string {
  switch (league) {
    case "nfl":
      return "NFL";
    case "nba":
      return "NBA";
    case "mlb":
      return "MLB";
    case "boxing":
      return "Boxing";
  }
}

function leagueDraftBlurb(league: League): string {
  switch (league) {
    case "nfl":
      return "NFL 2026: pick projections, draft-position O/U, round and team-need props, and first-at-position calls — driven by grades, fit, consensus, and positional value.";
    case "nba":
      return "NBA 2026: same card mix as NFL — lottery range, positional scarcity, and team timelines.";
    case "mlb":
      return "MLB 2026 draft: slot variance, bonus strategy, and org needs in the same Draft Edge card types.";
    case "boxing":
      return "Boxing does not have a draft. Use the Games tab for upcoming fight predictions.";
  }
}

const DRAFT_ODDS_ROWS_CAP = 14;

function DraftSportsbookOddsPanel({ league }: { league: League }) {
  const enabled = league === "nfl" && hasTheOddsApiKey();
  const { data, isPending, isError } = useQuery({
    queryKey: ["draft-odds-nfl"],
    queryFn: fetchNflDraftOddsBoard,
    staleTime: 60 * 60 * 1000,
    enabled,
  });

  if (!enabled) return null;

  if (isPending) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-4 space-y-2" aria-busy="true">
        <div className="h-3 w-40 rounded bg-muted animate-pulse" />
        <div className="h-24 rounded bg-muted/50 animate-pulse" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-700 dark:text-amber-300">
        Couldn&apos;t load sportsbook draft lines from The Odds API. Try again later.
      </div>
    );
  }

  if (data.note === "no_api_key") return null;

  if (data.note === "no_sport") {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-700 dark:text-amber-300 space-y-2">
        <p className="font-semibold text-foreground">Sportsbook board (The Odds API)</p>
        <p>
          No active NFL draft sport matched in the API catalog. If your plan includes draft outrights, set{" "}
          <span className="font-mono text-[10px]">VITE_THE_ODDS_API_NFL_DRAFT_SPORT_KEY</span> to the exact{" "}
          <span className="font-mono text-[10px]">sport_key</span> from{" "}
          <span className="font-mono text-[10px]">GET /v4/sports?all=true</span>, then redeploy.
        </p>
      </div>
    );
  }

  if (!data.sections.length) {
    const detail =
      data.note === "empty" || data.note === "no_outcomes"
        ? "The API returned no outright outcomes for this sport (markets may be offline or not on your plan)."
        : data.note?.startsWith("http_")
          ? `Request failed (${data.note.replace("http_", "")}).`
          : "Unexpected empty response.";
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-4 text-xs text-muted-foreground space-y-1">
        <p className="font-semibold text-foreground flex items-center gap-2">
          <LineChart className="w-3.5 h-3.5" />
          Sportsbook board (The Odds API)
        </p>
        <p>{detail}</p>
        {data.sportKey ? (
          <p className="font-mono text-[10px] opacity-80">
            sport_key: {data.sportKey}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary/25 bg-card/60 p-4 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-display font-bold text-foreground flex items-center gap-2">
          <LineChart className="w-4 h-4 text-primary" />
          Sportsbook board
        </p>
        <p className="text-[10px] text-muted-foreground">
          The Odds API · US · outrights · DraftKings when available
          {data.sportKey ? (
            <span className="font-mono ml-1 opacity-80">({data.sportKey})</span>
          ) : null}
        </p>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Book prices for reference only — not GameLens model output. Lines change; this panel caches for about an hour.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {data.sections.map((sec: DraftOddsSection, i: number) => {
          const shown = sec.rows.slice(0, DRAFT_ODDS_ROWS_CAP);
          const more = sec.rows.length - shown.length;
          return (
            <div key={`${sec.title}-${i}`} className="rounded-md border border-border bg-background/40 overflow-hidden">
              <div className="px-3 py-2 border-b border-border flex flex-wrap items-center justify-between gap-2 bg-muted/30">
                <span className="text-xs font-bold text-foreground">{sec.title}</span>
                <span className="text-[10px] font-semibold text-muted-foreground">{sec.book}</span>
              </div>
              <ul className="divide-y divide-border max-h-[min(22rem,50vh)] overflow-y-auto">
                {shown.map((row, j) => (
                  <li key={`${row.label}-${j}`} className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                    <span className="text-foreground font-medium leading-snug min-w-0">{row.label}</span>
                    <span className="tabular-nums font-bold text-confidence-high shrink-0">{formatAmericanOdds(row.american)}</span>
                  </li>
                ))}
              </ul>
              {more > 0 ? (
                <p className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-border">+{more} more</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DraftDataSourceNote({
  source,
  mockReason,
}: {
  source?: DraftEdgeDataSource;
  mockReason?: DraftEdgeMockReason;
}) {
  if (source === "live") {
    return (
      <p className="text-[10px] text-confidence-high max-w-2xl leading-relaxed">
        Connected to the GameLens backend — live draft picks. Refresh the page to sync the latest rows.
        {import.meta.env.DEV ? (
          <span className="block mt-1 font-mono text-[9px] text-confidence-high/80">
            draft-edge → draft_predictions
          </span>
        ) : null}
      </p>
    );
  }
  if (mockReason === "live_unavailable") {
    return (
      <p className="text-[10px] text-amber-600 dark:text-amber-400 max-w-2xl leading-relaxed">
        Can&apos;t reach the GameLens backend right now — showing sample cards. Retry soon, or confirm the draft service is
        running and has picks for this sport and year.
        {import.meta.env.DEV ? (
          <span className="block mt-1 font-mono text-[9px] opacity-90">
            draft-edge + draft_predictions (year, league)
          </span>
        ) : null}
      </p>
    );
  }
  return (
    <p className="text-[10px] text-muted-foreground max-w-2xl leading-relaxed">
      <span className="font-semibold text-foreground/80">Preview</span> — sample cards only. The live Draft Edge API URL was not
      baked into this build (missing env).
      <span className="block mt-2 text-foreground/70">
        <span className="font-semibold">Vercel / production:</span> Project → Settings → Environment Variables → add{" "}
        <span className="font-mono text-[9px]">VITE_SUPABASE_URL</span> and{" "}
        <span className="font-mono text-[9px]">VITE_SUPABASE_ANON_KEY</span> (long JWT anon key from Supabase → API, not the
        short <span className="font-mono text-[9px]">sb_publishable_</span> key). Save, then{" "}
        <span className="font-semibold">Redeploy</span> — Vite reads <span className="font-mono text-[9px]">VITE_*</span> at{" "}
        <span className="italic">build</span> time only.
      </span>
      {import.meta.env.DEV ? (
        <span className="block mt-2 font-mono text-[9px] opacity-80">
          Local: .env.local — same vars, or VITE_DRAFT_EDGE_API_URL override
        </span>
      ) : null}
    </p>
  );
}

export function DraftEdgeSection({ league }: { league: League }) {
  const [filter, setFilter] = useState<DraftEdgeFilterId>("all");
  const year = DRAFT_EDGE_YEAR[league];

  const { data, isPending } = useQuery({
    queryKey: ["draft-edge", year, league],
    queryFn: () => fetchDraftEdgeCards(year, league),
    staleTime: 5 * 60 * 1000,
  });

  const rows = useMemo(() => {
    const list = data?.items ?? [];
    return list.filter((c) => passesFilter(c, filter, league));
  }, [data, filter, league]);

  return (
    <section className="space-y-6" aria-labelledby="draft-edge-heading">
      <div className="space-y-2">
        <h2 id="draft-edge-heading" className="font-display font-bold text-xl sm:text-2xl md:text-3xl text-foreground">
          Draft Edge · {leagueDraftTitle(league)}
        </h2>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">{leagueDraftBlurb(league)}</p>
        {!isPending ? <DraftDataSourceNote source={data?.source} mockReason={data?.mockReason} /> : null}
      </div>

      <DraftSportsbookOddsPanel league={league} />

      <div className="space-y-2">
        <p className="text-[10px] font-semibold tracking-wider text-muted-foreground flex items-center gap-2">
          <Target className="w-3.5 h-3.5" />
          FILTERS
        </p>
        <div className="flex flex-wrap gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={cn(
                "min-h-10 px-3 py-2 sm:min-h-0 sm:py-1 rounded-full text-xs font-semibold border transition-colors touch-manipulation shrink-0",
                filter === chip.id
                  ? "bg-card text-foreground border-primary/40 shadow-sm"
                  : "border-transparent bg-muted/60 text-muted-foreground hover:text-foreground active:bg-muted"
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="w-3.5 h-3.5" />
        <span>
          Showing {rows.length} card{rows.length === 1 ? "" : "s"}
          {filter !== "all" ? ` · filter: ${FILTER_CHIPS.find((c) => c.id === filter)?.label}` : ""}
        </span>
      </div>

      {isPending ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-80 rounded-lg border border-border bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-10 text-center rounded-lg border border-border bg-card/40">
          No Draft Edge cards match this filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((card) => (
            <DraftEdgeCardView key={card.id} card={card} league={league} />
          ))}
        </div>
      )}
    </section>
  );
}
