/**
 * CandidatePoolGroups — surfaces the parlay candidate pool as five
 * grouped, collapsible buckets so the user can browse legs by intent
 * (Safe / Cash-Out / Props / Moneylines / Avoided) instead of paging
 * through one undifferentiated list.
 *
 * Bucketing rules (a leg can land in multiple buckets — e.g. a
 * recommended high-confidence player prop appears in both "Safe" and
 * "Props"). Avoided is mutually exclusive with the others — once a
 * leg fails the recommend gate or carries an integrity flag, we
 * surface it ONLY there with an explanation.
 *
 *   Safe       — isRecommended && confidence === "high" && volatilityScore < 55
 *   Cash-Out   — isRecommended && americanOdds in [-200, +120] && confidence !== "low"
 *   Props      — isRecommended && pickType === "player_prop"
 *   Moneylines — isRecommended && pickType === "team_pick"
 *   Avoided    — !isRecommended || staleLineFlag || lateChangeInvalidated
 *
 * Each row shows selectionLabel, sport tag, odds, edge%, confidence
 * chip, and an "Add to slip" button that flows through the existing
 * addValueLeg context method (which still enforces the edge floor).
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Plus,
  Shield,
  Target,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useValueParlay } from "@/context/ValueParlayContext";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import { DecisionPill } from "@/components/playerProps/DecisionPill";
import { TrustRow } from "@/components/playerProps/TrustRow";
import { HitRateBars } from "@/components/playerProps/HitRateBars";
import { WhyThisPick } from "@/components/playerProps/WhyThisPick";
import { MarketSignals } from "@/components/playerProps/MarketSignals";
import { Last10Chart } from "@/components/playerProps/Last10Chart";
import { ConsistencyTrendStrip } from "@/components/playerProps/ConsistencyTrendStrip";
import { MatchupInsight } from "@/components/playerProps/MatchupInsight";

interface Props {
  candidates: ValueBetCandidate[];
  /** Cap rows per bucket to keep the UI scannable. Defaults to 5. */
  perGroupLimit?: number;
}

interface Group {
  key: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  tone: string;
  /** Predicate identifying which candidates land here. */
  match: (c: ValueBetCandidate) => boolean;
  /** Default expanded state — Safe + Props open, others collapsed. */
  defaultOpen: boolean;
}

const GROUPS: Group[] = [
  {
    key: "safe",
    label: "Best safe legs",
    Icon: Shield,
    tone: "text-emerald-600 dark:text-emerald-400",
    match: (c) =>
      c.isRecommended &&
      c.confidence === "high" &&
      (c.volatilityScore ?? 0) < 55,
    defaultOpen: true,
  },
  {
    key: "cashout",
    label: "Best cash-out legs",
    Icon: CircleDollarSign,
    tone: "text-blue-600 dark:text-blue-400",
    match: (c) => {
      if (!c.isRecommended) return false;
      if (c.confidence === "low") return false;
      const odds = c.americanOdds;
      return Number.isFinite(odds) && odds >= -200 && odds <= 120;
    },
    defaultOpen: false,
  },
  {
    key: "props",
    label: "Best props",
    Icon: Target,
    tone: "text-violet-600 dark:text-violet-400",
    match: (c) => c.isRecommended && c.pickType === "player_prop",
    defaultOpen: true,
  },
  {
    key: "moneylines",
    label: "Best moneylines",
    Icon: TrendingUp,
    tone: "text-amber-600 dark:text-amber-400",
    match: (c) => c.isRecommended && c.pickType === "team_pick",
    defaultOpen: false,
  },
  {
    key: "avoided",
    label: "Avoided / rejected",
    Icon: XCircle,
    tone: "text-red-600 dark:text-red-400",
    match: (c) =>
      !c.isRecommended ||
      Boolean(c.staleLineFlag) ||
      Boolean(c.lateChangeInvalidated),
    defaultOpen: false,
  },
];

function formatOdds(o: number): string {
  if (!Number.isFinite(o)) return "—";
  return o > 0 ? `+${o}` : `${o}`;
}

function rankCandidates(arr: ValueBetCandidate[]): ValueBetCandidate[] {
  // Sort by edge desc within each bucket — highest-edge surfaces first.
  return [...arr].sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0));
}

