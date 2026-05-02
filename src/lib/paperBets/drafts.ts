/**
 * Paper Bets drafts — localStorage-backed slip persistence.
 *
 * The slip-builder form auto-saves whatever the user is currently
 * typing into a single "current" draft so a refresh, tab close, or
 * route change doesn't wipe progress. The user can also explicitly
 * snapshot the current slip into a named draft (id !== "current") to
 * keep multiple ideas in flight.
 *
 * Storage key: gamelens-paper-drafts-v1. Versioned so future schema
 * changes can read-and-discard rather than crashing.
 *
 * Server side: drafts are deliberately local-only — they're not yet
 * placed bets and have no bankroll impact. When the user submits,
 * `placePaperBet` writes to Supabase and we delete the draft.
 */

import type { PaperLeg } from "./types";

const STORAGE_KEY = "gamelens-paper-drafts-v1";
const STORAGE_VERSION = 1;

export const CURRENT_DRAFT_ID = "current" as const;

/**
 * Where a draft came from. Used to attribute auto-generated drafts
 * (e.g. Today's Decision → "Track as Paper Bet") so analytics can
 * compare auto-plan ROI against manual user entries downstream.
 */
export type PaperDraftSource = "manual" | "auto_plan";

/**
 * Frozen snapshot of the reasoning that led to an auto-plan draft —
 * the model probability, edge, confidence, risk, and the
 * why-this-pick lines surfaced on Home. Captured at draft creation
 * so later analysis can compare model reasoning against actual
 * outcome without re-running the pipeline.
 */
export interface PaperDraftReasonSnapshot {
  /** The "why this slip" lines surfaced on Today's Decision card. */
  whyThisSlip: string[];
  /** Per-leg headline reason, when known. */
  whyPerLeg?: Array<{ legId: string; reason: string }>;
  /** Aggregate model probability for the slip (uncorrelated). */
  modelProbability: number | null;
  /** Aggregate edge in pp (modelProb − impliedProb). */
  edgePp: number | null;
  /** Coarse confidence label from the verdict. */
  confidence: "HIGH" | "MED" | "LOW" | null;
  /** Coarse risk label from the verdict. */
  risk: "Low" | "Medium" | "High" | null;
  /** Daily-plan tier (primary | balanced | upside) when present. */
  tier?: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
}

export interface PaperDraft {
  id: string;
  /** "current" for the auto-saved in-progress slip, or a uuid for snapshots. */
  legs: PaperLeg[];
  stake: string;
  notes: string;
  trackLive: boolean;
  liveScoreHome: string;
  liveScoreAway: string;
  livePeriod: string;
  liveGameClock: string;
  livePlayerStat: string;
  liveModelProb: string;
  /** Display label — defaults to "Untitled draft" when not set. */
  label?: string;
  /** ISO timestamp of the most recent update. */
  updatedAt: string;
  /**
   * "manual" for user-typed drafts; "auto_plan" for drafts created
   * by Today's Decision → Track as Paper Bet. Defaults to "manual"
   * when omitted (back-compat with pre-#167 drafts).
   */
  source?: PaperDraftSource;
  /**
   * Reason payload captured at the moment the draft was created.
   * Read-only — the entry form preserves this on every save so the
   * snapshot follows the slip into placePaperBet.
   */
  reasonSnapshot?: PaperDraftReasonSnapshot;
}

interface StorageShape {
  version: number;
  drafts: PaperDraft[];
}

function readShape(): StorageShape {
  if (typeof window === "undefined") return { version: STORAGE_VERSION, drafts: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: STORAGE_VERSION, drafts: [] };
    const parsed = JSON.parse(raw) as StorageShape;
    if (parsed.version !== STORAGE_VERSION) return { version: STORAGE_VERSION, drafts: [] };
    if (!Array.isArray(parsed.drafts)) return { version: STORAGE_VERSION, drafts: [] };
    return parsed;
  } catch {
    return { version: STORAGE_VERSION, drafts: [] };
  }
}

function writeShape(shape: StorageShape): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    /* quota exceeded or denied — silently ignore */
  }
}

export function listDrafts(): PaperDraft[] {
  return readShape()
    .drafts
    .slice()
    .sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
}

export function getCurrentDraft(): PaperDraft | null {
  return readShape().drafts.find((d) => d.id === CURRENT_DRAFT_ID) ?? null;
}

export function getDraft(id: string): PaperDraft | null {
  return readShape().drafts.find((d) => d.id === id) ?? null;
}

export function saveDraft(draft: Omit<PaperDraft, "updatedAt"> & { updatedAt?: string }): void {
  const shape = readShape();
  const updatedAt = draft.updatedAt ?? new Date().toISOString();
  const idx = shape.drafts.findIndex((d) => d.id === draft.id);
  if (idx >= 0) {
    shape.drafts[idx] = { ...draft, updatedAt };
  } else {
    shape.drafts.push({ ...draft, updatedAt });
  }
  writeShape(shape);
}

export function deleteDraft(id: string): void {
  const shape = readShape();
  shape.drafts = shape.drafts.filter((d) => d.id !== id);
  writeShape(shape);
}

export function clearCurrentDraft(): void {
  deleteDraft(CURRENT_DRAFT_ID);
}

