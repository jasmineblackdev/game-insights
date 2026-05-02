/**
 * System Status / Model Trust / Data Health — the three decision-first
 * tile rows at the top of /insights. Each consumes a slice of the
 * SystemSummary aggregator so the data fetch happens once at the page
 * level and the sub-components are presentational.
 */

import { useState } from "react";
import {
  AlertTriangle,
  Activity,
  Brain,
  CheckCircle2,
  ClipboardList,
  Clock,
  Database,
  Loader2,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  modelTrustLabel,
  modelTrustToneClass,
  type SystemSummary,
} from "@/lib/insights/systemSummary";
import { aggressivelyResolvePendingParlays } from "@/lib/learning/aggressivePendingResolver";

interface Props {
  summary: SystemSummary | null;
  loading: boolean;
  /** Called after a Data Health action completes so the page can refetch. */
  onChanged?: () => void;
}

// ── System Status ────────────────────────────────────────────────────

export function SystemStatusSection({ summary, loading }: Props) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary" />
        System status (7d)
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile
          label="ROI"
          icon={summary?.roi7d != null && summary.roi7d > 0 ? TrendingUp : TrendingDown}
          loading={loading}
          value={fmtPct(summary?.roi7d)}
          tone={toneForRoi(summary?.roi7d)}
        />
        <Tile
          label="Hit rate"
          icon={Sparkles}
          loading={loading}
          value={fmtPct(summary?.hitRate7d)}
          tone={toneForHit(summary?.hitRate7d)}
        />
        <Tile
          label="Avg CLV"
          icon={summary?.avgClvPp != null && summary.avgClvPp > 0 ? TrendingUp : TrendingDown}
          loading={loading}
          value={fmtPp(summary?.avgClvPp)}
          tone={toneForClv(summary?.avgClvPp)}
        />
        <Tile
          label="Sample"
          icon={ClipboardList}
          loading={loading}
          value={summary != null ? `${summary.sample7d}` : "—"}
          tone={summary?.thinSample ? "warn" : "neutral"}
          subtitle={summary?.thinSample ? "thin sample" : null}
        />
      </div>
    </section>
  );
}

// ── Model Trust ──────────────────────────────────────────────────────

