/**
 * GameLens college futures model: devigged market + sport-specific heuristic adjustments.
 * Structured for future stats ingestion; V1 uses deterministic synthetic factors from selection name.
 */

import type { CollegeSportId, CollegeFuturesIntelRow, RawFuturesOutcome } from "@/lib/collegeFuturesTypes";
import {
  devigImpliedProbs,
  getStoredOpeningOdds,
  lineMovementImpliedDelta,
} from "@/lib/collegeFuturesOddsApi";
import { americanToImpliedProb } from "@/lib/valueParlay/oddsMath";

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function u01(h: number, salt: number): number {
  const x = Math.sin(h * 0.0001 + salt * 17.23) * 10000;
  return x - Math.floor(x);
}

type FactorSet = Record<string, number>;

function syntheticBaseball(name: string): FactorSet {
  const h = hash32(name.toLowerCase());
  return {
    teamStrength: u01(h, 1),
    pitchingDepth: u01(h, 2),
    weekendRotation: u01(h, 3),
    bullpenQuality: u01(h, 4),
    offensiveConsistency: u01(h, 5),
    runProduction: u01(h, 6),
    scheduleStrength: u01(h, 7),
    conferenceStrength: u01(h, 8),
    recentForm: u01(h, 9),
    postseasonExperience: u01(h, 10),
    injuryUncertainty: u01(h, 11),
  };
}

function syntheticBasketball(name: string): FactorSet {
  const h = hash32(name.toLowerCase());
  return {
    powerRating: u01(h, 21),
    offensiveEfficiency: u01(h, 22),
    defensiveEfficiency: u01(h, 23),
    netRating: u01(h, 24),
    reboundingMargin: u01(h, 25),
    depth: u01(h, 26),
    guardReliability: u01(h, 27),
    threePointDependence: u01(h, 28),
    /** Higher = better turnover control (fewer giveaways). */
    ballSecurity: u01(h, 29),
    freeThrowReliability: u01(h, 30),
    scheduleStrength: u01(h, 31),
    conferenceStrength: u01(h, 32),
    recentForm: u01(h, 33),
    tournamentViability: u01(h, 34),
  };
}

function syntheticFootball(name: string): FactorSet {
  const h = hash32(name.toLowerCase());
  return {
    powerRating: u01(h, 41),
    returningProduction: u01(h, 42),
    qbQuality: u01(h, 43),
    offensiveLineQuality: u01(h, 44),
    defensiveLineStrength: u01(h, 45),
    scheduleStrength: u01(h, 46),
    depth: u01(h, 47),
    coachingQuality: u01(h, 48),
    injuryRisk: u01(h, 49),
    conferenceStrength: u01(h, 50),
    playoffPathDifficulty: u01(h, 51),
    turnoverMarginProfile: u01(h, 52),
    explosivePlayRate: u01(h, 53),
    redZoneEfficiency: u01(h, 54),
  };
}

function baseballComposite(f: FactorSet): number {
  return (
    f.pitchingDepth * 0.22 +
    f.bullpenQuality * 0.2 +
    f.weekendRotation * 0.12 +
    f.offensiveConsistency * 0.12 +
    f.runProduction * 0.08 +
    f.scheduleStrength * 0.1 +
    f.conferenceStrength * 0.08 +
    f.recentForm * 0.04 +
    f.postseasonExperience * 0.04 -
    f.injuryUncertainty * 0.06 +
    (f.teamStrength - 0.5) * 0.04
  );
}

function basketballComposite(f: FactorSet): number {
  return (
    f.guardReliability * 0.16 +
    f.defensiveEfficiency * 0.14 +
    f.ballSecurity * 0.12 +
    f.netRating * 0.12 +
    f.offensiveEfficiency * 0.1 +
    f.depth * 0.08 +
    f.tournamentViability * 0.08 +
    f.scheduleStrength * 0.06 +
    f.conferenceStrength * 0.05 +
    f.reboundingMargin * 0.04 +
    f.freeThrowReliability * 0.03 -
    f.threePointDependence * 0.06 +
    (f.powerRating - 0.5) * 0.04
  );
}

function footballComposite(f: FactorSet): number {
  const pathEase = 1 - f.playoffPathDifficulty;
  return (
    f.qbQuality * 0.18 +
    f.offensiveLineQuality * 0.12 +
    f.defensiveLineStrength * 0.1 +
    pathEase * 0.1 +
    f.scheduleStrength * 0.08 +
    f.depth * 0.08 +
    f.turnoverMarginProfile * 0.07 +
    f.redZoneEfficiency * 0.06 +
    f.explosivePlayRate * 0.06 +
    f.coachingQuality * 0.05 +
    f.returningProduction * 0.04 +
    f.conferenceStrength * 0.04 -
    f.injuryRisk * 0.08 +
    (f.powerRating - 0.5) * 0.04
  );
}

