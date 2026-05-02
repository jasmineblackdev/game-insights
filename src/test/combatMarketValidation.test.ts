/**
 * Combat-market validation contract tests.
 *
 * Locks the labeling fix that removed "Under 89.5 fight winner"
 * (binary stat with bogus Over/Under prefix). Any future regression
 * that re-introduces a malformed shape should fail here before
 * reaching the UI.
 */

import { describe, expect, it } from "vitest";
import type { PlayerEdgePrediction } from "@/data/playerEdgeMock";
import {
  formatCombatLabel,
  isLikelyMalformedCombatLabel,
  validateCombatProp,
} from "@/lib/playerProps/combatMarketValidation";

function basePred(overrides: Partial<PlayerEdgePrediction>): PlayerEdgePrediction {
  return {
    id: "test-1",
    game_id: "g1",
    player_id: "p1",
    player_name: "Tyson Fury",
    sport: "Boxing",
    team: "FUR",
    opponent: "Oleksandr Usyk",
    game_time: "10:00 PM ET",
    stat_type: "fight_winner",
    line_value: 89.5,
    projected_value: 95,
    prediction_direction: "MORE",
    edge: 5,
    confidence: "HIGH",
    reason_1: "",
    reason_2: "",
    risk_factor: "",
    game_sort: 1,
    confidence_score_0_100: 72,
    risk_tier: "low",
    consistency_label: "stable",
    ...overrides,
  } as PlayerEdgePrediction;
}

describe("validateCombatProp", () => {
  it("accepts a binary fight_winner with MORE direction", () => {
    const v = validateCombatProp(basePred({ stat_type: "fight_winner", prediction_direction: "MORE" }));
    expect(v).toEqual({ valid: true, kind: "binary" });
  });

  it("rejects fight_winner with LESS direction (no inverse market)", () => {
    const v = validateCombatProp(basePred({ stat_type: "fight_winner", prediction_direction: "LESS" }));
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toMatch(/binary/i);
  });

  it("accepts every binary stat with MORE direction", () => {
    for (const stat of ["fight_winner", "ko_tko", "submission", "decision", "draw"]) {
      const v = validateCombatProp(basePred({ stat_type: stat, prediction_direction: "MORE" }));
      expect(v).toEqual({ valid: true, kind: "binary" });
    }
  });

  it("accepts total_rounds with Over/Under direction + numeric line", () => {
    const over = validateCombatProp(basePred({
      stat_type: "total_rounds", prediction_direction: "MORE", line_value: 9.5,
    }));
    const under = validateCombatProp(basePred({
      stat_type: "total_rounds", prediction_direction: "LESS", line_value: 9.5,
    }));
    expect(over).toEqual({ valid: true, kind: "totals" });
    expect(under).toEqual({ valid: true, kind: "totals" });
  });

  it("rejects unknown combat stat_type", () => {
    const v = validateCombatProp(basePred({ stat_type: "fastest_punch_speed" }));
    expect(v.valid).toBe(false);
    if (!v.valid) expect(v.reason).toMatch(/unknown/i);
  });

  it("treats non-combat sports as always valid (no-op)", () => {
    const v = validateCombatProp(basePred({
      sport: "NBA",
      stat_type: "points",
      prediction_direction: "MORE",
    }));
    expect(v.valid).toBe(true);
  });
});

describe("formatCombatLabel", () => {
  it("renders fight_winner as 'Player to win', never with Over/Under", () => {
    const label = formatCombatLabel(basePred({
      stat_type: "fight_winner", prediction_direction: "MORE",
    }));
    expect(label).toBe("Tyson Fury to win");
    expect(label).not.toMatch(/over|under/i);
    expect(label).not.toMatch(/89\.5/);
  });

  it("renders method props with the right verb (KO/TKO, submission, decision)", () => {
    expect(formatCombatLabel(basePred({ stat_type: "ko_tko" }))).toBe("Tyson Fury by KO/TKO");
    expect(formatCombatLabel(basePred({ stat_type: "submission" }))).toBe("Tyson Fury by submission");
    expect(formatCombatLabel(basePred({ stat_type: "decision" }))).toBe("Tyson Fury by decision");
  });

  it("renders total_rounds with Over/Under prefix and numeric line", () => {
    expect(formatCombatLabel(basePred({
      stat_type: "total_rounds", prediction_direction: "MORE", line_value: 9.5,
    }))).toBe("Over 9.5 rounds");
    expect(formatCombatLabel(basePred({
      stat_type: "total_rounds", prediction_direction: "LESS", line_value: 9.5,
    }))).toBe("Under 9.5 rounds");
  });

  it("returns fallback for invalid shapes", () => {
    expect(formatCombatLabel(basePred({
      stat_type: "fight_winner", prediction_direction: "LESS",
    }))).toBe("Invalid combat market");
  });
});

describe("isLikelyMalformedCombatLabel — UI safeguard", () => {
  it("detects 'Under 89.5 fight winner' (the original bug)", () => {
    expect(isLikelyMalformedCombatLabel("Boxing", "Under 89.5 fight winner", "fight_winner")).toBe(true);
  });

  it("detects 'Over X.X ko_tko' style strings", () => {
    expect(isLikelyMalformedCombatLabel("MMA", "Tyson Fury Over 33 ko_tko", "ko_tko")).toBe(true);
  });

  it("passes the proper labels emitted by formatCombatLabel", () => {
    expect(isLikelyMalformedCombatLabel("Boxing", "Tyson Fury to win", "fight_winner")).toBe(false);
    expect(isLikelyMalformedCombatLabel("MMA", "Tyson Fury by KO/TKO", "ko_tko")).toBe(false);
  });

  it("no-ops for non-combat sports", () => {
    expect(isLikelyMalformedCombatLabel("NBA", "Tyrese Maxey Under 28.5 points", "points")).toBe(false);
  });

  it("no-ops for total_rounds (Over/Under is legitimate there)", () => {
    expect(isLikelyMalformedCombatLabel("Boxing", "Over 9.5 rounds", "total_rounds")).toBe(false);
  });
});
