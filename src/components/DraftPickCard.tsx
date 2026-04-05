import { motion } from "framer-motion";
import { type DraftGrade, type DraftPickPrediction } from "@/data/draftPicks";
import { TeamLogo } from "./TeamLogo";
import { ChevronDown, ChevronUp, Zap, TrendingUp, AlertTriangle } from "lucide-react";
import { useState } from "react";

const gradeColor: Record<DraftGrade, string> = {
  "A+": "text-confidence-high bg-confidence-high/15",
  "A":  "text-confidence-high bg-confidence-high/10",
  "A-": "text-confidence-high bg-confidence-high/10",
  "B+": "text-primary bg-primary/15",
  "B":  "text-primary bg-primary/10",
  "B-": "text-muted-foreground bg-muted",
  "C+": "text-risk bg-risk/10",
};

const confidenceDot: Record<DraftPickPrediction["confidence"], string> = {
  high: "bg-confidence-high",
  medium: "bg-hot-streak",
  low: "bg-cold-streak",
};

interface Props {
  pick: DraftPickPrediction;
  index: number;
}

export function DraftPickCard({ pick, index }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.06 }}
      className="card-shine bg-card rounded-lg border border-border hover:border-primary/30 transition-all"
    >
      {/* Main row */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-4 flex items-center gap-4"
      >
        {/* Pick number */}
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-muted-foreground">{pick.pickNumber}</span>
        </div>

        {/* Team logo */}
        <div className="shrink-0">
          <TeamLogo logo={pick.teamLogo} size="sm" />
        </div>

        {/* Team + player info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground font-medium shrink-0">{pick.teamAbbr}</span>
            <span className="text-sm font-display font-bold text-foreground truncate max-w-[10rem] sm:max-w-none">{pick.playerName}</span>
            <span className="text-xs font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">
              {pick.position}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">{pick.college}</div>
        </div>

        {/* Grade + confidence */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${gradeColor[pick.grade]}`}>
            {pick.grade}
          </span>
          <span className={`w-2 h-2 rounded-full ${confidenceDot[pick.confidence]}`} title={`${pick.confidence} confidence`} />
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2 }}
          className="px-4 pb-4 border-t border-border pt-3 space-y-3"
        >
          {/* Analysis */}
          <p className="text-xs text-secondary-foreground leading-relaxed">{pick.analysis}</p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {/* Key strength */}
            <div className="flex items-start gap-2 text-xs">
              <Zap className="w-3.5 h-3.5 text-confidence-high shrink-0 mt-0.5" />
              <div>
                <span className="text-muted-foreground font-medium">Key Strength: </span>
                <span className="text-secondary-foreground">{pick.keyStrength}</span>
              </div>
            </div>

            {/* Projected impact */}
            <div className="flex items-start gap-2 text-xs">
              <TrendingUp className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              <div>
                <span className="text-muted-foreground font-medium">Impact: </span>
                <span className="text-secondary-foreground">{pick.projectedImpact}</span>
              </div>
            </div>
          </div>

          {pick.comparablePro && (
            <div className="flex items-center gap-2 text-xs border-t border-border/50 pt-2">
              <AlertTriangle className="w-3.5 h-3.5 text-risk shrink-0" />
              <span className="text-muted-foreground">Comp: </span>
              <span className="text-foreground font-semibold">{pick.comparablePro}</span>
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
