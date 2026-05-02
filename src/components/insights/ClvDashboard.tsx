/**
 * ClvDashboard — "% beating closing line" the user cares about.
 *
 * Reads the four CLV RPCs from migration 20260511000000_analytics_clv.sql.
 * Apples-to-apples filter is applied server-side; drifted-line rows
 * are surfaced separately so they don't muddy the headline.
 *
 * Mounts on /insights (currently EdgeCardPage). Renders nothing when
 * the table/RPCs aren't deployed — the dashboard ID-checks fail
 * silently rather than throwing.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  clvTrendDirection,
  fetchClvBySport,
  fetchClvByMarket,
  fetchClvBySportMarket,
  fetchClvResultsBySport,
  fetchClvResultsSummary,
  fetchClvSummary,
  type ClvBreakdownRow,
  type ClvResultsBySportRow,
  type ClvResultsSummary,
  type ClvSummary,
} from "@/lib/analytics/clv";

const THIN_SAMPLE_THRESHOLD = 20;

export function ClvDashboard() {
  const summaryQ = useQuery({
    queryKey: ["clv-summary", 30],
    queryFn: () => fetchClvSummary(30),
    staleTime: 5 * 60_000,
  });
  const bySportQ = useQuery({
    queryKey: ["clv-by-sport", 30],
    queryFn: () => fetchClvBySport(30),
    staleTime: 5 * 60_000,
  });
  const byMarketQ = useQuery({
    queryKey: ["clv-by-market", 30],
    queryFn: () => fetchClvByMarket(30),
    staleTime: 5 * 60_000,
  });
  const bySportMarketQ = useQuery({
    queryKey: ["clv-by-sport-market", 30],
    queryFn: () => fetchClvBySportMarket(30),
    staleTime: 5 * 60_000,
  });
  const resultsSummaryQ = useQuery({
    queryKey: ["clv-results-summary", 30],
    queryFn: () => fetchClvResultsSummary(30),
    staleTime: 5 * 60_000,
  });
  const resultsBySportQ = useQuery({
    queryKey: ["clv-results-by-sport", 30],
    queryFn: () => fetchClvResultsBySport(30),
    staleTime: 5 * 60_000,
  });

  const summary = summaryQ.data;
  const trend = clvTrendDirection(summary ?? null);

  // Fail-quiet on no-data — the migration may not be applied yet.
  const noData = summary == null && !summaryQ.isPending;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-display font-bold text-lg text-foreground">Closing Line Value</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Did the model beat the market? Apples-to-apples only — drifted-line rows shown separately.
        </p>
      </div>

      {noData ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.04] px-3 py-2 text-xs text-foreground">
          CLV data not available yet. Apply migration{" "}
          <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
            20260511000000_analytics_clv.sql
          </code>{" "}
          and wait for closing-odds-poller to populate{" "}
          <code className="px-1 py-0.5 bg-muted rounded text-[11px]">
            prediction_history.extra.clv_pp
          </code>.
        </div>
      ) : null}

      {/* Headline tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile
          label="% beating close"
          value={summary?.pctBeatingClose != null ? `${summary.pctBeatingClose.toFixed(1)}%` : "—"}
          tone={summary?.pctBeatingClose != null ? toneForPct(summary.pctBeatingClose) : "neutral"}
          subtitle={summary ? `${summary.beatingClose}/${summary.totalWithClv}` : null}
        />
        <Tile
          label="Avg CLV"
          value={summary?.avgClvPp != null ? formatPp(summary.avgClvPp) : "—"}
          tone={summary?.avgClvPp != null ? toneForPp(summary.avgClvPp) : "neutral"}
          subtitle={summary?.medianClvPp != null ? `median ${formatPp(summary.medianClvPp)}` : null}
        />
        <Tile
          label="Sample (30d)"
          value={summary ? `${summary.totalWithClv}` : "—"}
          tone={summary && summary.totalWithClv < THIN_SAMPLE_THRESHOLD ? "warn" : "neutral"}
          subtitle={
            summary && summary.totalWithClv < THIN_SAMPLE_THRESHOLD
              ? "thin sample"
              : summary
                ? "apples-to-apples"
                : null
          }
        />
        <Tile
          label="7d vs 30d"
          value={
            trend.dir === "thin" ? "—"
            : trend.dir === "flat" ? "flat"
            : `${trend.deltaPct! > 0 ? "+" : ""}${trend.deltaPct!.toFixed(1)}pp`
          }
          tone={trend.dir === "up" ? "win" : trend.dir === "down" ? "loss" : "neutral"}
          subtitle={
            summary
              ? `${summary.pctBeatingClose7d?.toFixed(0) ?? "—"}% (n=${summary.total7d})`
              : null
          }
          trendIcon={trend.dir === "up" ? "up" : trend.dir === "down" ? "down" : trend.dir === "flat" ? "flat" : null}
        />
      </div>

      {/* Drifted-line cohort callout */}
      {summary && summary.totalDrifted > 0 ? (
        <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
          <Minus className="w-3 h-3 shrink-0" />
          <span>
            Line moved between entry and close on{" "}
            <span className="text-foreground font-semibold tabular-nums">{summary.totalDrifted}</span>{" "}
            rows (avg{" "}
            <span className="text-foreground tabular-nums">
              {summary.avgClvPpDrifted != null ? formatPp(summary.avgClvPpDrifted) : "—"}
            </span>
            ). Excluded from headline metric — not apples-to-apples.
          </span>
        </div>
      ) : null}

      {/* Per-pick CLV result distribution (#169) — five-bucket
          breakdown of every prediction in the window plus the
          headline beat-rate split between apples-to-apples and
          line-changed cohorts so neither inflates the other. */}
      {resultsSummaryQ.data && resultsSummaryQ.data.total > 0 ? (
        <ResultsDistributionCard
          summary={resultsSummaryQ.data}
          bySport={resultsBySportQ.data ?? []}
        />
      ) : null}

      {/* Breakdowns — only render when there's something to show.
          Empty tables on a fresh deploy were noisy; the headline tiles
          above already make the no-data state clear. */}
      {(bySportQ.data?.length ?? 0) > 0 || (byMarketQ.data?.length ?? 0) > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(bySportQ.data?.length ?? 0) > 0 ? (
            <BreakdownCard title="By sport"  rows={bySportQ.data ?? []} loading={bySportQ.isPending} />
          ) : null}
          {(byMarketQ.data?.length ?? 0) > 0 ? (
            <BreakdownCard title="By market" rows={byMarketQ.data ?? []} loading={byMarketQ.isPending} />
          ) : null}
        </div>
      ) : null}

      {(bySportMarketQ.data?.length ?? 0) > 0 ? (
        <details className="rounded-md border border-border/40 bg-card/40 p-2 text-xs">
          <summary className="font-semibold text-foreground cursor-pointer select-none">
            Sport × market crossed ({bySportMarketQ.data?.length ?? 0} rows)
          </summary>
          <div className="mt-2">
            <BreakdownCard title="" rows={bySportMarketQ.data ?? []} loading={bySportMarketQ.isPending} compact />
          </div>
        </details>
      ) : null}

      <p className="text-[10px] text-muted-foreground italic">
        CLV is the per-leg pp delta between entry implied probability and closing implied probability.
        Positive avg CLV = the model is consistently getting better prices than the market settled at.
        Apples-to-apples = same line at entry and close (or no line, e.g. moneyline).
      </p>
    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

