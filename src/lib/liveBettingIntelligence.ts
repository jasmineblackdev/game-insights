/**
 * Live betting intelligence: checkpoint model vs book after sport-specific gates.
 * Pregame edge is frozen via `liveBettingPersistence` when possible.
 */
import type {
  BettingIntelligenceMeta,
  GamePrediction,
  LiveBettingIntelMeta,
  LiveBettingStageRow,
  LiveRecommendedAction,
} from "@/data/mockGames";
import {
  americanOddsForPick,
  pickAbbrevForSide,
  primaryPickSide,
  type PickSide,
} from "@/lib/bettingPickUtils";
import { computeLiveHomeWinPercent } from "@/lib/predictionVersions";
import type { PregameBetPersisted } from "@/lib/liveBettingPersistence";
import type { GameOddsBundle } from "@/lib/valueParlay/oddsEvents";
import { americanToImpliedProb } from "@/lib/valueParlay/oddsMath";

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function probToConfLive(p: number): "HIGH" | "MED" | "LOW" {
  const pct = p * 100;
  if (pct >= 65) return "HIGH";
  if (pct >= 55) return "MED";
  return "LOW";
}

function liveModelProbForPick(
  game: GamePrediction,
  side: PickSide,
  pregameHomePct: number
): number {
  const liveHomePct = computeLiveHomeWinPercent(game, pregameHomePct);
  if (side === "draw" && game.threeWay) {
    const base = game.threeWay.draw / 100;
    const shift = (liveHomePct - pregameHomePct) / 100;
    return clamp01(base - shift * 0.22);
  }
  const homeP = liveHomePct / 100;
  return side === "home" ? homeP : 1 - homeP;
}

function estimateLiveAmerican(
  game: GamePrediction,
  side: PickSide,
  pregameAmerican: number,
  bundle: GameOddsBundle | undefined
): { american: number; oddsSource: "sportsbook" | "estimated" } {
  const fromBook = americanOddsForPick(game, side, bundle);
  if (fromBook != null) return { american: fromBook, oddsSource: "sportsbook" };

  const ls = game._meta?.liveState;
  if (!ls || game.status === "upcoming") {
    return { american: pregameAmerican, oddsSource: "estimated" };
  }

  const m =
    game.league === "mlb" ? 32 : game.league === "soccer" ? 24 : game.league === "nfl" ? 11 : 10;

  let adj = pregameAmerican;
  if (side === "draw") {
    const tied = ls.homeScore === ls.awayScore;
    adj = tied ? pregameAmerican - 18 : pregameAmerican + 28;
  } else {
    const pickSc = side === "home" ? ls.homeScore : ls.awayScore;
    const oppSc = side === "home" ? ls.awayScore : ls.homeScore;
    const diff = pickSc - oppSc;
    if (pregameAmerican < 0) adj = pregameAmerican - diff * m;
    else adj = pregameAmerican - diff * m * 0.55;
  }

  const clamped = Math.round(Math.max(-900, Math.min(900, adj)));
  return { american: clamped === 0 ? pregameAmerican : clamped, oddsSource: "estimated" };
}

export function recommendedLiveAction(args: {
  modelP: number;
  implied: number;
  edge: number;
  pregameEdge: number;
}): LiveRecommendedAction {
  const { modelP, implied, edge, pregameEdge } = args;
  const stillLeanWin = modelP >= 0.505;
  const marketCaughtUp = implied >= modelP - 0.012;

  if (edge >= 0.04 && modelP >= 0.54) return "Bet Now";
  if (edge >= 0.04 && edge > pregameEdge + 0.015) return "Live Edge Active";
  if (stillLeanWin && marketCaughtUp && edge < 0.025) return "Value Gone";
  if (stillLeanWin && edge <= 0 && edge > -0.035 && modelP >= implied - 0.02) return "Value Gone";
  if (edge < -0.04) return "Pass";
  if (pregameEdge >= 0.04 && edge < 0.02 && edge >= -0.02) return "Wait";
  if (edge >= 0.025 && edge < 0.04) return "Wait";
  return "Wait";
}

export interface LiveCheckpointDef {
  id: string;
  label: string;
}

