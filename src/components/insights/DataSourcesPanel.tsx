/**
 * Data Sources panel — read-only health/freshness view of the
 * external data providers GameLens depends on. Surfaces the same
 * data the rest of the app already consumes, in one place, so the
 * user can tell at a glance whether the system is operating on
 * fresh inputs.
 *
 * Providers covered (#168 layer):
 *   • Sleeper          — NFL roster + live injury feed
 *   • balldontlie      — NBA player stats
 *   • The Odds API     — odds + closing-line snapshots (live state
 *                        already surfaced on Data Health, summarized
 *                        here for completeness)
 *
 * Visibility-only — does not change recommendation behavior. Each
 * row shows a status pill, a brief subtitle, and (when known) the
 * last successful fetch timestamp.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useNflInjuries } from "@/hooks/useNflInjuries";
import { pingBalldontlie } from "@/lib/balldontlieFetch";
import { getOddsApiHealthSnapshot } from "@/lib/oddsApiHealth";

type Tone = "green" | "amber" | "red" | "neutral";

interface RowProps {
  name:     string;
  state:    "ok" | "warn" | "down" | "unknown" | "loading";
  subtitle: string | null;
  /** ISO. When present, renders a relative "x minutes ago" pill. */
  lastFetchedIso?: string | null;
}

function tone(state: RowProps["state"]): Tone {
  if (state === "ok")      return "green";
  if (state === "warn")    return "amber";
  if (state === "down")    return "red";
  return "neutral";
}

function stateLabel(state: RowProps["state"]): string {
  if (state === "ok")      return "Live";
  if (state === "warn")    return "Stale";
  if (state === "down")    return "Down";
  if (state === "loading") return "Loading…";
  return "Unknown";
}

function relativeMinutes(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1)  return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ToneClass(t: Tone): string {
  if (t === "green")  return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30";
  if (t === "amber")  return "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30";
  if (t === "red")    return "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30";
  return "bg-muted/30 text-muted-foreground border-border/50";
}

function Row({ name, state, subtitle, lastFetchedIso }: RowProps) {
  const t = tone(state);
  const ago = relativeMinutes(lastFetchedIso);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/40 bg-background/40 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-foreground text-sm">{name}</p>
        {subtitle ? (
          <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {ago ? (
          <span className="text-[10px] text-muted-foreground tabular-nums">{ago}</span>
        ) : null}
        <span className={cn(
          "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border",
          ToneClass(t),
        )}>
          {state === "loading" ? <Loader2 className="w-3 h-3 animate-spin inline" /> : stateLabel(state)}
        </span>
      </div>
    </div>
  );
}

export function DataSourcesPanel() {
  // Sleeper — the existing useNflInjuries hook already manages
  // caching and timestamps. We just observe.
  const sleeper = useNflInjuries();

  // balldontlie — ping on first mount, then on demand. The proxy
  // is shared with the rest of the app, but no other surface
  // currently exercises it, so a ping here is the only signal.
  const ping = useQuery({
    queryKey:             ["balldontlie-ping"],
    queryFn:              pingBalldontlie,
    staleTime:            5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // The Odds API — the health store is module-level, not a query.
  // Snapshot it on mount and re-render when the user clicks Refresh
  // (since the snapshot is imperative there's no subscription here).
  const [oddsSnapshot, setOddsSnapshot] = useState(getOddsApiHealthSnapshot());
  useEffect(() => { setOddsSnapshot(getOddsApiHealthSnapshot()); }, []);

  const refreshAll = () => {
    void ping.refetch();
    setOddsSnapshot(getOddsApiHealthSnapshot());
    // useNflInjuries query is keyed off React-Query — invalidating
    // would require importing the queryClient. Skip for now; the
    // hook's 15-min staleTime will refresh on its own when the
    // user comes back.
  };

  return (
    <section className="space-y-2 border-t border-border pt-8">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <Database className="w-4 h-4 text-primary" />
            Data sources
          </h2>
          <p className="text-[11px] text-muted-foreground">
            External providers feeding picks + live state.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={refreshAll}
          disabled={ping.isFetching}
          className="h-7 gap-1 text-xs"
        >
          {ping.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </Button>
      </div>

      <div className="space-y-1.5">
        <Row
          name="Sleeper · NFL injuries"
          state={
            sleeper.fetchedAtIso == null
              ? "loading"
              : sleeper.injuries.length === 0
                ? "warn"
                : "ok"
          }
          subtitle={
            sleeper.fetchedAtIso == null
              ? "Loading active injury feed…"
              : sleeper.injuries.length === 0
                ? "0 injuries — feed reached but list is empty (off-season?)"
                : `${sleeper.injuries.length} active injuries · ${countByStatus(sleeper.injuries)}`
          }
          lastFetchedIso={sleeper.fetchedAtIso}
        />
        <Row
          name="balldontlie · NBA stats"
          state={
            ping.isPending
              ? "loading"
              : ping.data === "ok"
                ? "ok"
                : ping.data === "no_proxy"
                  ? "down"
                  : "warn"
          }
          subtitle={
            ping.isPending
              ? "Pinging proxy…"
              : ping.data === "ok"
                ? "Proxy round-tripped — API key authorized."
                : ping.data === "no_proxy"
                  ? "Edge function URL not configured."
                  : "Proxy reachable but upstream rejected the call (check BALLDONTLIE_API_KEY)."
          }
          lastFetchedIso={ping.dataUpdatedAt ? new Date(ping.dataUpdatedAt).toISOString() : null}
        />
        <Row
          name="The Odds API · lines + close"
          state={oddsSnapshot.stale ? "warn" : "ok"}
          subtitle={
            oddsSnapshot.stale
              ? oddsSnapshot.message ?? "Provider degraded — lines may be cached."
              : "Provider healthy — closing-line poller active."
          }
          lastFetchedIso={oddsSnapshot.occurredAt}
        />
      </div>
    </section>
  );
}

function countByStatus(rows: { injuryStatus: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.injuryStatus.trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Most common first; cap at 3 entries for the subtitle.
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return sorted.map(([k, n]) => `${n} ${k}`).join(" · ");
}
