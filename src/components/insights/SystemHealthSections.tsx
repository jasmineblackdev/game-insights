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

  // Stale-void cutoffs aligned with Data Health's count signal:
  //   • voidStaleBeforeRecommendedAt = now − 48h (matches the Health
  //     query that flags `recommended_at < now-48h` as stale)
  //   • voidStaleBeforeDate = today's YMD (game-date semantic kept
  //     for legacy parity; either cutoff fires the void)
  // The sweep used to only honor the YMD cutoff against the game-
  // date column, which let rows with `date = today` slip past even
  // when their row had been pending for 3+ days. Now Health and
  // sweep target the same set.
  const handleResolveStale = async () => {
    if (resolving) return;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const cutoffYmd = `${yyyy}-${mm}-${dd}`;
    const cutoffIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    if (!window.confirm(
      `Resolve stale pending — auto-resolver runs first; anything ` +
      `still pending whose row is older than 48h (or whose game ` +
      `date is before ${cutoffYmd}) gets marked PUSH with an ` +
      `"Auto-voided" note. ML training is unaffected — voided rows ` +
      `are not bridged into prediction_history. Idempotent.`,
    )) return;

    // Debug snapshot for parity check against the sweep.
    if (typeof console !== "undefined") {
      console.debug("[Resolve stale] dispatching", {
        healthPendingCount: summary?.pendingCount ?? null,
        healthStaleCount:   summary?.stalePending ?? null,
        cutoffYmd,
        cutoffIso,
      });
    }

    setResolving(true);
    try {
      const r = await aggressivelyResolvePendingParlays({
        voidStaleBeforeDate: cutoffYmd,
        voidStaleBeforeRecommendedAt: cutoffIso,
      });
      // Skipped = anything the sweep saw but neither resolved nor
      // voided nor flagged. Rare once the cutoffs match Health but
      // still possible (e.g. resolver bug, bridge insert errors).
      const skipped = Math.max(
        0,
        r.scanned - r.resolved - r.staleVoided - r.needsReviewMarked,
      );
      const parts = [
        `Resolved ${r.resolved}`,
        `Voided ${r.staleVoided}`,
        `Skipped ${skipped}`,
      ];
      if (r.needsReviewMarked) parts.push(`Flagged ${r.needsReviewMarked}`);
      if (r.errors.length) parts.push(`${r.errors.length} errors`);
      const msg = parts.join(" · ");
      // Choose tone: success when something landed, error on errors,
      // neutral otherwise.
      if (r.errors.length) toast.error(msg);
      else if (r.resolved + r.staleVoided + r.needsReviewMarked > 0) toast.success(msg);
      else toast.message(msg);
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

      {/* Per-diagnosis bucket strip — covers the original leg-walk
          counts (#170) plus the bet-level extras and live odds-stale
          signal (#172). Renders whenever there's anything to flag,
          so a stale odds provider surfaces even if every leg is
          clean. Read-side only — no client-side leg walk. */}
      {summary?.dataQuality && (
        summary.dataQuality.total > 0 ||
        summary.dataQuality.staleOddsNow.stale
      ) ? (
        <DataQualityRow counts={summary.dataQuality} />
      ) : null}
    </section>
  );
}

function DataQualityRow({ counts }: { counts: NonNullable<SystemSummary["dataQuality"]> }) {
  // Each flag is only worth surfacing as a tile when non-zero. For
  // a healthy deploy the row collapses to whatever is broken right
  // now — no permanent "0 missing playerId" tile staring at the user.
  const flags: { label: string; value: number; tone: Tone; subtitle?: string }[] = [
    {
      label: "Missing gameId",
      value: counts.missingGameId,
      tone: counts.missingGameId > 0 ? "loss" : "neutral",
      subtitle: counts.missingGameId > 0 ? "edit bet to fix" : undefined,
    },
    {
      label: "Missing playerId",
      value: counts.missingPlayerId,
      tone: counts.missingPlayerId > 0 ? "loss" : "neutral",
      subtitle: counts.missingPlayerId > 0 ? "athlete not matched" : undefined,
    },
    {
      label: "Unsupported stat",
      value: counts.unsupportedStat,
      tone: counts.unsupportedStat > 0 ? "warn" : "neutral",
      subtitle: counts.unsupportedStat > 0 ? "no ESPN mapping" : undefined,
    },
    {
      label: "Invalid market",
      value: counts.invalidMarket,
      tone: counts.invalidMarket > 0 ? "warn" : "neutral",
      subtitle: counts.invalidMarket > 0 ? "team label unmatched" : undefined,
    },
    {
      label: "Missing direction",
      value: counts.missingDirection,
      tone: counts.missingDirection > 0 ? "warn" : "neutral",
    },
    {
      label: "Box score missing",
      value: counts.boxScoreMissing,
      tone: counts.boxScoreMissing > 0 ? "warn" : "neutral",
      subtitle: counts.boxScoreMissing > 0 ? "ESPN hasn't published" : undefined,
    },
    // Extras (#172) — bet-level signals not on the leg JSONB.
    {
      label: "Unresolved after final",
      value: counts.unresolvedAfterFinal,
      tone: counts.unresolvedAfterFinal > 0 ? "loss" : "neutral",
      subtitle: counts.unresolvedAfterFinal > 0 ? "game over, bet still open" : undefined,
    },
    {
      label: "Manual override used",
      value: counts.manualOverrideUsed,
      tone: counts.manualOverrideUsed > 0 ? "warn" : "neutral",
      subtitle: counts.manualOverrideUsed > 0 ? "resolver missed it" : undefined,
    },
    {
      label: "Odds unavailable",
      value: counts.oddsUnavailable,
      tone: counts.oddsUnavailable > 0 ? "warn" : "neutral",
      subtitle: counts.oddsUnavailable > 0 ? "no closing line captured" : undefined,
    },
  ];
  const visible = flags.filter((f) => f.value > 0);
  const oddsStale = counts.staleOddsNow.stale;

  if (visible.length === 0 && !oddsStale) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-400">
        ✓ No data-quality issues flagged in the last 30 days.
      </div>
    );
  }

  // The live "stale odds" banner sits above the collapsible counts
  // since it's the most actionable signal — the user can refresh or
  // wait for the rate-limit to clear, neither of which applies to
  // the historical buckets below.
  const flaggedLabel =
    visible.length === 0
      ? "Odds provider stale"
      : `${visible.length} data-quality issue${visible.length === 1 ? "" : "s"} flagged`;

  return (
    <div className="space-y-2">
      {oddsStale ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-700 dark:text-red-400 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Stale odds — provider degraded</p>
            <p className="opacity-80">
              {counts.staleOddsNow.message ?? "Lines on screen may be cached or mocked."}
              {counts.staleOddsNow.sportKey ? ` (${counts.staleOddsNow.sportKey})` : ""}
            </p>
          </div>
        </div>
      ) : null}
      {visible.length > 0 ? (
        <details className="rounded-md border border-amber-500/30 bg-amber-500/[0.04] p-2 text-xs">
          <summary className="font-semibold text-foreground cursor-pointer select-none flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-700 dark:text-amber-400" />
            {flaggedLabel}
            <span className="text-muted-foreground font-normal ml-1">({counts.total} flagged total)</span>
          </summary>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {visible.map((f) => (
              <Tile
                key={f.label}
                label={f.label}
                value={`${f.value}`}
                subtitle={f.subtitle ?? null}
                tone={f.tone}
                loading={false}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
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