/** Promote the current auto-saved draft to a named snapshot. */
export function snapshotCurrentDraft(label: string): PaperDraft | null {
  const cur = getCurrentDraft();
  if (!cur || cur.legs.length === 0) return null;
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const snap: PaperDraft = {
    ...cur,
    id,
    label: label.trim() || "Untitled draft",
    updatedAt: new Date().toISOString(),
  };
  saveDraft(snap);
  return snap;
}

/** Coarse "is this draft non-empty enough to display?" check. */
export function draftHasContent(draft: PaperDraft): boolean {
  return draft.legs.length > 0;
}

/**
 * Convert the in-app parlay slip (ValueBetCandidate shape) into a
 * paper draft. Used by the slip drawer's "Save as Paper Bet" action
 * — the slip is a staging area, the draft is the persistent record,
 * Paper is where settlement happens. No bankroll impact until the
 * user submits the draft.
 *
 * The legs come in as the optimizer's ValueBetCandidate shape; we
 * translate to PaperLeg here so the slip drawer doesn't need to
 * import the paper types.
 *
 * source defaults to "ai_parlay" since the slip is populated by the
 * recommendation surfaces (Auto Profit, Daily Plan, builder). When
 * the user manually composes a slip the source is still "ai_parlay"
 * because the picks themselves are AI-generated — the manual entry
 * path lives in PaperBetEntryForm.
 */
export interface SlipDraftInput {
  /** Loose subset of ValueBetCandidate — only what we translate. */
  legs: Array<{
    selectionLabel: string;
    sport: string;
    gameId?: string;
    marketType: "moneyline" | "spread" | "total" | "player_prop";
    statType?: string;
    lineValue?: number;
    americanOdds: number;
    playerName?: string;
    playerId?: string;
    teamId?: string;
  }>;
  /** Optional label — defaults to "Saved from slip · {N} legs". */
  label?: string;
  /** When true, persists trackLive=true so the entry form opens with
   *  the live tracker pre-armed. Caller flips this from the toggle. */
  trackLive?: boolean;
  /**
   * Slip-level reasoning snapshot for the learning capture layer.
   * Optional — caller passes whatever the optimizer surfaced.
   */
  reason?: PaperDraftReasonSnapshot;
}

/**
 * Parse the over/under direction out of a selection label like
 * "Aaron Judge Over 1.5 Total Bases". Returns undefined for team
 * markets where direction doesn't apply.
 */
function parseDirection(label: string): "over" | "under" | undefined {
  const m = /\b(over|under)\b/i.exec(label);
  if (!m) return undefined;
  return m[1].toLowerCase() as "over" | "under";
}

export function createSlipDraft(input: SlipDraftInput): PaperDraft {
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const legs: PaperLeg[] = input.legs.map((l) => {
    const sportUpper = String(l.sport).toUpperCase();
    // PaperLeg.sport accepts a fixed union — normalize by mapping
    // common league strings. Fall back to MLB if unknown so the
    // shape is valid (the user can always edit before submitting).
    const sport: PaperLeg["sport"] =
      sportUpper === "NFL" || sportUpper === "NBA" || sportUpper === "WNBA"
        || sportUpper === "MLB" || sportUpper === "BOXING" || sportUpper === "MMA"
        ? (sportUpper as PaperLeg["sport"])
        : "MLB";
    return {
      dkLabel:        l.selectionLabel,
      sport,
      league:         String(l.sport).toLowerCase(),
      gameId:         l.gameId,
      teamLabel:      l.teamId,
      playerName:     l.playerName,
      playerId:       l.playerId,
      marketType:     l.marketType,
      statType:       l.statType,
      direction:      parseDirection(l.selectionLabel),
      line:           l.lineValue,
      americanOdds:   l.americanOdds,
      selectionLabel: l.selectionLabel,
      status:         "open",
    };
  });
  const draft: PaperDraft = {
    id,
    legs,
    stake:           "10",
    notes:           "",
    trackLive:       input.trackLive ?? false,
    liveScoreHome:   "",
    liveScoreAway:   "",
    livePeriod:      "",
    liveGameClock:   "",
    livePlayerStat:  "",
    liveModelProb:   "",
    label:           input.label ?? `Saved from slip · ${legs.length} leg${legs.length === 1 ? "" : "s"}`,
    updatedAt:       new Date().toISOString(),
    source:          "auto_plan",
    reasonSnapshot:  input.reason,
  };
  saveDraft(draft);
  return draft;
}

/**
 * Convert a placed paper bet's data into a fresh draft so the user
 * can edit malformed fields (game id, team abbr, etc.) and resubmit.
 * The original bet is left in place — caller decides whether to
 * void it after the user submits the corrected version.
 *
 * Used by the "Edit bet" CTA on PaperBetCard when a leg's
 * resolution_diagnosis points at a fixable problem.
 */
export function snapshotBetAsDraft(args: {
  legs: PaperDraft["legs"];
  stake: number;
  notes: string | null;
  label?: string;
}): PaperDraft {
  const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const draft: PaperDraft = {
    id,
    legs: args.legs,
    stake: String(args.stake ?? "10"),
    notes: args.notes ?? "",
    trackLive: false,
    liveScoreHome: "",
    liveScoreAway: "",
    livePeriod: "",
    liveGameClock: "",
    livePlayerStat: "",
    liveModelProb: "",
    label: args.label ?? "Edited from open bet",
    updatedAt: new Date().toISOString(),
  };
  saveDraft(draft);
  return draft;
}
