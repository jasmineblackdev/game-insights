import { PlayerTrendData } from "@/data/mockGames";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface PlayerTrendCardProps {
  player: PlayerTrendData;
}

const trendConfig = {
  hot: { icon: TrendingUp, label: "HOT", colorClass: "text-hot-streak", bgClass: "bg-hot-streak/15" },
  cold: { icon: TrendingDown, label: "COLD", colorClass: "text-cold-streak", bgClass: "bg-cold-streak/15" },
  steady: { icon: Minus, label: "STEADY", colorClass: "text-muted-foreground", bgClass: "bg-muted" },
};

export function PlayerTrendCard({ player }: PlayerTrendCardProps) {
  const { icon: Icon, label, colorClass, bgClass } = trendConfig[player.trend];
  const diff = player.last5Avg - player.seasonAvg;
  const hasDiff = Math.abs(diff) >= 0.1;

  return (
    <div className="flex items-center gap-3 py-2">
      <div className={`p-1.5 rounded-md ${bgClass}`}>
        <Icon className={`w-3.5 h-3.5 ${colorClass}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{player.name}</span>
          <span className={`text-[10px] font-bold tracking-wider ${colorClass}`}>{label}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {hasDiff ? (
            <>
              <span>L5: <span className="text-foreground font-medium">{player.last5Avg}</span></span>
              <span>Szn: {player.seasonAvg}</span>
              <span className={diff > 0 ? "text-confidence-high" : "text-destructive"}>
                {diff > 0 ? "+" : ""}{diff.toFixed(1)}
              </span>
            </>
          ) : (
            <span>Season avg: <span className="text-foreground font-medium">{player.seasonAvg}</span></span>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[10px] text-muted-foreground">{player.keyMetric}</div>
        <div className="text-sm font-semibold text-foreground">{player.keyMetricValue}</div>
      </div>
    </div>
  );
}
