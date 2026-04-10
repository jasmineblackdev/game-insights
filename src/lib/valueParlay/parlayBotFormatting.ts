/**
 * Parity with Parlay-Intelligence-Bot `data_processor` / `parlay_tracking` display logic:
 * game string parsing, decimal→American odds, confidence labels, leg blocks, parlay summaries.
 */
import type { ConfidenceLevel } from "@/data/mockGames";
import type { SmartParlayResult, ValueBetCandidate, ValueMarketType } from "@/lib/valueParlay/types";
import { formatMatchupWithAbbrevs } from "@/lib/valueParlay/teamAbbrevNormalize";

export type ParlayIntelligenceAiPrediction = {
  Game: string;
  BetType?: string;
  Pick?: string;
  Odds?: string | number;
  Reason?: string;
  Confidence?: string | number;
  GameId?: string;
};

export type ParlayLegStatus = "WIN" | "LOSS" | "PUSH" | "PENDING";

/** Split "Away @ Home", "Away vs. Home", etc. (matches bot `parse_ai_response`). */
export function parseTeamsFromGameString(game: string): { away: string; home: string } | null {
  const g = game.trim();
  if (!g) return null;
  if (g.includes("@")) {
    const [a, h] = g.split("@", 2).map((s) => s.trim());
    if (a && h) return { away: a, home: h };
  }
  if (g.includes(" vs. ")) {
    const [a, h] = g.split(" vs. ", 2).map((s) => s.trim());
    if (a && h) return { away: a, home: h };
  }
  for (const sep of [" vs ", " - ", " at "]) {
    if (g.includes(sep)) {
      const [a, h] = g.split(sep, 2).map((s) => s.trim());
      if (a && h) return { away: a, home: h };
    }
  }
  return null;
}

/**
 * Normalize odds for display: decimal (e.g. 2.10) → American string; leaves American as-is.
 * Mirrors bot `parse_ai_response` odds branch.
 */
export function normalizeInputOddsToAmericanString(odds: string | number): string {
  if (typeof odds === "number") {
    if (!Number.isFinite(odds)) return "+100";
    return decimalOrAmericanNumberToAmericanString(odds);
  }
  const raw = odds.trim();
  if (!raw) return "+100";
  if (/^[-+]\d+$/.test(raw)) return raw;
  const numeric = raw.replace(/[^\d.+-]/g, "");
  if (/^-?\d+\.?\d*$/.test(numeric) && numeric !== "-" && numeric !== "+") {
    const d = Number.parseFloat(numeric);
    if (Number.isFinite(d)) return decimalOrAmericanNumberToAmericanString(d);
  }
  return raw;
}