function expScale(sport: CollegeSportId): number {
  if (sport === "college_baseball") return 0.42;
  if (sport === "college_basketball") return 0.38;
  return 0.36;
}

function compositeForSport(sport: CollegeSportId, name: string): number {
  if (sport === "college_baseball") return baseballComposite(syntheticBaseball(name));
  if (sport === "college_basketball") return basketballComposite(syntheticBasketball(name));
  return footballComposite(syntheticFootball(name));
}

export function futuresValueRating(edge: number): CollegeFuturesIntelRow["valueRating"] {
  if (edge >= 0.05) return "A";
  if (edge >= 0.03) return "B";
  if (edge > -0.02) return "C";
  if (edge > -0.05) return "D";
  return "F";
}

function futuresConfidence(args: {
  edge: number;
  fairImplied: number;
  nTeams: number;
  hasOpening: boolean;
  sport: CollegeSportId;
}): CollegeFuturesIntelRow["confidence"] {
  const { edge, fairImplied, nTeams, hasOpening, sport } = args;
  const volK = sport === "college_baseball" ? 1 : sport === "college_basketball" ? 0.95 : 1.05;
  if (fairImplied < 0.02 && Math.abs(edge) > 0.035 * volK) return "LOW";
  if (nTeams < 10) return "LOW";
  if (fairImplied < 0.015) return "LOW";
  if (hasOpening && fairImplied >= 0.035 && fairImplied <= 0.32 && Math.abs(edge) < 0.06) return "HIGH";
  if (fairImplied >= 0.04 && fairImplied <= 0.28 && nTeams >= 24) return "HIGH";
  return "MED";
}

function baseballReasons(f: FactorSet): { r1: string; r2: string; risk: string } {
  const reasons: string[] = [];
  if (f.pitchingDepth >= 0.62 && f.weekendRotation >= 0.55) {
    reasons.push("Strong weekend rotation profile vs field — tournament pitching matters.");
  }
  if (f.bullpenQuality >= 0.6) {
    reasons.push("Bullpen depth signal — relievers swing multi-game regionals.");
  }
  if (f.conferenceStrength >= 0.58 && f.offensiveConsistency >= 0.52) {
    reasons.push("Top conference strength with stable run production.");
  }
  if (f.scheduleStrength >= 0.6) {
    reasons.push("Schedule tested vs quality opponents — less fake record risk.");
  }
  if (reasons.length < 2 && f.offensiveConsistency >= 0.62) {
    reasons.push("Offensive consistency profile supports October variance.");
  }
  if (reasons.length < 2) {
    reasons.push("Model blends market with pitching depth and bullpen reliability.");
  }
  let risk = "Standard futures variance — one bad weekend ends the season.";
  if (f.bullpenQuality < 0.35 && f.pitchingDepth > 0.55) {
    risk = "Risk: front-line look but thin bullpen — regionals punish reliever holes.";
  } else if (f.offensiveConsistency < 0.35) {
    risk = "Risk: inconsistent offense — low floor in short series.";
  } else if (f.scheduleStrength < 0.32) {
    risk = "Risk: soft schedule — market may overpay win totals.";
  }
  return { r1: reasons[0] ?? "Heuristic profile vs devigged market.", r2: reasons[1] ?? reasons[0] ?? "—", risk };
}

function basketballReasons(f: FactorSet): { r1: string; r2: string; risk: string } {
  const reasons: string[] = [];
  if (f.defensiveEfficiency >= 0.6) {
    reasons.push("Top-tier defensive efficiency profile — translates in March.");
  }
  if (f.guardReliability >= 0.58) {
    reasons.push("Guard play reliability — late-game and pressure possessions.");
  }
  if (f.ballSecurity >= 0.58) {
    reasons.push("Turnover control vs field — fewer empty trips in tournament pace.");
  }
  if (f.depth >= 0.56 && f.tournamentViability >= 0.52) {
    reasons.push("Depth + tournament viability — foul trouble and quick turnarounds.");
  }
  if (reasons.length < 2 && f.netRating >= 0.58) {
    reasons.push("Strong net rating signal vs market price.");
  }
  if (reasons.length < 2) {
    reasons.push("Model weights guards, defense, and turnover profile vs implied.");
  }
  let risk = "Injury or cold shooting weekend — single-elimination noise.";
  if (f.threePointDependence >= 0.68) {
    risk = "Risk: heavy 3P reliance — variance can crater a title run.";
  } else if (f.guardReliability < 0.35) {
    risk = "Risk: thin guard depth — pressure defense exposes ballhandlers.";
  } else if (f.freeThrowReliability < 0.35) {
    risk = "Risk: shaky free throw profile — close March games matter.";
  }
  return { r1: reasons[0] ?? "Heuristic profile vs devigged market.", r2: reasons[1] ?? reasons[0] ?? "—", risk };
}

