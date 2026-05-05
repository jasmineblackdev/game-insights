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

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, AlertTriangle, Radio, Save, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { normalizeDraftKingsLabel, americanToPayoutMultiplier, combineAmericanOdds } from "@/lib/paperBets/normalizer";
import { placePaperBet } from "@/lib/paperBets/store";
import {
  CURRENT_DRAFT_ID,
  clearCurrentDraft,
  getDraft,
  saveDraft,
  snapshotCurrentDraft,
  type PaperDraftSource,
} from "@/lib/paperBets/drafts";
import {
  resolveAthleteByName,
  resolveGameIdByTeam,
} from "@/lib/paperBets/gameIdResolver";
import { SlipSummaryCard } from "@/components/paperBets/SlipSummaryCard";
import type { PaperLeg, PaperLiveState } from "@/lib/paperBets/types";

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
  /** When set, hydrate the form from this draft id on mount. */
  loadDraftId?: string | null;
  /** Called after a draft is snapshotted (so My Slips can refresh). */
  onDraftSaved?: () => void;
}

type EntryCategory = "popular" | "player_prop" | "game" | "team" | "sgp" | "custom";

export function PaperBetEntryForm({ onPlaced, loadDraftId, onDraftSaved }: Props) {
  const [draft, setDraft] = useState<DraftLeg>(EMPTY_DRAFT);
  const [legs, setLegs] = useState<PaperLeg[]>([]);
  const [stake, setStake] = useState<string>("10");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [entryCategory, setEntryCategory] = useState<EntryCategory>("popular");

  // Live bet tracking — flips bet_timing="live" + captures game-state
  // snapshot at entry. Stored separately from pregame results so live
  // calibration stays a separate analytics surface.
  const [trackLive, setTrackLive] = useState(false);
  const [liveScoreHome, setLiveScoreHome] = useState("");
  const [liveScoreAway, setLiveScoreAway] = useState("");
  const [livePeriod, setLivePeriod] = useState("");
  const [liveGameClock, setLiveGameClock] = useState("");
  const [livePlayerStat, setLivePlayerStat] = useState("");
  const [liveModelProb, setLiveModelProb] = useState("");

  // Loaded-draft origin. "auto_plan" drafts come from Today's
  // Decision → Track as Paper Bet (#167) and need to be persisted
  // with paper_bets.source="app_recommendation_paper" so the user vs
  // system analytics split (#171) attributes them to the system.
  // Manual drafts default to undefined → "manual_draftkings_entry".
  const [draftSource, setDraftSource] = useState<PaperDraftSource | undefined>(undefined);

  // Draft restore. Prefer an explicit loadDraftId (My Slips → Edit
  // draft) over the auto-saved "current" slip. Runs once on mount.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const id = loadDraftId ?? CURRENT_DRAFT_ID;
    const d = getDraft(id);
    if (!d || d.legs.length === 0) return;
    setLegs(d.legs);
    setStake(d.stake || "10");
    setNotes(d.notes || "");
    setTrackLive(d.trackLive);
    setLiveScoreHome(d.liveScoreHome || "");
    setLiveScoreAway(d.liveScoreAway || "");
    setLivePeriod(d.livePeriod || "");
    setLiveGameClock(d.liveGameClock || "");
    setLivePlayerStat(d.livePlayerStat || "");
    setLiveModelProb(d.liveModelProb || "");
    setDraftSource(d.source);
  }, [loadDraftId]);

  // Auto-save the in-progress slip whenever legs / stake / notes /
  // live state change. Empty slip clears the draft so refresh on a
  // blank form doesn't leave a phantom draft behind.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (legs.length === 0 && !notes && stake === "10" && !trackLive) {
      clearCurrentDraft();
      return;
    }
    saveDraft({
      id: CURRENT_DRAFT_ID,
      legs,
      stake,
      notes,
      trackLive,
      liveScoreHome,
      liveScoreAway,
      livePeriod,
      liveGameClock,
      livePlayerStat,
      liveModelProb,
      // Preserve auto_plan provenance through the autosave so an
      // edit-then-submit cycle still attributes to the system.
      source: draftSource,
    });
  }, [
    legs, stake, notes, trackLive,
    liveScoreHome, liveScoreAway, livePeriod, liveGameClock, livePlayerStat, liveModelProb,
    draftSource,
  ]);

  const norm = draft.dkLabel.trim() ? normalizeDraftKingsLabel(draft.dkLabel) : null;
  const effectiveMarket = draft.marketTypeOverride !== "auto" ? draft.marketTypeOverride : norm?.marketType;
  const effectiveStat = draft.statTypeOverride || norm?.statType;
  const effectiveDir = draft.directionOverride !== "auto" ? draft.directionOverride : norm?.direction;
  const effectiveLine = draft.lineOverride !== "" ? Number(draft.lineOverride) : norm?.line;

  /** Tracks an in-flight gameId lookup so the user can see the form
   *  is busy and the Add button can disable. */
  const [resolvingGameId, setResolvingGameId] = useState(false);

  const addLeg = async () => {
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

    // Auto-resolve every system identifier on the leg so the user
    // never has to paste an ESPN id. Three lookups can fire here:
    //   1. gameId   — from (sport, team, today) via the scoreboard
    //                 endpoint. Required for the live tracker and
    //                 resolver to act on this leg post-submit.
    //   2. athleteId — from (sport, player name) via ESPN's athlete
    //                 search. Only fires for player props.
    //   3. teamLabel canonicalization — typo'd abbreviations get
    //                 snapped back to the form ESPN uses.
    let resolvedGameId      = undefined as string | undefined;
    let resolvedGameTimeIso = undefined as string | undefined;
    let resolvedTeamLabel   = draft.teamLabel.trim() || undefined;
    let resolvedPlayerId    = undefined as string | undefined;

    const teamForLookup = (draft.teamLabel ?? "").trim();
    const playerForLookup = (draft.playerName ?? "").trim();
    const isCombat = draft.sport === "BOXING" || draft.sport === "MMA";

    if ((teamForLookup || playerForLookup) && !isCombat) {
      setResolvingGameId(true);
      try {
        // Local YMD — toISOString() returns UTC, which silently
        // shifts the slate-date by a day for evening users in any
        // timezone west of UTC. A user in ET at 9:21 PM on May 4
        // would otherwise query ESPN for May 5 games and miss
        // every May-4 ET game on the slate.
        const now = new Date();
        const todayYmd = `${now.getFullYear()}-${
          String(now.getMonth() + 1).padStart(2, "0")
        }-${String(now.getDate()).padStart(2, "0")}`;

        // Athlete first when this looks like a player prop — ESPN's
        // athlete search returns the team abbr, which seeds the
        // gameId lookup when the user didn't type the team.
        let teamForGameLookup = teamForLookup;
        if (playerForLookup && (effectiveMarket === "player_prop" || entryCategory === "player_prop")) {
          const athlete = await resolveAthleteByName({
            sport: draft.sport,
            name: playerForLookup,
          });
          if (athlete) {
            resolvedPlayerId = athlete.athleteId;
            if (!teamForGameLookup && athlete.teamAbbr) {
              teamForGameLookup = athlete.teamAbbr;
              resolvedTeamLabel = athlete.teamAbbr;
            }
          }
          // Athlete miss is non-fatal — bet can still ship and the
          // resolver will surface "player not in box score" with an
          // Edit bet CTA.
        }

        if (teamForGameLookup) {
          const match = await resolveGameIdByTeam({
            sport: draft.sport,
            teamLabel: teamForGameLookup,
            dateIso: todayYmd,
          });
          if (!match) {
            toast.error(
              `No ${draft.sport} game found for "${teamForGameLookup}" today. Check the team abbreviation (e.g. TOR not TOR RAPYORS).`,
              { duration: 8000 },
            );
            return;
          }
          resolvedGameId      = match.gameId;
          resolvedGameTimeIso = match.startIso ?? undefined;
          resolvedTeamLabel   = match.matchedSide === "home" ? match.homeAbbr : match.awayAbbr;
          if (resolvedTeamLabel.toUpperCase() !== teamForGameLookup.toUpperCase()) {
            toast.message(`Matched "${teamForGameLookup}" → ${resolvedTeamLabel}`);
          }
        }
      } finally {
        setResolvingGameId(false);
      }
    }

    const leg: PaperLeg = {
      dkLabel: draft.dkLabel.trim(),
      sport: draft.sport,
      league: draft.sport.toLowerCase(),
      gameId: resolvedGameId,
      gameTimeIso: resolvedGameTimeIso,
      teamLabel: resolvedTeamLabel,
      playerName: draft.playerName.trim() || undefined,
      // Auto-resolved from ESPN athlete search; no manual input.
      playerId: resolvedPlayerId,
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
    toast.success(
      resolvedGameId && !draft.gameId.trim()
        ? `Leg added — gameId auto-linked.`
        : "Leg added to slip.",
    );
  };

  const removeLeg = (idx: number) => {
    setLegs((prev) => prev.filter((_, i) => i !== idx));
  };

  /**
   * Pull a slipped leg back into the "Add a leg" form for editing.
   * Removes it from the Draft slip; the user adjusts fields and
   * clicks "Add leg to slip" to put the corrected version back.
   *
   * Override fields are pre-populated from whatever the leg already
   * carries so the user sees the actual stored values, not the
   * normalizer's re-parse of the dkLabel. They can clear any
   * override field to fall back on the normalizer.
   */
  const editLeg = (idx: number) => {
    const l = legs[idx];
    if (!l) return;
    setDraft({
      sport: l.sport,
      gameId: l.gameId ?? "",
      gameTimeIso: l.gameTimeIso ?? "",
      teamLabel: l.teamLabel ?? "",
      playerName: l.playerName ?? "",
      playerId: l.playerId ?? "",
      dkLabel: l.dkLabel ?? "",
      americanOdds: String(l.americanOdds ?? ""),
      marketTypeOverride: l.marketType,
      statTypeOverride: l.statType ?? "",
      directionOverride: l.direction ?? "auto",
      lineOverride: l.line != null ? String(l.line) : "",
    });
    // Surface the right entry-category so the override fields stay
    // visible even when the normalizer is confident — otherwise the
    // user opens edit, sees the form populated, and the override row
    // collapses out from under them on the next keystroke.
    setEntryCategory(
      l.marketType === "player_prop" ? "player_prop" :
      l.marketType === "moneyline"   ? "team"        :
      l.marketType === "total"       ? "game"        :
      "custom",
    );
    setLegs((prev) => prev.filter((_, i) => i !== idx));
    // Scroll the user back to the form so the re-populated fields
    // are visible — otherwise the leg "disappears" and the form
    // change is invisible at the top of the page.
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    toast.message("Leg moved to editor — adjust and click Add leg to slip.");
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
      // Live state on submit is always null — the live tracker
      // (#161) polls ESPN every 60s once the bet is open and writes
      // score/period/clock to the row automatically. Manual entry of
      // these fields was removed in Paper refactor Phase A.
      const liveState: PaperLiveState | null = null;

      try {
        await placePaperBet({
          betType,
          legs,
          stake: stakeNum,
          notes: notes.trim() || undefined,
          betTiming: trackLive ? "live" : "pregame",
          liveState,
          source: draftSource === "auto_plan" ? "app_recommendation_paper" : undefined,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        toast.error(msg, { duration: 8000 });
        return;
      }
      toast.success(`Paper ${trackLive ? "LIVE " : ""}${betType} placed — $${stakeNum} risk.`);
      setLegs([]);
      setTrackLive(false);
      setLiveScoreHome("");
      setLiveScoreAway("");
      setLivePeriod("");
      setLiveGameClock("");
      setLivePlayerStat("");
      setLiveModelProb("");
      setStake("10");
      setNotes("");
      setDraftSource(undefined);
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
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-sm font-bold text-foreground">Add a leg</p>
          <div className="flex items-center gap-1 flex-wrap">
            {([
              { id: "popular",     label: "Popular",     market: "auto" },
              { id: "player_prop", label: "Player Prop", market: "player_prop" },
              { id: "game",        label: "Game",        market: "total" },
              { id: "team",        label: "Team",        market: "moneyline" },
              { id: "sgp",         label: "SGP",         market: "auto" },
              { id: "custom",      label: "Custom",      market: "auto" },
            ] as const).map(({ id, label, market }) => {
              const active = entryCategory === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setEntryCategory(id);
                    setDraft((d) => ({ ...d, marketTypeOverride: market }));
                  }}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-[11px] font-semibold transition-colors border",
                    active
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background/40 text-muted-foreground border-border/40 hover:text-foreground hover:border-border",
                  )}
                  title={
                    id === "sgp" ? "Same-game parlay — add 2+ legs sharing the same game id."
                    : id === "popular" ? "No preset — let the normalizer figure it out."
                    : id === "custom" ? "Show every override field for full control."
                    : `Preset market type to ${market}.`
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        {entryCategory === "sgp" ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-400 -mt-1">
            SGP detected at submit time when 2+ legs share the same ESPN game id — fill the Game field
            for each leg.
          </p>
        ) : null}
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
              onChange={(e) => setDraft({
                ...draft,
                dkLabel: e.target.value,
                // Reset auto-derived overrides on every label edit so
                // a stale value (e.g. user typed "25+" into stat-type
                // earlier and now changed the label to "Points") can't
                // beat the parser's fresh output. Custom-mode users can
                // re-enter overrides after the new label parses; the
                // override fields stay visible while the parser is
                // unsure or the Custom chip is active.
                marketTypeOverride: "auto",
                statTypeOverride: "",
                directionOverride: "auto",
                lineOverride: "",
              })}
              className="h-9 text-sm"
            />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Player (props)</Label>
            <Input
              type="text"
              placeholder="Aaron Judge"
              value={draft.playerName}
              onChange={(e) => setDraft({ ...draft, playerName: e.target.value })}
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
        </div>
        {/* ESPN player id and game id are no longer entered by hand —
            the form auto-resolves both from (sport, player) and
            (sport, team) via the ESPN search and scoreboard
            endpoints when the user clicks Add. */}

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

        {/* Manual overrides — auto-shown when the normalizer is unsure,
            or always shown when the user picks the "Custom" chip. */}
        {entryCategory === "custom" || (draft.dkLabel.trim() && norm && !norm.confident) ? (
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

        <Button
          onClick={addLeg}
          size="sm"
          variant="default"
          className="w-full gap-1"
          disabled={resolvingGameId}
        >
          <Plus className="w-3.5 h-3.5" />
          {resolvingGameId ? "Linking game…" : "Add leg to slip"}
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
                  onClick={() => editLeg(i)}
                  className="text-muted-foreground hover:text-foreground p-0.5"
                  aria-label="Edit leg"
                  title="Edit this leg"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
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

      {/* Track Live Bet — toggle only. Manual score/period/clock/
          player-stat fields were removed in favor of the live
          tracker (#161), which polls ESPN every 60s and writes
          live_state on the row automatically. The toggle just flips
          bet_timing="live" so analytics segments correctly. */}
      <div className={cn(
        "rounded-lg border p-3",
        trackLive ? "border-blue-500/40 bg-blue-500/[0.05]" : "border-border/40 bg-background/40",
      )}>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={trackLive}
            onChange={(e) => setTrackLive(e.target.checked)}
            className="h-4 w-4 accent-blue-500"
          />
          <Radio className={cn("w-3.5 h-3.5", trackLive ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground")} />
          <span className="text-sm font-bold text-foreground">Track Live Bet</span>
          <span className="text-[11px] text-muted-foreground">
            — game already started; live state fills automatically.
          </span>
        </label>
      </div>

      <SlipSummaryCard
        legs={legs}
        combinedOddsAmerican={combinedOdds}
        potentialPayout={potentialPayout}
        payoutMultiplier={decimalMult}
        onClearAll={() => setLegs([])}
      />

      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Paper stake ($)</Label>
        <Input
          type="text"
          inputMode="decimal"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          className="h-9 text-sm max-w-[180px]"
        />
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

      <div className="flex flex-col sm:flex-row gap-2">
        <Button
          onClick={submit}
          disabled={submitting || !legs.length}
          className="flex-1"
        >
          {submitting ? "Submitting…" : "Submit paper bet"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting || !legs.length}
          onClick={() => {
            const label = window.prompt("Name this draft:", "Untitled draft");
            if (label === null) return;
            const snap = snapshotCurrentDraft(label);
            if (snap) {
              toast.success("Saved to My Slips → Drafts");
              onDraftSaved?.();
            }
          }}
          className="sm:w-44 gap-1"
        >
          <Save className="w-3.5 h-3.5" />
          Save as draft
        </Button>
      </div>
    </div>
  );
}
