/**
 * StatusStrip — compact, collapsible top-of-page status bar that
 * consolidates the previously-stacked banners into a single horizontal
 * chip row. Click the chevron to expand and see the full banner cards.
 *
 * Sources merged:
 *   - BankrollDisciplineBanner (Stop Loss / Profit Lock / Drawdown Wait)
 *   - ProModeBanner            (Pro Mode active + pipeline summary)
 *   - SharpModeBanner          (Sharp Mode active + thresholds)
 *   - DailyParlayCheckBanner   (today's parlays generated yet?)
 *   - DataSourceStatus / odds  (oddsApiHealth — live vs stale)
 *
 * The OddsDebugBadge is intentionally NOT folded in — it's a
 * dev-only fixed-position pill (bottom-right) with provider-health
 * details that don't belong in the user-facing strip.
 *
 * Design constraints:
 *   - Compact view always visible (single row, ~40px tall).
 *   - Click chevron to expand → shows the full original banners.
 *   - Zero data loss vs the old vertical stack.
 *   - Hooks (useBankroll/useSharpMode/useProMode/useOddsApiHealth)
 *     are the same ones the underlying banners use, so chips and
 *     expanded banners stay in sync without prop-drilling.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Crosshair,
  Crown,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Trophy,
  Wallet,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBankroll } from "@/context/BankrollContext";
import { useSharpMode } from "@/context/SharpModeContext";
import { useProMode } from "@/context/ProModeContext";
import { useOddsApiHealth } from "@/lib/oddsApiHealth";
import { computeDiscipline } from "@/lib/bankroll/discipline";
import { pokeSessionHigh } from "@/lib/bankroll/sessionHigh";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";

import { BankrollDisciplineBanner } from "@/components/BankrollDisciplineBanner";
import { ProModeBanner } from "@/components/ProModeBanner";
import { SharpModeBanner } from "@/components/SharpModeBanner";
import { DailyParlayCheckBanner } from "@/components/home/DailyParlayCheckBanner";

interface Props {
  /** Optional pipeline summary to flow through into ProModeBanner. */
  proPipelineSummary?: string | null;
  /** Called when the user taps the "Generate" parlay CTA inside the chip. */
  onGenerateParlay?: () => void;
  /** Optional className applied to the outer container. */
  className?: string;
}

function todayYmdLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function StatusStrip({ proPipelineSummary, onGenerateParlay, className }: Props) {
  const [expanded, setExpanded] = useState(false);

  // ── Bankroll + discipline ───────────────────────────────────────────
  const {
    isInitialized,
    currentBankroll,
    todayPnl,
    lossStreak,
    todaysExposure,
  } = useBankroll();

  const [sessionHigh, setSessionHigh] = useState<number | null>(null);
  useEffect(() => {
    if (!isInitialized || currentBankroll <= 0) return;
    setSessionHigh(pokeSessionHigh(currentBankroll));
  }, [isInitialized, currentBankroll]);

  const discipline = useMemo(() => {
    if (!isInitialized || currentBankroll <= 0) return null;
    return computeDiscipline({
      startOfDayBankroll: currentBankroll - todayPnl,
      currentBankroll,
      todayPnl,
      lossStreak,
      todaysExposure,
      sessionHigh,
    });
  }, [isInitialized, currentBankroll, todayPnl, lossStreak, todaysExposure, sessionHigh]);

  // ── Mode chips ─────────────────────────────────────────────────────
  const { enabled: sharpOn } = useSharpMode();
  const { enabled: proOn } = useProMode();

  // ── Odds health ────────────────────────────────────────────────────
  const oddsHealth = useOddsApiHealth();

  // ── Daily parlay generated? ────────────────────────────────────────
  const today = useMemo(() => todayYmdLocal(), []);
  const { data: parlayGeneratedToday } = useQuery({
    queryKey: ["status-strip-parlay-today", today],
    enabled: isSupabaseConfigured && !!supabase,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      if (!supabase) return true; // assume true to avoid noisy chip on unconfigured envs
      const { count } = await supabase
        .from("recommended_parlays")
        .select("id", { count: "exact", head: true })
        .eq("source", "app_recommended")
        .eq("date", today);
      return (count ?? 0) > 0;
    },
  });

  // ── Chip data ──────────────────────────────────────────────────────
  const disciplineChip = discipline && discipline.state !== "ok" ? (() => {
    const Icon =
      discipline.state === "stop_loss_hit" ? ShieldAlert
      : discipline.state === "profit_target" ? Trophy
      : discipline.state === "profit_locked" ? ShieldCheck
      : discipline.state === "drawdown_wait" ? TrendingDown
      : ShieldAlert;
    const label =
      discipline.state === "stop_loss_hit" ? "STOP LOSS"
      : discipline.state === "profit_target" ? "PROFIT TARGET"
      : discipline.state === "drawdown_wait" ? "DRAWDOWN WAIT"
      : "PROFIT LOCK";
    const tone =
      discipline.state === "stop_loss_hit" ? "border-red-500/40 bg-red-500/[0.08] text-red-700 dark:text-red-400"
      : discipline.state === "drawdown_wait" ? "border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400"
      : "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400";
    return { Icon, label, tone };
  })() : null;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm",
        className,
      )}
    >
      {/* ── Compact chip row ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {/* Bankroll */}
        {isInitialized && currentBankroll > 0 ? (
          <Chip>
            <Wallet className="w-3 h-3" />
            <span className="font-semibold">${Math.round(currentBankroll)}</span>
            {todayPnl !== 0 ? (
              <span className={cn(
                "text-[10px] tabular-nums",
                todayPnl > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
              )}>
                {todayPnl > 0 ? "+" : ""}{todayPnl.toFixed(0)}
              </span>
            ) : null}
          </Chip>
        ) : null}

        {/* Mode */}
        {proOn || sharpOn ? (
          <Chip tone={proOn ? "violet" : "emerald"}>
            {proOn ? <Crown className="w-3 h-3" /> : <Crosshair className="w-3 h-3" />}
            <span className="font-semibold">
              {proOn && sharpOn ? "Pro + Sharp" : proOn ? "Pro Mode" : "Sharp Mode"}
            </span>
          </Chip>
        ) : (
          <Chip tone="muted">
            <span className="font-semibold text-muted-foreground">Standard</span>
          </Chip>
        )}

        {/* Odds health */}
        {oddsHealth.stale ? (
          <Chip tone="amber">
            <WifiOff className="w-3 h-3" />
            <span className="font-semibold">Odds stale</span>
          </Chip>
        ) : (
          <Chip tone="emerald-soft">
            <span className="text-[10px]">●</span>
            <span className="font-semibold">Odds live</span>
          </Chip>
        )}

        {/* Daily parlay nudge */}
        {parlayGeneratedToday === false && onGenerateParlay ? (
          <button
            type="button"
            onClick={onGenerateParlay}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-primary/40 bg-primary/[0.08] text-primary hover:bg-primary/[0.16] transition-colors"
          >
            <Sparkles className="w-3 h-3" />
            <span className="font-semibold">No parlay today — generate</span>
          </button>
        ) : null}

        {/* Discipline warning */}
        {disciplineChip ? (
          <span className={cn(
            "inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border",
            disciplineChip.tone,
          )}>
            <disciplineChip.Icon className="w-3 h-3" />
            <span className="font-semibold">{disciplineChip.label}</span>
          </span>
        ) : null}

        {/* Spacer + expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse status details" : "Expand status details"}
        >
          {expanded ? "Hide details" : "Details"}
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* ── Expanded banners ─────────────────────────────────────────── */}
      {expanded ? (
        <div className="px-3 pb-3 space-y-2 border-t border-border/40 pt-3">
          <BankrollDisciplineBanner />
          <ProModeBanner pipelineSummary={proPipelineSummary} />
          <SharpModeBanner />
          {onGenerateParlay ? (
            <DailyParlayCheckBanner onGenerate={onGenerateParlay} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Internal chip primitive ───────────────────────────────────────────

type ChipTone = "default" | "muted" | "violet" | "emerald" | "emerald-soft" | "amber";

function Chip({ children, tone = "default" }: { children: React.ReactNode; tone?: ChipTone }) {
  const toneClass: Record<ChipTone, string> = {
    default:        "border-border/60 bg-muted/40 text-foreground",
    muted:          "border-border/40 bg-muted/20 text-muted-foreground",
    violet:         "border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400",
    emerald:        "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400",
    "emerald-soft": "border-emerald-500/20 bg-emerald-500/[0.04] text-emerald-700 dark:text-emerald-400",
    amber:          "border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400",
  };
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border",
      toneClass[tone],
    )}>
      {children}
    </span>
  );
}
