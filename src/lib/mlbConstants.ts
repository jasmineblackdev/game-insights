/**
 * MLB shared constants — kept in a separate file to avoid circular imports
 * between mlbEspn.ts (which imports the prediction model) and
 * mlbPredictionModel.ts (which needs park factors).
 */

/**
 * Outdoor MLB stadiums with fixed lat/lon for weather lookup.
 * Domed / retractable-roof parks are excluded — weather is irrelevant there.
 * Key: home team abbreviation (upper-case). Value: lat/lon coordinates.
 */
export const MLB_OUTDOOR_PARKS: Record<string, { lat: number; lon: number; name: string }> = {
  // Open-air stadiums
  BOS: { lat: 42.3467, lon: -71.0972, name: "Fenway Park" },
  CHC: { lat: 41.9484, lon: -87.6553, name: "Wrigley Field" },
  CIN: { lat: 39.0979, lon: -84.5082, name: "Great American Ball Park" },
  CLE: { lat: 41.4962, lon: -81.6852, name: "Progressive Field" },
  DET: { lat: 42.3390, lon: -83.0485, name: "Comerica Park" },
  KC:  { lat: 39.0517, lon: -94.4803, name: "Kauffman Stadium" },
  LAD: { lat: 34.0739, lon: -118.2400, name: "Dodger Stadium" },
  NYM: { lat: 40.7571, lon: -73.8458, name: "Citi Field" },
  NYY: { lat: 40.8296, lon: -73.9262, name: "Yankee Stadium" },
  OAK: { lat: 37.7516, lon: -122.2005, name: "Oakland Coliseum" },
  PHI: { lat: 39.9057, lon: -75.1665, name: "Citizens Bank Park" },
  PIT: { lat: 40.4469, lon: -80.0057, name: "PNC Park" },
  SF:  { lat: 37.7786, lon: -122.3893, name: "Oracle Park" },
  STL: { lat: 38.6226, lon: -90.1928, name: "Busch Stadium" },
  TEX: { lat: 32.7512, lon: -97.0832, name: "Globe Life Field" }, // has a roof but open sides
  WSH: { lat: 38.8730, lon: -77.0074, name: "Nationals Park" },
  BAL: { lat: 39.2838, lon: -76.6216, name: "Camden Yards" },
  COL: { lat: 39.7559, lon: -104.9942, name: "Coors Field" },
  ATL: { lat: 33.8908, lon: -84.4678, name: "Truist Park" },  // open-air
  LAA: { lat: 33.8003, lon: -117.8827, name: "Angel Stadium" },
};

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
