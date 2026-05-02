/**
 * PaperBetCard — visual representation of a single paper ticket.
 *
 * Shows legs + per-leg status + auto-resolved actuals + the ticket
 * total P/L. For "open" / "needs_review" tickets, exposes manual
 * settle buttons (Won / Lost / Push / Void) so the user can resolve
 * legs the auto-resolver couldn't confidently match.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Check, X, Circle, AlertTriangle, Clock, Radio, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolvePaperBet } from "@/lib/paperBets/resolver";
import {
  markPaperBetNeedsReview,
  settlePaperBet,
  updatePaperBetLegs,
  voidPaperBet,
} from "@/lib/paperBets/store";
import { americanToPayoutMultiplier } from "@/lib/paperBets/normalizer";
import { formatLiveStateLine } from "@/lib/paperBets/liveTracker";
import { snapshotBetAsDraft } from "@/lib/paperBets/drafts";
import { InjuryBadge } from "@/components/InjuryBadge";
import {
  actionableDiagnosisCopy,
  diagnosisLabel,
  isTransient,
  type ResolutionDiagnosis,
} from "@/lib/learning/resolutionDiagnosis";
import type { PaperBet, PaperLeg, PaperLegStatus } from "@/lib/paperBets/types";

interface Props {
  bet: PaperBet;
  onChanged?: () => void;
  /**
   * Called when the user hits "Edit bet" on a needs-review leg.
   * The card converts the bet to a draft via snapshotBetAsDraft;
   * the parent (PaperBetsPage) loads the draft into Slip builder.
   * When omitted the Edit-bet CTA is hidden.
   */
  onEditBet?: (draftId: string) => void;
}

