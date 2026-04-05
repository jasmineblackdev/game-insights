import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEdgeCardOptional } from "@/context/EdgeCardContext";
import type { DraftEdgeCard, DraftEdgeFilterId } from "@/data/draftEdgeTypes";
import { fetchDraftEdgeCards } from "@/lib/draftEdgeApi";
import { TrendingUp, Users, Target, Zap } from "lucide-react";

const NFL_DRAFT_YEAR = 2026;

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

function passesFilter(card: DraftEdgeCard, f: DraftEdgeFilterId): boolean {
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
    if (card.kind === "exact_pick" && card.pick_number != null && card.pick_number <= 32) return true;
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

function DraftEdgeCardView({ card }: { card: DraftEdgeCard }) {
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
            <span className="text-muted-foreground">Draft position O/U {card.ou_line ?? "—"} · </span>
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
          <span className="text-muted-foreground">1st round · </span>
          <span className="font-bold text-foreground">{card.round_prediction === "yes" ? "Yes" : "No"}</span>
          {card.probability != null ? (
            <span className="text-muted-foreground tabular-nums ml-2">· {Math.round(card.probability)}%</span>
          ) : null}
        </div>
      ) : null}

      {card.kind === "team_position" ? (
        <div className="text-xs border-t border-border pt-2">
          <span className="text-muted-foreground">{card.team_target_abbr ?? "?"} · Round 1 · </span>
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

export function DraftEdgeSection() {
  const [filter, setFilter] = useState<DraftEdgeFilterId>("all");

  const { data, isPending } = useQuery({
    queryKey: ["draft-edge", NFL_DRAFT_YEAR, "nfl"],
    queryFn: () => fetchDraftEdgeCards(NFL_DRAFT_YEAR, "nfl"),
    staleTime: 5 * 60 * 1000,
  });

  const rows = useMemo(() => {
    const list = data?.items ?? [];
    return list.filter((c) => passesFilter(c, filter));
  }, [data, filter]);

  return (
    <section className="space-y-6" aria-labelledby="draft-edge-heading">
      <div className="space-y-2">
        <h2 id="draft-edge-heading" className="font-display font-bold text-xl sm:text-2xl md:text-3xl text-foreground">
          Draft Edge
        </h2>
        <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
          NFL {NFL_DRAFT_YEAR} draft intelligence — exact picks, position O/U, round props, team needs, and first-at-position
          calls. Signals: grades, team fit, consensus shape, positional value, and rumor/movement notes (mock + optional
          Supabase).
        </p>
        <p className="text-[10px] text-muted-foreground max-w-2xl">
          {data?.source === "api"
            ? "Live: `draft-edge` Edge Function. Errors fall back to mock."
            : "Mock board. Deploy `draft-edge` with `VITE_SUPABASE_URL` + anon key for database-backed cards."}
        </p>
      </div>

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
            <DraftEdgeCardView key={card.id} card={card} />
          ))}
        </div>
      )}
    </section>
  );
}
