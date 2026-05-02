/**
 * Single source of truth for resolution-diagnosis taxonomy.
 *
 * Both resolvers (`aggressivePendingResolver` for recommended parlays,
 * `paperBets/resolver` for paper bets) write a `resolution_diagnosis`
 * value into each leg's JSONB when settlement can't proceed. The UI
 * reads that field to render human-friendly status copy and to
 * decide whether a bet shows a "Retry" affordance.
 *
 * Hard rule: if the resolver can't *verify* the leg outcome, it must
 * write a diagnosis and leave the leg open / mark the bet
 * needs_review — never guess.
 */

export type ResolutionDiagnosis =
  /** Game still in pre/in state (not "post"). Try again later. */
  | "game_not_final"
  /** Game is final but ESPN box score is missing or empty. */
  | "box_score_missing"
  /** Leg id is malformed or pre-dates the canonical id schema. */
  | "unparseable_id"
  /** Stat type isn't mapped to ESPN box-score columns. */
  | "stat_type_unsupported"
  /** Team label on the leg doesn't match either team in the game. */
  | "team_label_unmatched"
  /** Leg lacks a numeric direction needed to evaluate the line. */
  | "missing_direction"
  /** Player exists in the leg but no row matched in the box score. */
  | "player_not_in_box_score";

export const RESOLUTION_DIAGNOSES: readonly ResolutionDiagnosis[] = [
  "game_not_final",
  "box_score_missing",
  "unparseable_id",
  "stat_type_unsupported",
  "team_label_unmatched",
  "missing_direction",
  "player_not_in_box_score",
];

export function isResolutionDiagnosis(v: unknown): v is ResolutionDiagnosis {
  return typeof v === "string" && (RESOLUTION_DIAGNOSES as readonly string[]).includes(v);
}

/**
 * Human-friendly label for the UI status row. Kept short — these are
 * read inline next to the bet/leg label.
 */
export function diagnosisLabel(d: ResolutionDiagnosis | null | undefined): string {
  switch (d) {
    case "game_not_final":          return "game not final";
    case "box_score_missing":       return "box score missing";
    case "unparseable_id":          return "id not parseable";
    case "stat_type_unsupported":   return "stat type unsupported";
    case "team_label_unmatched":    return "team label not matched";
    case "missing_direction":       return "missing direction";
    case "player_not_in_box_score": return "player not in box score";
    default:                        return "";
  }
}

/**
 * Action-oriented copy for the "Needs review" path — tells the user
 * what to *do*, not just what went wrong. Used on PaperBetCard
 * alongside an "Edit bet" CTA so the user can fix the underlying
 * data and retry. Returns an empty string for transient diagnoses
 * (game_not_final, box_score_missing) since those resolve on their
 * own when the game finishes / ESPN updates.
 */
export function actionableDiagnosisCopy(
  d: ResolutionDiagnosis | null | undefined,
): { headline: string; canEdit: boolean } {
  switch (d) {
    case "unparseable_id":
      return {
        headline: "Game id missing — edit the bet to add it.",
        canEdit: true,
      };
    case "team_label_unmatched":
      return {
        headline: "Team abbreviation didn't match either side — edit the bet.",
        canEdit: true,
      };
    case "missing_direction":
      return {
        headline: "Direction (Over/Under) missing — edit the bet to set it.",
        canEdit: true,
      };
    case "stat_type_unsupported":
      return {
        headline: "Stat type isn't mapped — edit the bet or settle manually.",
        canEdit: true,
      };
    case "player_not_in_box_score":
      return {
        headline: "Player not found in the box score — verify ESPN player id.",
        canEdit: true,
      };
    case "box_score_missing":
      return {
        headline: "Box score not published yet — try retry resolve later.",
        canEdit: false,
      };
    case "game_not_final":
      return {
        headline: "Game still in progress — auto-resolves when final.",
        canEdit: false,
      };
    default:
      return { headline: "", canEdit: false };
  }
}

/**
 * Whether a diagnosis is *transient* — meaning the resolver should be
 * retried later because the underlying condition can resolve (e.g.
 * the game finishes, ESPN publishes the box score). The UI uses this
 * to decide whether to show "Pending — {reason}" (transient) vs
 * "Needs review — {reason}" (terminal).
 */
export function isTransient(d: ResolutionDiagnosis | null | undefined): boolean {
  return d === "game_not_final" || d === "box_score_missing";
}

export type ResolutionVia = "espn" | "manual" | null;
