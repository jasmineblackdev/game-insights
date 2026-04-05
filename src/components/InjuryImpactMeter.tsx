import { PlayerInjury } from "@/data/mockGames";

interface InjuryImpactMeterProps {
  injuries: PlayerInjury[];
  teamAbbr: string;
}

const statusColors: Record<string, string> = {
  OUT: "bg-destructive/20 text-destructive",
  QUESTIONABLE: "bg-confidence-medium/20 text-confidence-medium",
  PROBABLE: "bg-confidence-high/20 text-confidence-high",
  GTD: "bg-confidence-medium/20 text-confidence-medium",
};

export function InjuryImpactMeter({ injuries, teamAbbr }: InjuryImpactMeterProps) {
  if (injuries.length === 0) {
    return (
      <div className="text-xs text-confidence-high flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-confidence-high animate-pulse-glow" />
        {teamAbbr} fully healthy
      </div>
    );
  }

  const totalImpact = injuries.reduce((sum, i) => sum + i.impactScore, 0);
  const maxImpact = injuries.length * 10;
  const impactPct = Math.round((totalImpact / maxImpact) * 100);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{teamAbbr} Injury Impact</span>
        <span className="text-xs font-semibold text-risk">{impactPct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full bg-risk transition-all duration-700"
          style={{ width: `${impactPct}%` }}
        />
      </div>
      <div className="space-y-1">
        {injuries.map((injury) => (
          <div key={injury.name} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusColors[injury.status]}`}>
                {injury.status}
              </span>
              <span className="text-foreground">{injury.name}</span>
              <span className="text-muted-foreground">{injury.position}</span>
            </div>
            <span className="text-muted-foreground">{injury.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