/** Bot passes American as strings; numbers are treated as decimal odds. */
function decimalOrAmericanNumberToAmericanString(n: number): string {
  const isInt = n === Math.round(n);
  if (isInt && (n <= -100 || n >= 100)) {
    return n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`;
  }
  const decimalOdds = n;
  if (decimalOdds >= 2) {
    return `+${Math.round((decimalOdds - 1) * 100)}`;
  }
  if (decimalOdds > 1) {
    return `-${Math.round(100 / (decimalOdds - 1))}`;
  }
  return "+100";
}

/** Bot maps high/medium/low → 8/6/4; numeric → n/10. */
export function confidenceToFractionDisplay(confidence: ConfidenceLevel | string | number): string {
  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    if (confidence <= 1 && confidence > 0) return `${Math.round(confidence * 10)}/10`;
    return `${Math.round(confidence)}/10`;
  }
  if (typeof confidence === "string") {
    const t = confidence.trim();
    const low = t.toLowerCase();
    if (low === "high") return "8/10";
    if (low === "medium") return "6/10";
    if (low === "low") return "4/10";
    if (/^\d+\s*\/\s*10$/.test(t)) return t.replace(/\s*/g, "");
    const m = t.match(/^(\d+(?:\.\d+)?)/);
    if (m) return `${Math.round(Number.parseFloat(m[1]))}/10`;
  }
  if (confidence === "high") return "8/10";
  if (confidence === "medium") return "6/10";
  if (confidence === "low") return "4/10";
  return "7/10";
}

export function marketTypeToBetTypeLabel(mt: ValueMarketType): string {
  switch (mt) {
    case "moneyline":
      return "Moneyline";
    case "spread":
      return "Spread";
    case "total":
      return "Total";
    case "player_prop":
      return "Player prop";
    default:
      return "Bet";
  }
}

export function formatParlayLegShareBlock(
  legIndex: number,
  args: {
    betType: string;
    matchupOrGame: string;
    pick: string;
    oddsAmericanDisplay: string;
    analysis: string;
    confidence: ConfidenceLevel | string | number;
  }
): string {
  const { betType, matchupOrGame, pick, oddsAmericanDisplay, analysis, confidence } = args;
  return [
    `Leg ${legIndex}:`,
    `${betType}: ${matchupOrGame}`,
    `Pick: ${pick} (Odds: ${oddsAmericanDisplay})`,
    `Analysis: ${analysis}`,
    `Confidence: ${confidenceToFractionDisplay(confidence)}`,
  ].join("\n");
}

export function formatBuilderParlayShare(
  legs: ValueBetCandidate[],
  metrics: SmartParlayResult | null,
  opts?: { title?: string; leagueLabel?: string }
): string {
  const title = opts?.title ?? "GameLens value parlay";
  const lines: string[] = [`# ${title}`];
  if (opts?.leagueLabel) lines.push(`League: ${opts.leagueLabel}`);
  lines.push(`Generated: ${new Date().toLocaleString(undefined, { timeZone: "America/New_York" })} ET`);
  lines.push("");

  legs.forEach((leg, i) => {
    const american =
      leg.americanOdds > 0 ? `+${leg.americanOdds}` : `${leg.americanOdds}`;
    const matchup = formatMatchupWithAbbrevs(leg.matchupLabel, leg.sport);
    lines.push(
      formatParlayLegShareBlock(i + 1, {
        betType: marketTypeToBetTypeLabel(leg.marketType),
        matchupOrGame: matchup,
        pick: leg.selectionLabel,
        oddsAmericanDisplay: american,
        analysis: leg.riskNote || "Model edge vs book implied probability.",
        confidence: leg.confidence,
      })
    );
    lines.push("");
  });

  if (metrics && legs.length) {
    const ca = metrics.combinedAmericanOdds;
    lines.push("—");
    lines.push(
      `Combined: ${ca > 0 ? "+" : ""}${ca} · Est. payout ${metrics.projectedPayoutMultiplier.toFixed(2)}x · Proj. hit ${(metrics.projectedHitProbability * 100).toFixed(1)}%`
    );
    lines.push(`Card confidence: ${metrics.cardConfidence}`);
    if (metrics.warnings.length) {
      lines.push(`Notes: ${metrics.warnings.join(" ")}`);
    }
  }

  return lines.join("\n").trim();
}

const STATUS_EMOJI: Record<ParlayLegStatus, string> = {
  WIN: "✅",
  LOSS: "❌",
  PUSH: "🔄",
  PENDING: "⏳",
};

/** Discord-style status block (bot `format_parlay_status`). */
export function formatParlayStatusMessage(args: {
  parlayId: string;
  leagueLabel: string;
  timestampIso: string;
  overallStatus: ParlayLegStatus;
  totalOddsDisplay: string;
  legs: Array<{
    matchup: string;
    betType: string;
    pick: string;
    oddsDisplay: string;
    status: ParlayLegStatus;
    result?: string | null;
  }>;
}): string {
  const ts = new Date(args.timestampIso);
  const formattedTime = Number.isFinite(ts.getTime())
    ? ts.toLocaleString(undefined, { timeZone: "America/New_York" })
    : args.timestampIso;

  const lines: string[] = [
    `${args.leagueLabel} Parlay (ID: ${args.parlayId})`,
    `Generated: ${formattedTime}`,
    `Overall: ${STATUS_EMOJI[args.overallStatus]} ${args.overallStatus}`,
    `Total odds: ${args.totalOddsDisplay}`,
    "",
    "Legs:",
  ];

  args.legs.forEach((leg, i) => {
    lines.push(
      `${i + 1}. ${STATUS_EMOJI[leg.status]} ${leg.matchup}`,
      `   ${leg.betType}: ${leg.pick} (${leg.oddsDisplay})`
    );
    if (leg.result) lines.push(`   Result: ${leg.result}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}

/** Parse bot-style JSON: `{ "Predictions": [ ... ] }`. */
export function parseParlayIntelligencePredictionsJson(response: string): ParlayIntelligenceAiPrediction[] {
  let data: { Predictions?: ParlayIntelligenceAiPrediction[] };
  try {
    data = JSON.parse(response) as { Predictions?: ParlayIntelligenceAiPrediction[] };
  } catch {
    const m = response.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON object found in response");
    data = JSON.parse(m[0]) as { Predictions?: ParlayIntelligenceAiPrediction[] };
  }
  const predictions = data.Predictions;
  if (!predictions?.length) throw new Error("No predictions found in the response");
  return predictions;
}

/** Format AI predictions like bot `parse_ai_response` output strings. */
export function formatAiPredictionsForShare(predictions: ParlayIntelligenceAiPrediction[]): string[] {
  const out: string[] = [];
  predictions.forEach((pred, i) => {
    const teams = parseTeamsFromGameString(pred.Game);
    const matchup =
      teams != null ? `${teams.away} vs ${teams.home}` : pred.Game.trim();
    const american = normalizeInputOddsToAmericanString(pred.Odds ?? "+100");
    const block = formatParlayLegShareBlock(i + 1, {
      betType: pred.BetType ?? "Moneyline",
      matchupOrGame: matchup,
      pick: pred.Pick ?? "",
      oddsAmericanDisplay: american,
      analysis: pred.Reason ?? "No analysis provided",
      confidence: pred.Confidence ?? "7/10",
    });
    out.push(block);
  });
  return out;
}

/** Heuristic: player name before over/under/stat keywords (bot `extract_player_name_from_bet`). */
export function extractPlayerNameFromPick(pick: string): string | null {
  const lower = pick.toLowerCase();
  const keywords = [
    "over",
    "under",
    "to score",
    "points",
    "rebounds",
    "assists",
    "yards",
    "touchdowns",
  ];
  for (const kw of keywords) {
    const idx = lower.indexOf(kw);
    if (idx !== -1) {
      const name = pick.slice(0, idx).trim();
      if (name) return name;
    }
  }
  const m = pick.match(/^([^0-9]+?)(?=\s*\d)/);
  if (m) return m[1].trim();
  const first = pick.split(/\s+/)[0];
  return first?.trim() || null;
}
