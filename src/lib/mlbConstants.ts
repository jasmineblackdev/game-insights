/**
 * MLB shared constants — kept in a separate file to avoid circular imports
 * between mlbEspn.ts (which imports the prediction model) and
 * mlbPredictionModel.ts (which needs park factors).
 */

/** Run-environment park factor by home team abbreviation. >1 = hitter's park, <1 = pitcher's park. */
export const MLB_PARK_FACTORS: Record<string, { factor: number; note: string }> = {
  COL: { factor: 1.18, note: "Coors Field — extreme hitter's park; run totals and WHIP are inflated." },
  TEX: { factor: 1.10, note: "Globe Life Field — hitter-friendly; warm air and dimensions aid fly balls." },
  CIN: { factor: 1.08, note: "Great American Ball Park — HR-prone; starters need ground-ball tendencies." },
  PHI: { factor: 1.06, note: "Citizens Bank Park — slight hitter's edge; right-center gap is generous." },
  BOS: { factor: 1.04, note: "Fenway Park — Green Monster inflates doubles; modest overall hitter edge." },
  CHC: { factor: 1.03, note: "Wrigley Field — wind-dependent; out-blowing days flip it to a hitter's park." },
  HOU: { factor: 0.97, note: "Minute Maid Park — dome; slight pitcher edge on off-days without roof issues." },
  MIA: { factor: 0.96, note: "loanDepot Park — retractable roof; controlled conditions, slight pitcher edge." },
  NYM: { factor: 0.95, note: "Citi Field — spacious outfield suppresses HRs; pitcher-friendly." },
  OAK: { factor: 0.94, note: "Oakland Coliseum — wide foul territory and sea-level air favor pitchers." },
  SF:  { factor: 0.93, note: "Oracle Park — marine layer and ocean wind create strong pitcher-friendly conditions." },
  SEA: { factor: 0.92, note: "T-Mobile Park — retractable roof and deep alleys suppress offense." },
  DET: { factor: 0.96, note: "Comerica Park — deep outfield, slight pitcher advantage on fly balls." },
  SD:  { factor: 0.84, note: "Petco Park — strongest pitcher's park in MLB; run totals reliably suppressed." },
};