/** Sport-specific gates aligned with product spec (NBA/NFL Q1, MLB F5, soccer 30′ / HT). */
export function activeLiveBettingCheckpoints(game: GamePrediction): LiveCheckpointDef[] {
  if (game.status !== "live") return [];
  const ls = game._meta?.liveState;
  if (!ls) return [];

  const dataAgeMs = Date.now() - new Date(game.lastUpdated).getTime();
  if (dataAgeMs > 90_000) return [];

  const out: LiveCheckpointDef[] = [];
  switch (game.league) {
    case "nba":
    case "nfl":
      if (ls.isHalftime) out.push({ id: "halftime", label: "Halftime" });
      else if (ls.periodNum >= 2) out.push({ id: "after_q1", label: "After Q1" });
      break;
    case "mlb":
      if (ls.periodNum >= 5) out.push({ id: "after_inning_5", label: "After 5th inning" });
      break;
    case "soccer":
      if (!ls.isHalftime && ls.periodNum >= 30) {
        out.push({ id: "soccer_pattern", label: "≥30′ pattern" });
      }
      if (ls.isHalftime) out.push({ id: "soccer_halftime", label: "Halftime" });
      break;
    default:
      break;
  }
  return out;
}

function sportSignalsForCheckpoint(game: GamePrediction, checkpointId: string): string[] {
  const ls = game._meta?.liveState;
  const diff = ls ? Math.abs(ls.homeScore - ls.awayScore) : 0;
  const leader =
    ls && ls.homeScore >= ls.awayScore ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;

  if (game.league === "nba") {
    return [
      `Pace: ${diff <= 3 ? "neutral — early shootout or grind still plausible" : "leaning toward half-court if lead holds"}.`,
      `Foul trouble: proxy ${diff >= 8 ? "higher foul pressure on trailing side" : "no extreme foul signal from score state"}.`,
      `Star usage: Q1 leader ${leader} — rotation minutes assumed stable unless blowout forms.`,
      `Bench rotation: depth read deferred to box score; score gap ${diff} as coarse stress signal.`,
      `Shot quality: ${diff === 0 ? "tight game — variance still high" : "margin suggests efficiency edge to leader"}.`,
    ];
  }
  if (game.league === "nfl") {
    return [
      `QB pressure: score state ${diff === 0 ? "neutral" : `tilts toward ${leader}`} as script proxy.`,
      `Early injuries: no live injury feed — treat as unchanged vs pregame unless reported.`,
      `Game script: ${diff >= 10 ? "potential run-heavy / clock path for leader" : "one-score game — pass volume stays live"}.`,
      `Drive efficiency: ${diff === 0 ? "even start" : `${leader} converting early leverage`}.`,
    ];
  }
  if (game.league === "mlb") {
    const inn = ls?.periodNum ?? 0;
    return [
      `Starter pitch count: not in feed — inning ${inn} used as workload proxy.`,
      `Innings completed: through ${inn} (checkpoint at 5+).`,
      `Bullpen window: leverage spots approach if starter turns lineup third time.`,
      `Live scoring: ${ls ? `${game.awayTeam.abbreviation} ${ls.awayScore}–${ls.homeScore} ${game.homeTeam.abbreviation}` : "n/a"}.`,
    ];
  }
  if (game.league === "soccer") {
    const ht = checkpointId === "soccer_halftime" || ls?.isHalftime;
    return [
      `xG trend: proxy from score diff ${diff} — ${diff === 0 ? "finishing noise" : "chance tilt to leader"}.`,
      `Possession: ${ht ? "HT reset — second-half shape pending" : "mid-first-half shape stabilizing"}.`,
      `Cards: no live card feed — assume discipline baseline.`,
      ht
        ? "Halftime state: tactical subs and draw risk peak here."
        : "Pre-halftime: pattern checkpoint before bench disruption.",
      `Draw risk: ${game.threeWay && game.threeWay.draw >= 28 ? "elevated 1X2 draw mass" : "moderate draw mass"}.`,
    ];
  }
  return [];
}

function intelToPregameRow(
  game: GamePrediction,
  intel: BettingIntelligenceMeta,
  stageLabel: string
): LiveBettingStageRow {
  return {
    stageId: "pregame",
    stageLabel,
    pickAbbrev: intel.pickAbbrev,
    pickSide: intel.pickSide,
    modelProbability: intel.modelProbability,
    confidence: probToConfLive(intel.modelProbability),
    americanOdds: intel.americanOdds,
    impliedProbability: intel.impliedProbability,
    edge: intel.edge,
    recommendedAction: recommendedLiveAction({
      modelP: intel.modelProbability,
      implied: intel.impliedProbability,
      edge: intel.edge,
      pregameEdge: intel.edge,
    }),
    sportSignals: [],
    capturedAt: game.lastUpdated,
    oddsSource: "sportsbook",
  };
}

