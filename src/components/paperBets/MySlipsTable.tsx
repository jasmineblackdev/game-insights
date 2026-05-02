/**
 * My Slips — unified tabular view of Drafts (localStorage) plus Open
 * and Settled paper bets (Supabase). Lets the user navigate between
 * subtabs (All / Drafts / Open / Settled) without leaving the Paper
 * surface.
 *
 * Drafts are local-only and never persist to Supabase until submitted.
 * Drafts remain editable: clicking "Edit" loads the draft back into
 * the slip builder so the user can tweak and submit.
 */

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Filter, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listDrafts, deleteDraft, type PaperDraft } from "@/lib/paperBets/drafts";
import { combineAmericanOdds, americanToPayoutMultiplier } from "@/lib/paperBets/normalizer";
import type { PaperBet } from "@/lib/paperBets/types";

type SubTab = "all" | "drafts" | "open" | "settled";

interface Props {
  bets: PaperBet[];
  onEditDraft: (id: string) => void;
  onNewSlip: () => void;
  onChange?: () => void;
  /** Initial subtab — used by deep links from Today's Decision. */
  defaultSubtab?: SubTab;
}

interface Row {
  kind: "draft" | "bet";
  key: string;
  label: string;
  status: string;
  legCount: number;
  combinedOdds: number;
  stake: number | null;
  payout: number | null;
  actionedAt: string;
  raw: PaperDraft | PaperBet;
}