export function PaperBetCard({ bet, onChanged, onEditBet }: Props) {
  const [busy, setBusy] = useState(false);

  // Per-bet retry — re-runs the resolver and routes the outcome
  // through the right persistence path:
  //   • terminal (won/lost/push/voided)   → settlePaperBet (resolved_via='espn')
  //   • needs_review                      → markPaperBetNeedsReview
  //   • still pending (game not final)    → updatePaperBetLegs (legs only)
  // Never flips a pending bet to a fake terminal status.
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await resolvePaperBet(bet);
      try {
        const isTerminal =
          r.status === "won" || r.status === "lost" ||
          r.status === "push" || r.status === "voided";
        if (isTerminal) {
          await settlePaperBet({
            betId: bet.id,
            status: r.status,
            pnl: r.pnl ?? 0,
            legs: r.legs,
            resolvedVia: "espn",
          });
          toast.success(`Resolved via ESPN — ${r.pnl != null ? formatPnl(r.pnl) : r.status}.`);
        } else if (r.status === "needs_review") {
          await markPaperBetNeedsReview(bet.id, r.legs);
          toast.message("Needs review — see per-leg diagnosis.");
        } else {
          await updatePaperBetLegs(bet.id, r.legs);
          toast.message("Still pending — game not final.");
        }
        onChanged?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Settle failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const manualSettle = async (legIdx: number, newStatus: PaperLegStatus) => {
    if (busy) return;
    setBusy(true);
    try {
      const updatedLegs: PaperLeg[] = bet.legs.map((l, i) =>
        i === legIdx ? { ...l, status: newStatus, resolvedReason: "Manual override.", resolvedAt: new Date().toISOString() } : l,
      );
      // Recompute roll-up off the updated legs.
      const allResolved = updatedLegs.every((l) => l.status !== "open");
      let parlayStatus: PaperBet["status"] = "in_progress";
      let pnl = 0;
      if (updatedLegs.some((l) => l.status === "lost")) {
        parlayStatus = "lost";
        pnl = -bet.stake;
      } else if (allResolved) {
        const won = updatedLegs.filter((l) => l.status === "won");
        if (won.length === updatedLegs.length) {
          const dec = updatedLegs.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
          parlayStatus = "won";
          pnl = Math.round(bet.stake * (dec - 1) * 100) / 100;
        } else if (updatedLegs.every((l) => l.status === "push" || l.status === "voided")) {
          parlayStatus = "push";
          pnl = 0;
        } else {
          parlayStatus = "won";
          // Recompute payout dropping pushed legs.
          const dec = won.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
          pnl = Math.round(bet.stake * (dec - 1) * 100) / 100;
        }
      } else if (updatedLegs.some((l) => l.status === "needs_review")) {
        parlayStatus = "needs_review";
      }
      try {
        await settlePaperBet({
          betId: bet.id,
          status: parlayStatus,
          pnl,
          legs: updatedLegs,
          resolvedVia: "manual",
        });
        toast.success("Leg updated.");
        onChanged?.();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Update failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onVoid = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await voidPaperBet(bet.id);
      toast.success("Paper bet voided.");
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Void failed.");
    } finally {
      setBusy(false);
    }
  };

  const tone = statusTone(bet.status);
  const isTerminal =
    bet.status === "won" || bet.status === "lost"
    || bet.status === "push" || bet.status === "voided";

  return (
    <div className={cn("rounded-xl border-2 p-3 sm:p-4 space-y-3", tone)}>
      {/* ── Ticket header ───────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={bet.status} />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-bold">
          {bet.betType}
          {bet.legs.length > 1 ? ` · ${bet.legs.length} legs` : ""}
        </span>
        <LiveStatusPill bet={bet} />
        <ResolutionVia bet={bet} />
        <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
          {new Date(bet.placedAt).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </span>
      </div>

      {/* ── Money row (ticket-style stake/payout/PnL trio) ───── */}
      <MoneyRow bet={bet} />

      <ul className="space-y-2">
        {bet.legs.map((l, i) => (
          <li key={i} className="rounded-md border border-border/40 bg-background/40 p-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <LegStatusIcon status={l.status} />
              <span className="text-[10px] uppercase font-bold text-muted-foreground">{l.sport}</span>
              <span className="flex-1 min-w-0 truncate text-sm font-semibold text-foreground">{l.dkLabel}</span>
              <span className="font-mono tabular-nums text-xs text-foreground">
                {l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}
              </span>
            </div>
            {l.playerName || l.teamLabel ? (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap">
                <span>{l.playerName ?? l.teamLabel}</span>
                {l.playerName ? (
                  <InjuryBadge playerName={l.playerName} sport={l.sport} />
                ) : null}
                {l.statType ? <span>· {l.statType}</span> : null}
                {l.direction && l.line != null ? <span>· {l.direction} {l.line}</span> : null}
              </p>
            ) : null}
            <LivePlayerPropNote bet={bet} leg={l} />

            {l.resolvedActual != null || l.resolvedReason ? (
              <p className="text-[11px] text-foreground">
                {l.resolvedActual != null ? <span className="font-semibold">Actual {l.resolvedActual} · </span> : null}
                <span className="text-muted-foreground">{l.resolvedReason}</span>
              </p>
            ) : null}
            <LegDiagnosisRow leg={l} bet={bet} onEditBet={onEditBet} />

            {l.status === "open" || l.status === "needs_review" ? (
              <div className="flex flex-wrap gap-1 pt-1">
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "won")} disabled={busy}>Won</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "lost")} disabled={busy}>Lost</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => manualSettle(i, "push")} disabled={busy}>Push</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {/* ── Outcome banner — settled bets only ──────── */}
      {isTerminal ? <OutcomeBanner bet={bet} /> : null}

      {bet.notes ? (
        <p className="text-[11px] text-muted-foreground italic">"{bet.notes}"</p>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {(bet.status === "open" || bet.status === "in_progress" || bet.status === "needs_review") ? (
          <>
            <Button size="sm" variant="outline" className="gap-1 h-8 text-xs" onClick={refresh} disabled={busy}>
              <RefreshCw className={cn("w-3 h-3", busy ? "animate-spin" : "")} />
              {bet.status === "needs_review" ? "Retry resolve" : "Resolve from feeds"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" onClick={onVoid} disabled={busy}>Void</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Money row — ticket-style stake / to-win / net-PnL trio. Gives
 * every paper bet a betslip-y visual anchor regardless of status.
 *
 * • Pending/open: shows Stake + To Win + "—" for net.
 * • Settled: net replaces the placeholder with the signed P/L.
 *
 * Math comes from the existing combinedOddsAmerican on the row;
 * we don't recompute the optimizer's payout. To-win is the gross
 * profit (stake × multiplier − stake), so a $10 stake at +220 reads
 * "Stake $10 · To Win $22 · Net +$22" on a winner.
 */
function MoneyRow({ bet }: { bet: PaperBet }) {
  const stake   = bet.stake;
  const payout  = bet.potentialPayout;
  const toWin   = payout > 0 ? payout - stake : 0;
  const netText = bet.pnl != null ? formatPnl(bet.pnl) : null;
  const netTone =
    bet.pnl != null && bet.pnl > 0 ? "text-emerald-600 dark:text-emerald-400"
    : bet.pnl != null && bet.pnl < 0 ? "text-red-600 dark:text-red-400"
    : "text-muted-foreground";

  return (
    <div className="grid grid-cols-3 gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-center">
      <Field label="Stake"   value={`$${stake.toFixed(2)}`} />
      <Field label="To Win"  value={toWin > 0 ? `$${toWin.toFixed(2)}` : "—"} />
      <Field
        label="Net"
        value={netText ?? "—"}
        valueClass={cn("font-bold tabular-nums", netTone)}
      />
    </div>
  );
}

function Field({
  label, value, valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-sm tabular-nums text-foreground font-semibold", valueClass)}>
        {value}
      </p>
    </div>
  );
}

/**
 * Outcome banner — "Why it won/lost" framing for settled tickets.
 * Composes a single-line summary from leg statuses + resolvedReasons:
 *
 *   Won   — every settled-and-non-pushed leg won. Highlights the
 *           lead leg's reason ("Lakers won 110-95.").
 *   Lost  — at least one leg lost; surfaces the FIRST losing leg's
 *           name + its reason as the killshot.
 *   Push  — bet voided / pushed; brief neutral framing.
 *   Voided — paid back; no profit/loss reasoning.
 *
 * Falls back to a minimal "Settled — X-Y-Z" tally when no per-leg
 * resolvedReason was captured.
 */
function OutcomeBanner({ bet }: { bet: PaperBet }) {
  const summary = composeOutcomeSummary(bet);
  if (!summary) return null;
  const tone =
    bet.status === "won" ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400"
    : bet.status === "lost" ? "border-red-500/40 bg-red-500/[0.06] text-red-700 dark:text-red-400"
    : "border-border/60 bg-muted/30 text-muted-foreground";
  const headline =
    bet.status === "won" ? "Won"
    : bet.status === "lost" ? "Lost"
    : bet.status === "push" ? "Push"
    : bet.status === "voided" ? "Voided"
    : "Settled";
  return (
    <div className={cn("rounded-md border px-3 py-2 text-[12px]", tone)}>
      <span className="font-bold">{headline}</span>
      {" — "}
      <span className="text-foreground">{summary}</span>
    </div>
  );
}

function composeOutcomeSummary(bet: PaperBet): string | null {
  const legs = bet.legs ?? [];
  if (legs.length === 0) return null;
  if (bet.status === "voided") {
    return "Bet voided — stake returned, no P/L.";
  }
  if (bet.status === "lost") {
    const killer = legs.find((l) => l.status === "lost");
    if (killer) {
      const who = killer.playerName ?? killer.teamLabel ?? "Leg";
      const why = killer.resolvedReason ?? "didn't cover.";
      return `${who} ${why}`;
    }
    return "At least one leg didn't cover.";
  }
  if (bet.status === "won") {
    const lead = legs[0];
    const who = lead?.playerName ?? lead?.teamLabel ?? "All legs";
    const why = lead?.resolvedReason ?? "covered.";
    if (legs.length === 1) return `${who} — ${why}`;
    return `All ${legs.length} legs hit. Lead: ${who} — ${why}`;
  }
  if (bet.status === "push") {
    const pushed = legs.find((l) => l.status === "push");
    if (pushed?.resolvedReason) return pushed.resolvedReason;
    return "Pushed — stake returned.";
  }
  return null;
}

/**
 * Player-prop legs on live bets: ESPN's athlete gamelog isn't real-
 * time, so we can't show in-game stats. Surface a small note so
 * the user understands why no live actual is rendered. Auto-resolves
 * via the existing resolver path once the box score lands.
 */
function LivePlayerPropNote({ bet, leg }: { bet: PaperBet; leg: PaperLeg }) {
  if (bet.betTiming !== "live") return null;
  if (leg.marketType !== "player_prop") return null;
  if (leg.status !== "open" && leg.status !== "needs_review") return null;
  return (
    <p className="text-[10px] text-muted-foreground italic flex items-center gap-1">
      <Clock className="w-3 h-3" />
      Settles when box score is published.
    </p>
  );
}

/**
 * Live status pill — only renders for open bets marked
 * bet_timing="live" AND with a non-empty live_state (i.e. the
 * tracker has polled at least once and the game is in progress).
 * Format: "LIVE — {away}–{home} {period}".
 *
 * On terminal bets the resolved_via badge takes over; on pregame
 * bets nothing renders here.
 */
function LiveStatusPill({ bet }: { bet: PaperBet }) {
  if (bet.betTiming !== "live") return null;
  if (
    bet.status !== "open"
    && bet.status !== "in_progress"
    && bet.status !== "needs_review"
  ) return null;
  const line = formatLiveStateLine(bet);
  if (!line) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700 dark:text-red-400 animate-pulse-slow">
      <Radio className="w-3 h-3" />
      LIVE — {line}
    </span>
  );
}

/**
 * "Resolved via ESPN ✓" / "Manual" badge for the bet header. Hidden
 * on still-pending bets (resolved_via is NULL until terminal).
 */
function ResolutionVia({ bet }: { bet: PaperBet }) {
  if (!bet.resolvedVia) return null;
  if (bet.resolvedVia === "espn") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
        <Check className="w-3 h-3" /> Resolved via ESPN
      </span>
    );
  }
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-muted/40 text-muted-foreground">
      Manual
    </span>
  );
}

/**
 * Per-leg status row when the resolver wrote a resolutionDiagnosis
 * but the leg isn't terminal. Distinguishes transient ("Pending —
 * game not final") from terminal ("Needs review — stat not found")
 * via isTransient(). For fixable diagnoses (unparseable_id,
 * team_label_unmatched, missing_direction, etc.) renders an action-
 * oriented headline + an "Edit bet" CTA; the CTA snapshots the bet
 * to a draft via snapshotBetAsDraft and hands the draft id to the
 * parent so the slip builder can hydrate from it.
 *
 * Hidden once the leg has a real outcome.
 */
function LegDiagnosisRow({
  leg, bet, onEditBet,
}: {
  leg: PaperLeg;
  bet: PaperBet;
  onEditBet?: (draftId: string) => void;
}) {
  const d = leg.resolutionDiagnosis as ResolutionDiagnosis | null | undefined;
  if (!d) return null;
  if (leg.status === "won" || leg.status === "lost" || leg.status === "push" || leg.status === "voided") return null;
  const transient = isTransient(d);
  const action = actionableDiagnosisCopy(d);
  // Prefer the action-oriented headline when available; fall back to
  // the short "Pending — {label}" / "Needs review — {label}" form.
  const headline = action.headline
    ? action.headline
    : `${transient ? "Pending" : "Needs review"} — ${diagnosisLabel(d)}`;
  const cls = transient
    ? "text-blue-700 dark:text-blue-400"
    : "text-amber-700 dark:text-amber-400";
  return (
    <div className="space-y-1">
      <p className={cn("text-[11px] flex items-center gap-1", cls)}>
        {transient ? <Clock className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
        {headline}
      </p>
      {action.canEdit && onEditBet ? (
        <button
          type="button"
          onClick={() => {
            const draft = snapshotBetAsDraft({
              legs: bet.legs,
              stake: bet.stake,
              notes: bet.notes ?? null,
              label: `Edit ${bet.betType} · ${new Date(bet.placedAt).toLocaleDateString()}`,
            });
            onEditBet(draft.id);
          }}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 dark:text-amber-400 hover:underline"
        >
          Edit bet →
        </button>
      ) : null}
    </div>
  );
}

// ── Helpers / sub-components ──────────────────────────────────────────

function statusTone(s: PaperBet["status"]): string {
  if (s === "won") return "border-emerald-500/40 bg-emerald-500/[0.06]";
  if (s === "lost") return "border-red-500/40 bg-red-500/[0.06]";
  if (s === "push") return "border-blue-500/40 bg-blue-500/[0.06]";
  if (s === "voided") return "border-border/60 bg-muted/30";
  if (s === "needs_review") return "border-amber-500/40 bg-amber-500/[0.06]";
  if (s === "in_progress") return "border-primary/40 bg-primary/[0.04]";
  return "border-border/60 bg-card/40";
}

function StatusBadge({ status }: { status: PaperBet["status"] }) {
  const label =
    status === "needs_review" ? "NEEDS REVIEW"
    : status === "in_progress" ? "IN PROGRESS"
    : status.toUpperCase();
  const cls =
    status === "won" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
    : status === "lost" ? "bg-red-500/15 text-red-700 dark:text-red-400"
    : status === "push" ? "bg-blue-500/15 text-blue-700 dark:text-blue-400"
    : status === "voided" ? "bg-muted text-muted-foreground"
    : status === "needs_review" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
    : status === "in_progress" ? "bg-primary/15 text-primary"
    : "bg-muted text-muted-foreground";
  return <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full", cls)}>{label}</span>;
}

function LegStatusIcon({ status }: { status: PaperLegStatus }) {
  if (status === "won") return <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (status === "lost") return <X className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />;
  if (status === "push") return <Circle className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />;
  if (status === "voided") return <Circle className="w-3.5 h-3.5 text-muted-foreground" />;
  if (status === "needs_review") return <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />;
  return <Clock className="w-3.5 h-3.5 text-muted-foreground" />;
}

function formatPnl(pnl: number): string {
  if (pnl === 0) return "$0.00";
  const sign = pnl > 0 ? "+" : "−";
  return `${sign}$${Math.abs(pnl).toFixed(2)}`;
}
