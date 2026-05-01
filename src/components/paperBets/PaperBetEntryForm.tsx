/**
 * PaperBetEntryForm — manual DraftKings-style entry.
 *
 * The user types in the EXACT DraftKings selection label (e.g.
 * "Hits O/U Over 0.5"), the line, the odds, and the stake. The
 * normalizer extracts structured fields; if it can't, the form
 * exposes the dropdowns so the user can fill them by hand.
 *
 * Multi-leg parlays are built by adding legs to a "draft slip"
 * before pressing Submit. Single = 1 leg; parlay = 2+ legs;
 * SGP = 2+ legs sharing the same gameId (the form auto-detects).
 */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { normalizeDraftKingsLabel, americanToPayoutMultiplier, combineAmericanOdds } from "@/lib/paperBets/normalizer";
import { placePaperBet } from "@/lib/paperBets/store";
import type { PaperLeg } from "@/lib/paperBets/types";

const SPORTS = ["MLB", "NBA", "WNBA", "NFL", "BOXING", "MMA"] as const;
type Sport = (typeof SPORTS)[number];

interface DraftLeg {
  sport: Sport;
  gameId: string;
  gameTimeIso: string;
  teamLabel: string;
  playerName: string;
  playerId: string;
  dkLabel: string;
  americanOdds: string;
  /** Manual override fields surfaced when normalizer is unsure. */
  marketTypeOverride: "moneyline" | "spread" | "total" | "player_prop" | "auto";
  statTypeOverride: string;
  directionOverride: "over" | "under" | "auto";
  lineOverride: string;
}

const EMPTY_DRAFT: DraftLeg = {
  sport: "MLB",
  gameId: "",
  gameTimeIso: "",
  teamLabel: "",
  playerName: "",
  playerId: "",
  dkLabel: "",
  americanOdds: "",
  marketTypeOverride: "auto",
  statTypeOverride: "",
  directionOverride: "auto",
  lineOverride: "",
};

interface Props {
  onPlaced?: () => void;
}

