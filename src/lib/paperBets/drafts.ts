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