function footballReasons(f: FactorSet): { r1: string; r2: string; risk: string } {
  const reasons: string[] = [];
  if (f.qbQuality >= 0.62 && f.offensiveLineQuality >= 0.52) {
    reasons.push("Elite QB profile with workable line play — playoff football skew.");
  }
  if (f.playoffPathDifficulty <= 0.38) {
    reasons.push("Favorable playoff path difficulty vs other contenders.");
  }
  if (f.defensiveLineStrength >= 0.58 && f.depth >= 0.52) {
    reasons.push("Defensive line + roster depth — attrition over full season.");
  }
  if (f.scheduleStrength >= 0.58) {
    reasons.push("Schedule strength — less inflated by cupcakes.");
  }
  if (reasons.length < 2) {
    reasons.push("Model weights QB, lines, path, and schedule vs implied.");
  }
  let risk = "Injury at QB or line — title odds swing fast.";
  if (f.offensiveLineQuality < 0.35) {
    risk = "Risk: weak offensive line — elite fronts collapse one-dimensional attacks.";
  } else if (f.playoffPathDifficulty >= 0.72) {
    risk = "Risk: brutal playoff path — market may understate opponent quality.";
  } else if (f.qbQuality < 0.38 && f.powerRating > 0.55) {
    risk = "Risk: brand-priced team without elite QB play.";
  }
  return { r1: reasons[0] ?? "Heuristic profile vs devigged market.", r2: reasons[1] ?? reasons[0] ?? "—", risk };
}

function reasonsForSport(sport: CollegeSportId, name: string): { r1: string; r2: string; risk: string } {
  if (sport === "college_baseball") return baseballReasons(syntheticBaseball(name));
  if (sport === "college_basketball") return basketballReasons(syntheticBasketball(name));
  return footballReasons(syntheticFootball(name));
}

export function buildCollegeFuturesIntelRows(
  sport: CollegeSportId,
  sportKey: string,
  outcomes: RawFuturesOutcome[]
): CollegeFuturesIntelRow[] {
  if (!outcomes.length) return [];

  const impliedRaw = outcomes.map((o) => americanToImpliedProb(o.americanOdds));
  const fair = devigImpliedProbs(impliedRaw);
  const composites = outcomes.map((o) => compositeForSport(sport, o.selectionName));
  const scale = expScale(sport);

  let rawModel = outcomes.map((o, i) => {
    const c = composites[i];
    const mult = Math.exp((c - 0.5) * scale);
    return Math.max(1e-6, fair[i] * mult);
  });
  const sumM = rawModel.reduce((a, b) => a + b, 0);
  rawModel = rawModel.map((x) => x / sumM);

  return outcomes.map((o, i) => {
    const implied = impliedRaw[i];
    const fairImplied = fair[i];
    const modelProbability = rawModel[i];
    const edge = Math.round((modelProbability - fairImplied) * 1000) / 1000;

    const openingStored = getStoredOpeningOdds(sportKey, o.selectionName);
    const lineMovementDelta = lineMovementImpliedDelta(openingStored, o.americanOdds);

    const { r1, r2, risk } = reasonsForSport(sport, o.selectionName);

    const confidence = futuresConfidence({
      edge,
      fairImplied,
      nTeams: outcomes.length,
      hasOpening: openingStored != null,
      sport,
    });

    return {
      selectionName: o.selectionName,
      teamId: o.teamId,
      americanOdds: o.americanOdds,
      openingOdds: openingStored,
      impliedProbability: Math.round(implied * 1000) / 1000,
      fairImpliedProbability: Math.round(fairImplied * 1000) / 1000,
      modelProbability: Math.round(modelProbability * 1000) / 1000,
      edge,
      confidence,
      valueRating: futuresValueRating(edge),
      reason1: r1,
      reason2: r2,
      riskFactor: risk,
      lineMovementDelta,
    };
  });
}