export function PaperBetEntryForm({ onPlaced }: Props) {
  const [draft, setDraft] = useState<DraftLeg>(EMPTY_DRAFT);
  const [legs, setLegs] = useState<PaperLeg[]>([]);
  const [stake, setStake] = useState<string>("10");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const norm = draft.dkLabel.trim() ? normalizeDraftKingsLabel(draft.dkLabel) : null;
  const effectiveMarket = draft.marketTypeOverride !== "auto" ? draft.marketTypeOverride : norm?.marketType;
  const effectiveStat = draft.statTypeOverride || norm?.statType;
  const effectiveDir = draft.directionOverride !== "auto" ? draft.directionOverride : norm?.direction;
  const effectiveLine = draft.lineOverride !== "" ? Number(draft.lineOverride) : norm?.line;

  const addLeg = () => {
    if (!draft.dkLabel.trim()) {
      toast.error("Enter the DraftKings selection label.");
      return;
    }
    const odds = Number(draft.americanOdds);
    if (!Number.isFinite(odds) || odds === 0) {
      toast.error("Enter valid American odds (e.g. -159 or +150).");
      return;
    }
    if (!effectiveMarket) {
      toast.error("Could not determine market type — pick one manually.");
      return;
    }
    const leg: PaperLeg = {
      dkLabel: draft.dkLabel.trim(),
      sport: draft.sport,
      league: draft.sport.toLowerCase(),
      gameId: draft.gameId.trim() || undefined,
      gameTimeIso: draft.gameTimeIso.trim() || undefined,
      teamLabel: draft.teamLabel.trim() || undefined,
      playerName: draft.playerName.trim() || undefined,
      playerId: draft.playerId.trim() || undefined,
      marketType: effectiveMarket,
      statType: effectiveStat || undefined,
      direction: effectiveDir,
      line: Number.isFinite(effectiveLine) ? effectiveLine : undefined,
      americanOdds: odds,
      selectionLabel: draft.dkLabel.trim(),
      status: "open",
    };
    setLegs((prev) => [...prev, leg]);
    setDraft(EMPTY_DRAFT);
    toast.success("Leg added to slip.");
  };

  const removeLeg = (idx: number) => {
    setLegs((prev) => prev.filter((_, i) => i !== idx));
  };

  const submit = async () => {
    if (!legs.length) {
      toast.error("Add at least one leg.");
      return;
    }
    const stakeNum = Number(stake);
    if (!Number.isFinite(stakeNum) || stakeNum <= 0) {
      toast.error("Enter a positive paper stake.");
      return;
    }
    setSubmitting(true);
    try {
      const sameGameIds = new Set(legs.map((l) => l.gameId).filter(Boolean));
      const betType: "single" | "parlay" | "sgp" =
        legs.length === 1 ? "single"
        : sameGameIds.size === 1 && legs.length >= 2 ? "sgp"
        : "parlay";
      try {
        await placePaperBet({
          betType,
          legs,
          stake: stakeNum,
          notes: notes.trim() || undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        // Migration-missing case: surface the actionable message + the
        // banner on the page already tells them to apply the migration.
        toast.error(msg, { duration: 8000 });
        return;
      }
      toast.success(`Paper ${betType} placed — $${stakeNum} risk.`);
      setLegs([]);
      setStake("10");
      setNotes("");
      onPlaced?.();
    } finally {
      setSubmitting(false);
    }
  };

  // Live preview math
  const stakeNum = Number(stake);
  const validStake = Number.isFinite(stakeNum) && stakeNum > 0;
  const combinedOdds = legs.length ? combineAmericanOdds(legs.map((l) => l.americanOdds)) : 0;
  const decimalMult = legs.reduce((m, l) => m * americanToPayoutMultiplier(l.americanOdds), 1);
  const potentialPayout = validStake && legs.length ? Math.round(stakeNum * decimalMult * 100) / 100 : 0;

  return (
    <div className="rounded-xl border border-border/60 bg-card/50 p-4 sm:p-5 space-y-4">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 font-bold">PAPER MODE</span>
        <span className="text-muted-foreground">Fake money only — no DraftKings connection.</span>
      </div>

      {/* Single-leg draft form */}
      <div className="space-y-3 rounded-lg border border-border/40 bg-background/40 p-3">
        <p className="text-sm font-bold text-foreground">Add a leg</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Sport</Label>
            <select
              value={draft.sport}
              onChange={(e) => setDraft({ ...draft, sport: e.target.value as Sport })}
              className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
            >
              {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">American odds</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="-159"
              value={draft.americanOdds}
              onChange={(e) => setDraft({ ...draft, americanOdds: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">DraftKings selection (verbatim)</Label>
            <Input
              type="text"
              placeholder="e.g. Aaron Judge — Total Bases Over 1.5"
              value={draft.dkLabel}
              onChange={(e) => setDraft({ ...draft, dkLabel: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Player name (props)</Label>
            <Input
              type="text"
              placeholder="Aaron Judge"
              value={draft.playerName}
              onChange={(e) => setDraft({ ...draft, playerName: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">ESPN player id (optional)</Label>
            <Input
              type="text"
              placeholder="33192"
              value={draft.playerId}
              onChange={(e) => setDraft({ ...draft, playerId: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Team (team bets)</Label>
            <Input
              type="text"
              placeholder="BOS"
              value={draft.teamLabel}
              onChange={(e) => setDraft({ ...draft, teamLabel: e.target.value.toUpperCase() })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">ESPN game id (optional)</Label>
            <Input
              type="text"
              placeholder="401570123"
              value={draft.gameId}
              onChange={(e) => setDraft({ ...draft, gameId: e.target.value })}
              className="h-9 text-sm"
            />
          </div>
        </div>

        {/* Normalizer preview / overrides */}
        {draft.dkLabel.trim() ? (
          <div className={cn(
            "rounded-md border px-3 py-2 text-[11px] flex items-start gap-2",
            norm?.confident
              ? "border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-400"
              : "border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400",
          )}>
            {norm?.confident ? null : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className="font-semibold">
                Parsed: {effectiveMarket ?? "—"}
                {effectiveStat ? ` · ${effectiveStat}` : ""}
                {effectiveDir ? ` · ${effectiveDir}` : ""}
                {effectiveLine != null ? ` ${effectiveLine}` : ""}
              </p>
              {!norm?.confident && norm?.note ? (
                <p className="opacity-80">{norm.note}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Manual overrides */}
        {draft.dkLabel.trim() && norm && !norm.confident ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Market</Label>
              <select
                value={draft.marketTypeOverride}
                onChange={(e) => setDraft({ ...draft, marketTypeOverride: e.target.value as DraftLeg["marketTypeOverride"] })}
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="auto">auto</option>
                <option value="moneyline">moneyline</option>
                <option value="spread">spread</option>
                <option value="total">total</option>
                <option value="player_prop">player_prop</option>
              </select>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Stat type</Label>
              <Input
                placeholder="hits, total_bases, points"
                value={draft.statTypeOverride}
                onChange={(e) => setDraft({ ...draft, statTypeOverride: e.target.value })}
                className="h-9 text-sm"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Direction</Label>
              <select
                value={draft.directionOverride}
                onChange={(e) => setDraft({ ...draft, directionOverride: e.target.value as DraftLeg["directionOverride"] })}
                className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
              >
                <option value="auto">auto</option>
                <option value="over">over</option>
                <option value="under">under</option>
              </select>
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Line</Label>
              <Input
                placeholder="0.5"
                value={draft.lineOverride}
                onChange={(e) => setDraft({ ...draft, lineOverride: e.target.value })}
                className="h-9 text-sm"
              />
            </div>
          </div>
        ) : null}

        <Button onClick={addLeg} size="sm" variant="default" className="w-full gap-1">
          <Plus className="w-3.5 h-3.5" />
          Add leg to slip
        </Button>
      </div>

      {/* Draft slip */}
      {legs.length ? (
        <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-3 space-y-2">
          <p className="text-sm font-bold text-foreground">
            Draft slip ({legs.length} leg{legs.length === 1 ? "" : "s"})
          </p>
          <ul className="space-y-1.5 text-xs">
            {legs.map((l, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-[10px] uppercase font-bold text-muted-foreground w-8">{l.sport}</span>
                <span className="flex-1 min-w-0 truncate text-foreground">{l.dkLabel}</span>
                <span className="font-mono tabular-nums text-foreground">{l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}</span>
                <button
                  type="button"
                  onClick={() => removeLeg(i)}
                  className="text-muted-foreground hover:text-destructive p-0.5"
                  aria-label="Remove leg"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div>
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Paper stake ($)</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Combined odds</Label>
          <div className="h-9 flex items-center px-2 text-sm font-mono tabular-nums text-foreground rounded-md border border-border/40 bg-muted/30">
            {legs.length ? (combinedOdds > 0 ? `+${combinedOdds}` : combinedOdds) : "—"}
          </div>
        </div>
        <div>
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Potential payout</Label>
          <div className="h-9 flex items-center px-2 text-sm font-mono tabular-nums text-foreground rounded-md border border-border/40 bg-muted/30">
            {potentialPayout > 0 ? `$${potentialPayout.toFixed(2)}` : "—"}
          </div>
        </div>
      </div>

      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Notes (optional)</Label>
        <Textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What were you testing with this paper bet?"
          className="text-sm resize-none"
        />
      </div>

      <Button
        onClick={submit}
        disabled={submitting || !legs.length}
        className="w-full"
      >
        {submitting ? "Submitting…" : "Submit paper bet"}
      </Button>
    </div>
  );
}
