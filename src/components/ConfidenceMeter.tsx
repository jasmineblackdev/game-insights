import { motion } from "framer-motion";
import { ConfidenceLevel } from "@/data/mockGames";

interface ConfidenceMeterProps {
  level: ConfidenceLevel;
  probability: number;
  /** When false, only the confidence pill shows (e.g. soccer centers draw % separately). */
  showRing?: boolean;
}

const config: Record<ConfidenceLevel, { label: string; colorClass: string; bgClass: string }> = {
  high: { label: "HIGH", colorClass: "text-confidence-high", bgClass: "bg-confidence-high" },
  medium: { label: "MED", colorClass: "text-confidence-medium", bgClass: "bg-confidence-medium" },
  low: { label: "LOW", colorClass: "text-confidence-low", bgClass: "bg-confidence-low" },
};

export function ConfidenceMeter({ level, probability, showRing = true }: ConfidenceMeterProps) {
  const { label, colorClass, bgClass } = config[level];

  return (
    <div className="flex flex-col items-center gap-1.5">
      {showRing ? (
        <div className="relative w-16 h-16">
          <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
            <circle cx="32" cy="32" r="28" fill="none" stroke="hsl(var(--border))" strokeWidth="4" />
            <motion.circle
              cx="32" cy="32" r="28"
              fill="none"
              className={`stroke-current ${colorClass}`}
              strokeWidth="4"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 28}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 28 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 28 * (1 - probability / 100) }}
              transition={{ duration: 1, ease: "easeOut", delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`text-sm font-display font-bold ${colorClass}`}>{probability}%</span>
          </div>
        </div>
      ) : null}
      <span className={`text-[10px] font-semibold tracking-widest ${colorClass} ${bgClass}/10 px-2 py-0.5 rounded-full`}>
        {label}
      </span>
    </div>
  );
}