/**
 * Per-pick CLV result distribution (#169). Five buckets across the
 * window with the headline beat-rate split by cohort so the
 * line_changed group doesn't pollute the "% beating close" claim.
 */
function ResultsDistributionCard({
  summary, bySport,
}: {
  summary: ClvResultsSummary;
  bySport: ClvResultsBySportRow[];
}) {
  const apples = summary.beatClose + summary.lostToClose + summary.same;
  const drifted = summary.lineChanged;
  return (
    <div className="rounded-md border border-border/40 bg-card/40 p-3 space-y-3">
      <div>
        <p className="text-xs font-semibold text-foreground">Per-pick CLV result</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Bucket distribution across {summary.total.toLocaleString()} picks (last 30d).
          Drifted-line picks are reported separately.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
        <BucketCell label="Beat close"    value={summary.beatClose}    tone="win" />
        <BucketCell label="Lost to close" value={summary.lostToClose}  tone="loss" />
        <BucketCell label="Same"          value={summary.same}         tone="neutral" />
        <BucketCell label="Line changed"  value={summary.lineChanged}  tone="warn" />
        <BucketCell label="Unavailable"   value={summary.unavailable}  tone="muted" />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] tabular-nums">
        <div className="rounded-md border border-border/30 bg-background/40 px-2.5 py-1.5">
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Apples-to-apples</p>
          <p className={cn(
            "font-bold",
            summary.pctBeatCloseApples != null && summary.pctBeatCloseApples >= 55
              ? "text-emerald-600 dark:text-emerald-400"
              : summary.pctBeatCloseApples != null && summary.pctBeatCloseApples <= 45
                ? "text-red-600 dark:text-red-400"
                : "text-foreground",
          )}>
            {summary.pctBeatCloseApples != null ? `${summary.pctBeatCloseApples.toFixed(1)}% beat close` : "—"}
            <span className="text-muted-foreground font-normal ml-1">({apples.toLocaleString()})</span>
          </p>
        </div>
        <div className="rounded-md border border-border/30 bg-background/40 px-2.5 py-1.5">
          <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Line changed</p>
          <p className="font-bold text-foreground">
            {summary.pctBeatCloseDrifted != null ? `${summary.pctBeatCloseDrifted.toFixed(1)}% beat close` : "—"}
            <span className="text-muted-foreground font-normal ml-1">({drifted.toLocaleString()})</span>
          </p>
        </div>
      </div>

      {bySport.length > 0 ? (
        <details className="text-[11px]">
          <summary className="font-semibold text-foreground cursor-pointer select-none">
            By sport ({bySport.length})
          </summary>
          <table className="w-full mt-2">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="font-medium pr-2">Sport</th>
                <th className="font-medium text-right pr-2">Beat</th>
                <th className="font-medium text-right pr-2">Lost</th>
                <th className="font-medium text-right pr-2">Same</th>
                <th className="font-medium text-right pr-2">Line ∆</th>
                <th className="font-medium text-right">N/A</th>
              </tr>
            </thead>
            <tbody>
              {bySport.map((r) => (
                <tr key={r.sport} className="border-t border-border/20">
                  <td className="py-1 uppercase font-semibold text-foreground">{r.sport}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{r.beatClose}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-red-600 dark:text-red-400">{r.lostToClose}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-foreground">{r.same}</td>
                  <td className="py-1 pr-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{r.lineChanged}</td>
                  <td className="py-1 text-right tabular-nums text-muted-foreground">{r.unavailable}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function BucketCell({
  label, value, tone,
}: {
  label: string;
  value: number;
  tone: "win" | "loss" | "warn" | "neutral" | "muted";
}) {
  const cls =
    tone === "win"  ? "text-emerald-600 dark:text-emerald-400"
    : tone === "loss" ? "text-red-600 dark:text-red-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
    : tone === "muted" ? "text-muted-foreground"
    : "text-foreground";
  return (
    <div className="rounded-md border border-border/30 bg-background/40 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-base font-bold tabular-nums leading-tight", cls)}>{value}</p>
    </div>
  );
}

function Tile({
  label, value, tone, subtitle, trendIcon,
}: {
  label: string;
  value: string;
  tone: "win" | "loss" | "warn" | "neutral";
  subtitle: string | null;
  trendIcon?: "up" | "down" | "flat" | null;
}) {
  const valueClass =
    tone === "win"  ? "text-emerald-600 dark:text-emerald-400"
    : tone === "loss" ? "text-red-600 dark:text-red-400"
    : tone === "warn" ? "text-amber-700 dark:text-amber-400"
    : "text-foreground";
  const Icon = trendIcon === "up" ? TrendingUp : trendIcon === "down" ? TrendingDown : trendIcon === "flat" ? Minus : null;
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-bold tabular-nums flex items-center gap-1", valueClass)}>
        {Icon ? <Icon className="w-4 h-4" /> : null}
        {value}
      </p>
      {subtitle ? <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{subtitle}</p> : null}
    </div>
  );
}

function BreakdownCard({
  title, rows, loading, compact,
}: {
  title: string;
  rows: ClvBreakdownRow[];
  loading: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn("rounded-md border border-border/40 bg-card/40", compact ? "p-2" : "p-3")}>
      {title ? <p className="text-xs font-semibold text-foreground mb-2">{title}</p> : null}
      {loading ? (
        <p className="text-[11px] text-muted-foreground italic">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">No CLV rows in this window.</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-muted-foreground">
              <th className="text-left pb-1 font-medium">Bucket</th>
              <th className="text-right pb-1 font-medium" title="Sample size">n</th>
              <th className="text-right pb-1 font-medium">% beating</th>
              <th className="text-right pb-1 font-medium">Avg CLV</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border/20">
                <td className="py-1 uppercase font-semibold text-foreground">{r.key}</td>
                <td className={cn("py-1 text-right tabular-nums", r.n < THIN_SAMPLE_THRESHOLD ? "text-amber-700 dark:text-amber-400" : "text-foreground")}>
                  {r.n}{r.n < THIN_SAMPLE_THRESHOLD ? "*" : ""}
                </td>
                <td className={cn("py-1 text-right tabular-nums", r.pctBeatingClose != null ? toneClassForPct(r.pctBeatingClose) : "text-muted-foreground")}>
                  {r.pctBeatingClose != null ? `${r.pctBeatingClose.toFixed(0)}%` : "—"}
                </td>
                <td className={cn("py-1 text-right tabular-nums", r.avgClvPp != null ? toneClassForPp(r.avgClvPp) : "text-muted-foreground")}>
                  {r.avgClvPp != null ? formatPp(r.avgClvPp) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.some((r) => r.n < THIN_SAMPLE_THRESHOLD) ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-400 mt-1 flex items-center gap-1">
          <ArrowRight className="w-3 h-3" />
          <span>* thin sample (n &lt; {THIN_SAMPLE_THRESHOLD}) — interpret with caution</span>
        </p>
      ) : null}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatPp(pp: number): string {
  const sign = pp > 0 ? "+" : pp < 0 ? "−" : "";
  return `${sign}${Math.abs(pp).toFixed(2)}pp`;
}

function toneForPct(pct: number): "win" | "loss" | "neutral" {
  if (pct >= 55) return "win";
  if (pct <= 45) return "loss";
  return "neutral";
}

function toneForPp(pp: number): "win" | "loss" | "neutral" {
  if (pp >= 1.0) return "win";
  if (pp <= -1.0) return "loss";
  return "neutral";
}

function toneClassForPct(pct: number): string {
  if (pct >= 55) return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (pct <= 45) return "text-red-600 dark:text-red-400 font-semibold";
  return "text-foreground";
}

function toneClassForPp(pp: number): string {
  if (pp >= 1.0) return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (pp <= -1.0) return "text-red-600 dark:text-red-400 font-semibold";
  return "text-foreground";
}
