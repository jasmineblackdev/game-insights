/**
 * Contract tests for the resolution-diagnosis taxonomy.
 *
 * Locks:
 *   • the canonical enum doesn't shrink without a code change
 *   • transient vs terminal classification is stable
 *   • the human label is non-empty for every enum member
 */

import { describe, expect, it } from "vitest";
import {
  RESOLUTION_DIAGNOSES,
  actionableDiagnosisCopy,
  diagnosisLabel,
  isResolutionDiagnosis,
  isTransient,
  type ResolutionDiagnosis,
} from "@/lib/learning/resolutionDiagnosis";

describe("ResolutionDiagnosis", () => {
  it("includes the seven canonical values from the spec", () => {
    const expected: ResolutionDiagnosis[] = [
      "game_not_final",
      "box_score_missing",
      "unparseable_id",
      "stat_type_unsupported",
      "team_label_unmatched",
      "missing_direction",
      "player_not_in_box_score",
    ];
    for (const v of expected) {
      expect(RESOLUTION_DIAGNOSES).toContain(v);
    }
    expect(RESOLUTION_DIAGNOSES.length).toBe(expected.length);
  });

  it("isResolutionDiagnosis only accepts known values", () => {
    expect(isResolutionDiagnosis("game_not_final")).toBe(true);
    expect(isResolutionDiagnosis("box_score_missing")).toBe(true);
    expect(isResolutionDiagnosis("not_a_real_diagnosis")).toBe(false);
    expect(isResolutionDiagnosis(null)).toBe(false);
    expect(isResolutionDiagnosis(undefined)).toBe(false);
    expect(isResolutionDiagnosis(42)).toBe(false);
  });

  it("every enum member has a non-empty human label", () => {
    for (const d of RESOLUTION_DIAGNOSES) {
      const label = diagnosisLabel(d);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toMatch(/_/); // no raw enum tokens leaked through
    }
  });

  it("returns empty label for null / undefined", () => {
    expect(diagnosisLabel(null)).toBe("");
    expect(diagnosisLabel(undefined)).toBe("");
  });

  describe("isTransient — game-not-final and box-score-missing are retryable", () => {
    it("classifies transient codes correctly", () => {
      expect(isTransient("game_not_final")).toBe(true);
      expect(isTransient("box_score_missing")).toBe(true);
    });

    it("classifies terminal codes as non-transient", () => {
      expect(isTransient("unparseable_id")).toBe(false);
      expect(isTransient("stat_type_unsupported")).toBe(false);
      expect(isTransient("team_label_unmatched")).toBe(false);
      expect(isTransient("missing_direction")).toBe(false);
      expect(isTransient("player_not_in_box_score")).toBe(false);
    });

    it("treats missing diagnosis as non-transient (no retry suggested)", () => {
      expect(isTransient(null)).toBe(false);
      expect(isTransient(undefined)).toBe(false);
    });
  });

  describe("actionableDiagnosisCopy — Phase 4 actionable errors", () => {
    it("returns canEdit=true for fixable codes with imperative copy", () => {
      const editable: ResolutionDiagnosis[] = [
        "unparseable_id",
        "team_label_unmatched",
        "missing_direction",
        "stat_type_unsupported",
        "player_not_in_box_score",
      ];
      for (const d of editable) {
        const c = actionableDiagnosisCopy(d);
        expect(c.canEdit).toBe(true);
        expect(c.headline.length).toBeGreaterThan(0);
        // Imperative phrasing — should mention an action.
        expect(c.headline.toLowerCase()).toMatch(/edit|verify|set/);
      }
    });

    it("returns canEdit=false for transient codes (game/box score still landing)", () => {
      const transient: ResolutionDiagnosis[] = ["game_not_final", "box_score_missing"];
      for (const d of transient) {
        const c = actionableDiagnosisCopy(d);
        expect(c.canEdit).toBe(false);
        expect(c.headline.toLowerCase()).not.toMatch(/edit/);
      }
    });

    it("returns empty headline + canEdit=false for null/undefined", () => {
      expect(actionableDiagnosisCopy(null)).toEqual({ headline: "", canEdit: false });
      expect(actionableDiagnosisCopy(undefined)).toEqual({ headline: "", canEdit: false });
    });
  });
});