export function ModelTrustSection({ summary, loading }: Props) {
  const status = summary?.modelTrustStatus ?? "needs_data";
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
        <Brain className="w-4 h-4 text-primary" />
        Model trust
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Tile
          label="Brier score"
          icon={Brain}
          loading={loading}
          value={fmtNum(summary?.brierScore, 3)}
          subtitle="lower is better"
          tone={toneForBrier(summary?.brierScore)}
        />
        <Tile
          label="Calibration error"
          icon={Brain}
          loading={loading}
          value={fmtNum(summary?.calibrationError, 3)}
          subtitle="log-loss proxy"
          tone={toneForLogLoss(summary?.calibrationError)}
        />
        <div className={cn(
          "rounded-lg border px-3 py-2.5 flex flex-col justify-center gap-0.5",
          modelTrustToneClass(status),
        )}>
          <p className="text-[10px] uppercase tracking-wide opacity-80 flex items-center gap-1">
            {status === "reliable" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            Status
          </p>
          <p className="text-base font-bold tabular-nums leading-tight">
            {modelTrustLabel(status)}
          </p>
          {summary != null ? (
            <p className="text-[10px] opacity-80 tabular-nums">
              {summary.modelTrustSamples} weighted samples
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

// ── Data Health ──────────────────────────────────────────────────────

export function DataHealthSection({ summary, loading, onChanged }: Props) {
  const stale = summary?.stalePending ?? 0;
  const pending = summary?.pendingCount ?? 0;
  const [resolving, setResolving] = useState(false);

  // Stale-void cutoff = today (midnight). Anything dated before today
  // that's still pending after a fresh resolver pass gets force-voided
  // with a transparent "Auto-voided" note. Idempotent: rerunning is
  // safe.
  const handleResolveStale = async () => {
    if (resolving) return;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const cutoff = `${yyyy}-${mm}-${dd}`;
    if (!window.confirm(
      `Clear stale pending parlays dated before ${cutoff}?\n\n` +
      `Auto-resolver runs first; anything still pending after that ` +
      `gets marked PUSH with an "Auto-voided" note. ML training is ` +
      `unaffected — voided rows are not bridged into prediction_history.\n\n` +
      `Idempotent — safe to run multiple times.`,
    )) return;

    setResolving(true);
    try {
      const r = await aggressivelyResolvePendingParlays({
        voidStaleBeforeDate: cutoff,
      });
      const parts: string[] = [];
      if (r.resolved)          parts.push(`${r.resolved} resolved`);
      if (r.staleVoided)       parts.push(`${r.staleVoided} voided`);
      if (r.needsReviewMarked) parts.push(`${r.needsReviewMarked} flagged`);
      if (parts.length === 0)  parts.push("nothing to do");
      toast.success(`Stale pending sweep: ${parts.join(" · ")}`);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setResolving(false);
    }
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
          <Database className="w-4 h-4 text-primary" />
          Data health
        </h2>
        {pending > 0 || stale > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={handleResolveStale}
            className="h-7 gap-1 text-xs"
            title="Run the auto-resolver against pending parlays; anything still pending after gets force-voided so the count actually drops."
          >
            {resolving
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <AlertTriangle className="w-3 h-3" />}
            {resolving ? "Resolving…" : "Resolve stale"}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <Tile
          label="Pending"
          icon={Clock}
          loading={loading}
          value={summary != null ? `${summary.pendingCount}` : "—"}
          tone={summary && summary.pendingCount > 50 ? "warn" : "neutral"}
        />
        <Tile
          label="Stale pending"
          icon={AlertTriangle}
          loading={loading}
          value={summary != null ? `${stale}` : "—"}
          subtitle={stale > 0 ? "older than 48h" : null}
          tone={stale > 0 ? "loss" : "neutral"}
        />
        <Tile
          label="Manual override rate"
          icon={ClipboardList}
          loading={loading}
          value={fmtPct(summary?.manualOverridePct)}
          subtitle={
            summary?.totalRecommended
              ? `of ${summary.totalRecommended} bets`
              : null
          }
          tone={
            summary?.manualOverridePct != null && summary.manualOverridePct > 50
              ? "warn"
              : "neutral"
          }
        />
      </div>
    </section>
  );
}

// ── Tile primitive ───────────────────────────────────────────────────

type Tone = "win" | "loss" | "warn" | "neutral";

function Tile({
  label, value, icon: Icon, tone = "neutral", subtitle, loading,
}: {
  label: string;
  value: string;
  icon?: typeof Sparkles;
  tone?: Tone;
  subtitle?: string | null;
  loading: boolean;
}) {
  const valueClass =
    tone === "win"  ? "text-emerald-600 dark:text-emerald-400"
    : tone === "loss" ? "text-red-600 dark:text-red-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
    : "text-foreground";
  return (
    <div className="rounded-lg border border-border/50 bg-card/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {Icon ? <Icon className="w-3 h-3" /> : null}{label}
      </p>
      {loading ? (
        <div className="h-6 w-16 bg-muted/40 animate-pulse rounded mt-0.5" />
      ) : (
        <p className={cn("text-lg sm:text-xl font-bold tabular-nums leading-tight", valueClass)}>
          {value}
        </p>
      )}
      {subtitle ? (
        <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5 truncate">{subtitle}</p>
      ) : null}
    </div>
  );
}

// ── Format / tone helpers ────────────────────────────────────────────

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}
function fmtPp(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toFixed(2)}pp`;
}
function fmtNum(n: number | null | undefined, decimals: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function toneForRoi(roi: number | null | undefined): Tone {
  if (roi == null) return "neutral";
  if (roi >= 5) return "win";
  if (roi <= -5) return "loss";
  return "neutral";
}
function toneForHit(p: number | null | undefined): Tone {
  if (p == null) return "neutral";
  if (p >= 55) return "win";
  if (p <= 45) return "loss";
  return "neutral";
}
function toneForClv(pp: number | null | undefined): Tone {
  if (pp == null) return "neutral";
  if (pp >= 1) return "win";
  if (pp <= -1) return "loss";
  return "neutral";
}
function toneForBrier(b: number | null | undefined): Tone {
  if (b == null) return "neutral";
  if (b <= 0.22) return "win";
  if (b > 0.27) return "loss";
  return "warn";
}
function toneForLogLoss(l: number | null | undefined): Tone {
  if (l == null) return "neutral";
  if (l <= 0.62) return "win";
  if (l > 0.72) return "loss";
  return "warn";
}
