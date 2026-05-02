/**
 * Decision → Paper draft adapter.
 *
 * Phase wiring for #167: when the user hits "Track as Paper Bet" on
 * Today's Decision (Home), this module converts the underlying
 * DailyPlanCard's ValueBetCandidate legs into PaperLeg shape, snaps
 * a reason snapshot, and writes a draft via the existing drafts
 * module. Caller navigates to /paper to review + submit.
 *
 * Pure read/transform — does not place the bet, does not modify
 * the optimizer, does not write to paper_bets. The draft sits in
 * localStorage exactly like a "Save as draft" snapshot until the
 * user explicitly hits Submit paper bet.
 */

import { saveDraft, type PaperDraft } from "./drafts";
import type { TodaysDecision } from "@/lib/insights/todaysDecision";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import type { PaperLeg, PaperMarketType } from "./types";

/**
 * Map a ValueBetCandidate (Builder/optimizer shape) onto a PaperLeg
 * (paper-bets shape). Existing market types align 1:1; player-prop
 * fields (statType, line, direction) get pulled through when present.
 */
function candidateToPaperLeg(c: ValueBetCandidate): PaperLeg {
  const market: PaperMarketType =
    c.marketType === "moneyline" ? "moneyline"
    : c.marketType === "spread" ? "spread"
    : c.marketType === "total" ? "total"
    : "player_prop";

  // Direction is "over"/"under" on PaperLeg but ValueBetCandidate
  // doesn't carry a stable enum — derive from the selection label
  // when possible. Defaults to undefined for moneyline/spread.
  const labelLower = (c.selectionLabel ?? "").toLowerCase();
  const direction: "over" | "under" | undefined =
    market === "player_prop" || market === "total"
      ? labelLower.includes(" over ") ? "over"
        : labelLower.includes(" under ") ? "under"
        : undefined
      : undefined;

  // Sport string normalization — ValueBetCandidate.sport is the
  // PaperLeg sport union (NBA / WNBA / MLB / NFL / BOXING / MMA).
  const sportRaw = String(c.sport ?? "").toUpperCase();
  const sport: PaperLeg["sport"] =
    sportRaw === "NBA" || sportRaw === "WNBA" || sportRaw === "MLB"
      || sportRaw === "NFL" || sportRaw === "BOXING" || sportRaw === "MMA"
      ? sportRaw
      : "MLB"; // safe fallback; resolver will needs-review on mismatch

  // Best-effort team-abbr extraction for moneyline/spread legs.
  // ValueBetCandidate doesn't carry a structured teamAbbr — pick the
  // first 2–4 uppercase token off selectionLabel ("BOS Moneyline" →
  // "BOS"). Fails open: undefined teamLabel ends up flagged via the
  // existing team_label_unmatched diagnosis at settlement, which the
  // user can fix via Edit bet.
  let teamLabel: string | undefined;
  if (market === "moneyline" || market === "spread") {
    const m = (c.selectionLabel ?? "").trim().match(/^([A-Z]{2,4})\b/);
    if (m) teamLabel = m[1];
  }

  return {
    dkLabel:        c.selectionLabel ?? "",
    sport,
    league:         sport.toLowerCase(),
    gameId:         c.gameId ?? undefined,
    gameTimeIso:    c.gameTimeLabel ?? undefined,
    teamLabel,
    playerName:     c.playerName ?? undefined,
    playerId:       c.playerId ?? undefined,
    marketType:     market,
    statType:       c.statType ?? undefined,
    direction,
    line:           c.lineValue ?? undefined,
    americanOdds:   c.americanOdds,
    selectionLabel: c.selectionLabel ?? "",
    status:         "open",
  };
}

interface CreateArgs {
  decision: TodaysDecision;
  /** Optional override for the draft label. */
  label?: string;
  /** Default stake to seed the draft with. */
  defaultStake?: string;
}

/**
 * Create a Paper draft from a Today's Decision verdict. Returns the
 * saved draft (so the caller can hand its id to the slip builder)
 * or null when the verdict has no actionable card (SKIP, or
 * INSUFFICIENT_DATA paths).
 */
export function createDraftFromDecision(args: CreateArgs): PaperDraft | null {
  const { decision, label, defaultStake = "10" } = args;
  const card = decision.card;
  if (!card || card.legs.length === 0) return null;

  const legs = card.legs.map(candidateToPaperLeg);

  // Per-leg "why" snippets, when the optimizer surfaced them on the
  // candidate (matchupNote is the single-line reason that shows up
  // on the Bet card). Keep IDs stable so analytics can join later.
  const whyPerLeg = card.legs.map((c) => ({
    legId: c.id,
    reason: c.matchupNote ?? c.riskNote ?? "",
  })).filter((r) => r.reason);

  // Aggregate model probability — multiplied uncorrelated, same
  // proxy the slip-summary uses on the Builder side. We DO NOT
  // import correlation logic here; the snapshot is a frozen
  // approximation, not a re-scoring.
  const modelProbability = card.legs.reduce(
    (p, c) => p * Math.max(0, Math.min(1, c.modelProbability ?? 0)),
    1,
  );
  const impliedProbability = card.legs.reduce(
    (p, c) => p * Math.max(0, Math.min(1, c.impliedProbability ?? 0)),
    1,
  );
  const edgePp = Number.isFinite(modelProbability) && Number.isFinite(impliedProbability)
    ? Math.round((modelProbability - impliedProbability) * 1000) / 10
    : null;

  const draftId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const draft: PaperDraft = {
    id: draftId,
    legs,
    stake: defaultStake,
    notes: "",
    trackLive: false,
    liveScoreHome: "",
    liveScoreAway: "",
    livePeriod: "",
    liveGameClock: "",
    livePlayerStat: "",
    liveModelProb: "",
    label: label ?? `Auto-plan · ${card.tier}`,
    updatedAt: new Date().toISOString(),
    source: "auto_plan",
    reasonSnapshot: {
      whyThisSlip:      decision.reasons,
      whyPerLeg:        whyPerLeg.length ? whyPerLeg : undefined,
      modelProbability: Number.isFinite(modelProbability) ? modelProbability : null,
      edgePp,
      confidence:       decision.confidence === "—" ? null : decision.confidence,
      risk:             decision.risk === "—" ? null : decision.risk,
      tier:             card.tier,
      capturedAt:       new Date().toISOString(),
    },
  };
  saveDraft(draft);
  return draft;
}