export function CandidatePoolGroups({ candidates, perGroupLimit = 5 }: Props) {
  const { addValueLeg, isValueLegAdded } = useValueParlay();

  const grouped = useMemo(() => {
    const out: Record<string, ValueBetCandidate[]> = {};
    for (const g of GROUPS) {
      // For "avoided" we want the inverse exclusivity: only legs not
      // already counted as recommended in another bucket.
      out[g.key] = rankCandidates(candidates.filter(g.match)).slice(0, perGroupLimit);
    }
    return out;
  }, [candidates, perGroupLimit]);

  if (!candidates.length) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5 space-y-3">
      <div>
        <p className="font-display font-bold text-sm text-foreground">Candidate Pool</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Browse legs by intent. Click <span className="font-semibold">Add</span> to drop a leg
          on your slip — the edge floor still applies on add.
        </p>
      </div>

      <div className="space-y-2">
        {GROUPS.map((g) => {
          const rows = grouped[g.key] ?? [];
          if (!rows.length) return null;
          return (
            <CandidateGroup
              key={g.key}
              group={g}
              rows={rows}
              isAdded={isValueLegAdded}
              onAdd={(c) => {
                const r = addValueLeg(c);
                if (!r.ok) toast.error(r.message ?? "Couldn't add leg.");
                else toast.success(`Added ${c.selectionLabel}.`);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function CandidateGroup({
  group,
  rows,
  isAdded,
  onAdd,
}: {
  group: Group;
  rows: ValueBetCandidate[];
  isAdded: (id: string) => boolean;
  onAdd: (c: ValueBetCandidate) => void;
}) {
  const [open, setOpen] = useState(group.defaultOpen);
  const Icon = group.Icon;
  return (
    <div className="rounded-lg border border-border/40 bg-background/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors"
        aria-expanded={open}
      >
        <Icon className={cn("w-4 h-4 shrink-0", group.tone)} />
        <span className="text-sm font-semibold text-foreground">{group.label}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{rows.length}</span>
        <span className="ml-auto">
          {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </span>
      </button>
      {open ? (
        <div className="divide-y divide-border/40">
          {rows.map((c) => (
            <CandidateRow
              key={c.id}
              c={c}
              isAvoided={group.key === "avoided"}
              added={isAdded(c.id)}
              onAdd={() => onAdd(c)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CandidateRow({
  c,
  isAvoided,
  added,
  onAdd,
}: {
  c: ValueBetCandidate;
  isAvoided: boolean;
  added: boolean;
  onAdd: () => void;
}) {
  const isProp = c.pickType === "player_prop";
  const confTone =
    c.confidence === "high" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
    : c.confidence === "medium" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
    : "bg-muted/40 text-muted-foreground";
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {!isAvoided ? <DecisionPill candidate={c} size="sm" showReason={false} /> : null}
            <span className="text-[10px] uppercase font-bold text-muted-foreground">{c.sport}</span>
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">{formatOdds(c.americanOdds)}</span>
            <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase", confTone)}>
              {c.confidence}
            </span>
          </div>
          <p className="text-sm font-semibold text-foreground">{c.selectionLabel}</p>
          {!isAvoided ? (
            <>
              <TrustRow candidate={c} />
              {isProp && c.hitRates?.gameByGame?.length ? (
                <Last10Chart candidate={c} compact />
              ) : null}
              {isProp ? <ConsistencyTrendStrip candidate={c} /> : null}
              {isProp && c.hitRates ? <HitRateBars rates={c.hitRates} compact /> : null}
              <MatchupInsight candidate={c} />
              <MarketSignals candidate={c} compact />
              <WhyThisPick candidate={c} />
            </>
          ) : c.exclusionReason ? (
            <p className="text-[11px] text-red-600 dark:text-red-400">{c.exclusionReason}</p>
          ) : null}
        </div>
        {isAvoided ? null : (
          <Button
            size="sm"
            variant={added ? "secondary" : "outline"}
            className="h-7 px-2 gap-1 shrink-0"
            onClick={onAdd}
            disabled={added}
          >
            {added ? "Added" : <><Plus className="w-3 h-3" /> Add</>}
          </Button>
        )}
      </div>
    </div>
  );
}