function buildCheckpointRow(
  game: GamePrediction,
  bundle: GameOddsBundle | undefined,
  snap: PregameBetPersisted | null,
  pregameRow: LiveBettingStageRow,
  cp: LiveCheckpointDef,
  side: PickSide
): LiveBettingStageRow {
  const pregameHomePct = snap?.winProbability.home ?? game.winProbability.home;
  const modelP = liveModelProbForPick(game, side, pregameHomePct);
  const pregameAm = snap?.bettingIntel.americanOdds ?? pregameRow.americanOdds;
  const { american, oddsSource } = estimateLiveAmerican(game, side, pregameAm, bundle);
  const implied = americanToImpliedProb(american);
  const edge = modelP - implied;
  const action = recommendedLiveAction({
    modelP,
    implied,
    edge,
    pregameEdge: pregameRow.edge,
  });

  const ls = game._meta?.liveState;
  return {
    stageId: cp.id,
    stageLabel: cp.label,
    pickAbbrev: pickAbbrevForSide(game, side),
    pickSide: side,
    modelProbability: modelP,
    confidence: probToConfLive(modelP),
    americanOdds: american,
    impliedProbability: implied,
    edge,
    recommendedAction: action,
    sportSignals: sportSignalsForCheckpoint(game, cp.id),
    liveStateSnapshot: ls
      ? { period: ls.periodNum, scoreHome: ls.homeScore, scoreAway: ls.awayScore }
      : undefined,
    capturedAt: game.lastUpdated,
    oddsSource,
  };
}

function buildFinalStageRow(
  game: GamePrediction,
  pregameRow: LiveBettingStageRow,
  side: PickSide
): LiveBettingStageRow | undefined {
  const fh = game._meta?.finalHomeScore;
  const fa = game._meta?.finalAwayScore;
  if (fh == null || fa == null) return undefined;

  const homeWon = fh > fa;
  const winnerAbbr = homeWon ? game.homeTeam.abbreviation : game.awayTeam.abbreviation;
  const pickWon = side === "draw" ? fh === fa : side === "home" ? homeWon : !homeWon;

  return {
    stageId: "final",
    stageLabel: "Final result",
    pickAbbrev: pregameRow.pickAbbrev,
    pickSide: pregameRow.pickSide,
    modelProbability: pickWon ? 1 : 0,
    confidence: "HIGH",
    americanOdds: pregameRow.americanOdds,
    impliedProbability: pregameRow.impliedProbability,
    edge: 0,
    recommendedAction: "Pass",
    sportSignals: [
      `Winner: ${winnerAbbr} — ${game.awayTeam.abbreviation} ${fa} @ ${game.homeTeam.abbreviation} ${fh}.`,
      `Pregame value pick ${pregameRow.pickAbbrev}: ${pickWon ? "hit" : "miss"}.`,
    ],
    capturedAt: game.lastUpdated,
    oddsSource: "estimated",
  };
}

export function buildLiveBettingIntelBundle(
  game: GamePrediction,
  bundle: GameOddsBundle | undefined,
  pregameSnapshot: PregameBetPersisted | null,
  currentIntel: BettingIntelligenceMeta
): LiveBettingIntelMeta {
  const side = (pregameSnapshot?.bettingIntel.pickSide as PickSide) ?? primaryPickSide(game);
  const snapshotMissing = !pregameSnapshot;
  const pregameIntel = pregameSnapshot?.bettingIntel ?? currentIntel;
  const pregameRow = intelToPregameRow(
    game,
    pregameIntel,
    snapshotMissing ? "Pregame edge (approx.)" : "Pregame edge"
  );

  const checkpoints = activeLiveBettingCheckpoints(game).map((cp) =>
    buildCheckpointRow(game, bundle, pregameSnapshot, pregameRow, cp, side)
  );

  const final = game.status === "final" ? buildFinalStageRow(game, pregameRow, side) : undefined;

  return {
    schemaVersion: 1,
    pregame: pregameRow,
    checkpoints,
    final: final ?? undefined,
    pregameSnapshotMissing: snapshotMissing,
  };
}
