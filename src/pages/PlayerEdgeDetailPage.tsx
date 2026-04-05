import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPlayerEdgeById } from "@/data/playerEdgeMock";
import { cn } from "@/lib/utils";

export default function PlayerEdgeDetailPage() {
  const { projectionId } = useParams<{ projectionId: string }>();
  const pred = projectionId ? getPlayerEdgeById(projectionId) : undefined;

  if (!pred) {
    return (
      <div className="min-h-screen bg-background container max-w-2xl mx-auto px-4 py-12">
        <p className="text-muted-foreground mb-4">Projection not found (mock IDs only).</p>
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back home</Link>
        </Button>
      </div>
    );
  }

  const dirClass =
    pred.prediction_direction === "MORE"
      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400"
      : "bg-red-500/15 text-red-600 dark:text-red-400";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border surface-glass sticky top-0 z-40">
        <div className="container max-w-2xl mx-auto px-4 py-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </Link>
        </div>
      </header>
      <main className="container max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <div className="flex flex-wrap gap-2">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted">{pred.sport}</span>
            <span
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded-full",
                pred.confidence === "HIGH" && "text-confidence-high bg-confidence-high/15",
                pred.confidence === "MED" && "text-amber-600 dark:text-amber-400 bg-amber-500/15",
                pred.confidence === "LOW" && "text-muted-foreground bg-muted"
              )}
            >
              {pred.confidence}
            </span>
            <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", dirClass)}>
              {pred.prediction_direction}
            </span>
          </div>
          <h1 className="font-display font-bold text-2xl text-foreground">{pred.player_name}</h1>
          <p className="text-sm text-muted-foreground">
            {pred.team} vs {pred.opponent} · {pred.game_time}
          </p>
          <dl className="grid grid-cols-2 gap-2 text-sm border-t border-border pt-4">
            <dt className="text-muted-foreground">Stat</dt>
            <dd className="text-foreground font-medium">{pred.stat_type.replace(/_/g, " ")}</dd>
            <dt className="text-muted-foreground">Line</dt>
            <dd className="tabular-nums">{pred.line_value}</dd>
            <dt className="text-muted-foreground">Projection</dt>
            <dd className="tabular-nums">{pred.projected_value}</dd>
            <dt className="text-muted-foreground">Edge</dt>
            <dd className="tabular-nums">
              {pred.prediction_direction === "MORE" ? "+" : "−"}
              {Math.abs(pred.edge).toFixed(1)}
            </dd>
          </dl>
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-foreground">Why</p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>{pred.reason_1}</li>
              <li>{pred.reason_2}</li>
            </ul>
            <p className="text-risk pt-2">
              <span className="font-semibold">Risk · </span>
              {pred.risk_factor}
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Mock detail view — wire GET /api/player-edge/:projectionId when backend is ready.
          </p>
        </div>
      </main>
    </div>
  );
}