export function MySlipsTable({ bets, onEditDraft, onNewSlip, onChange, defaultSubtab }: Props) {
  const [subtab, setSubtab] = useState<SubTab>(defaultSubtab ?? "all");
  const [draftsTick, setDraftsTick] = useState(0);

  const drafts = useMemo(() => {
    // Hide the auto-saved "current" draft from My Slips — it's
    // shown in the slip builder itself. Only named snapshots show up.
    return listDrafts().filter((d) => d.id !== "current");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftsTick, bets.length]);

  const open = useMemo(
    () => bets.filter((b) => b.status === "open" || b.status === "in_progress" || b.status === "needs_review"),
    [bets],
  );
  const settled = useMemo(
    () => bets.filter((b) => b.status === "won" || b.status === "lost" || b.status === "push" || b.status === "voided"),
    [bets],
  );

  const draftRows: Row[] = drafts.map((d) => ({
    kind: "draft",
    key: `draft-${d.id}`,
    label: d.label || "Untitled draft",
    status: "draft",
    legCount: d.legs.length,
    combinedOdds: d.legs.length ? combineAmericanOdds(d.legs.map((l) => l.americanOdds)) : 0,
    stake: Number(d.stake) || null,
    payout:
      d.legs.length && Number(d.stake)
        ? Math.round(Number(d.stake) * d.legs.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1) * 100) / 100
        : null,
    actionedAt: d.updatedAt,
    raw: d,
  }));

  const betRows: Row[] = bets.map((b) => ({
    kind: "bet",
    key: `bet-${b.id}`,
    label: b.legs[0]?.dkLabel
      ? `${b.legs[0].dkLabel}${b.legs.length > 1 ? ` +${b.legs.length - 1}` : ""}`
      : `${b.betType} · ${b.legs.length} leg${b.legs.length === 1 ? "" : "s"}`,
    status: b.status,
    legCount: b.legs.length,
    combinedOdds: b.combinedOddsAmerican,
    stake: b.stake,
    payout: b.potentialPayout,
    actionedAt: b.resolvedAt ?? b.placedAt,
    raw: b,
  }));

  const allRows = [...draftRows, ...betRows].sort((a, b) =>
    a.actionedAt < b.actionedAt ? 1 : -1,
  );

  const visible: Row[] =
    subtab === "drafts"  ? draftRows
    : subtab === "open"  ? betRows.filter((r) => open.some((b) => b.id === (r.raw as PaperBet).id))
    : subtab === "settled" ? betRows.filter((r) => settled.some((b) => b.id === (r.raw as PaperBet).id))
    : allRows;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Drafts are stored locally in this browser. Open and settled bets sync from Supabase.
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled className="gap-1 cursor-not-allowed opacity-60">
            <Filter className="w-3.5 h-3.5" />
            Filters
          </Button>
          <Button size="sm" onClick={onNewSlip} className="gap-1">
            <Plus className="w-3.5 h-3.5" />
            New slip
          </Button>
        </div>
      </div>

      <div className="inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5 flex-wrap">
        <SubTabPill active={subtab === "all"}      onClick={() => setSubtab("all")}      label={`All (${allRows.length})`} />
        <SubTabPill active={subtab === "drafts"}   onClick={() => setSubtab("drafts")}   label={`Drafts (${drafts.length})`} />
        <SubTabPill active={subtab === "open"}     onClick={() => setSubtab("open")}     label={`Open (${open.length})`} />
        <SubTabPill active={subtab === "settled"}  onClick={() => setSubtab("settled")}  label={`Settled (${settled.length})`} />
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-6 text-center">
          {subtab === "drafts"
            ? "No saved drafts. Build a slip and click \"Save as draft\" to keep it here."
            : subtab === "open"
              ? "No open paper bets."
              : subtab === "settled"
                ? "No settled paper bets yet."
                : "No slips yet."
          }
        </p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card/40 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Slip</th>
                <th className="text-left px-2 py-2 font-semibold">Status</th>
                <th className="text-right px-2 py-2 font-semibold">Legs</th>
                <th className="text-right px-2 py-2 font-semibold">Odds</th>
                <th className="text-right px-2 py-2 font-semibold">Stake</th>
                <th className="text-right px-2 py-2 font-semibold">Payout</th>
                <th className="text-right px-3 py-2 font-semibold">Actioned</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                // Auto-plan-source drafts get a small badge + the
                // first reason line so the user immediately sees
                // "this came from Today's Decision, here's why".
                const isAutoPlan = row.kind === "draft"
                  && (row.raw as PaperDraft).source === "auto_plan";
                const firstReason = isAutoPlan
                  ? (row.raw as PaperDraft).reasonSnapshot?.whyThisSlip?.[0]
                  : undefined;
                return (
                <tr key={row.key} className="border-t border-border/40 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2 max-w-[260px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-foreground font-semibold truncate">{row.label}</p>
                      {isAutoPlan ? (
                        <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary uppercase tracking-wide">
                          <Sparkles className="w-2.5 h-2.5" />
                          Auto-plan
                        </span>
                      ) : null}
                    </div>
                    {firstReason ? (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5" title={firstReason}>
                        {firstReason}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-foreground">{row.legCount}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-foreground font-mono">
                    {row.combinedOdds
                      ? row.combinedOdds > 0
                        ? `+${row.combinedOdds}`
                        : `${row.combinedOdds}`
                      : "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-foreground">
                    {row.stake != null ? `$${row.stake.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums text-foreground">
                    {row.payout != null && row.payout > 0 ? `$${row.payout.toFixed(2)}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
                    {formatActioned(row.actionedAt)}
                    {row.kind === "draft" ? (
                      <span className="ml-2 inline-flex items-center gap-1">
                        <button
                          type="button"
                          aria-label="Edit draft"
                          className="text-primary hover:opacity-80"
                          onClick={() => onEditDraft((row.raw as PaperDraft).id)}
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete draft"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (!window.confirm(`Delete draft "${row.label}"?`)) return;
                            deleteDraft((row.raw as PaperDraft).id);
                            setDraftsTick((n) => n + 1);
                            toast.success("Draft deleted.");
                            onChange?.();
                          }}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </span>
                    ) : null}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SubTabPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft:        { label: "Draft",         cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
    open:         { label: "Open",          cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
    in_progress:  { label: "In progress",   cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
    needs_review: { label: "Needs review",  cls: "bg-amber-500/20 text-amber-700 dark:text-amber-400" },
    won:          { label: "Settled · Win", cls: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400" },
    lost:         { label: "Settled · Loss", cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
    push:         { label: "Settled · Push", cls: "bg-muted text-foreground" },
    voided:       { label: "Voided",         cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status] ?? { label: status, cls: "bg-muted text-foreground" };
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap", m.cls)}>
      {m.label}
    </span>
  );
}

function formatActioned(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}
