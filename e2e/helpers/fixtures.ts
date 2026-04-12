/**
 * Mock response fixtures for odds provider E2E tests.
 *
 * All commence_time values are set 3 days in the future so they fall in the
 * "Next 14 days" bucket and appear in the combat sports UI regardless of
 * what the current real-world fight schedule looks like.
 */

const inDays = (n: number) =>
  new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

// ── The Odds API format ───────────────────────────────────────────────────────

/** Two MMA fights: one with full market coverage, one moneyline-only. */
export function mmaValidResponse() {
  const t = inDays(3);
  return [
    {
      id: "e2e-mma-001",
      commence_time: t,
      home_team: "Jon Jones",
      away_team: "Stipe Miocic",
      bookmakers: [
        {
          key: "draftkings",
          title: "DraftKings",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Jon Jones",    price: -400 },
                { name: "Stipe Miocic", price:  300 },
              ],
            },
            {
              key: "totals",
              outcomes: [
                { name: "Over",  price: -110, point: 2.5 },
                { name: "Under", price: -110, point: 2.5 },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "e2e-mma-002",
      commence_time: t,
      home_team: "Islam Makhachev",
      away_team: "Charles Oliveira",
      bookmakers: [
        {
          key: "fanduel",
          title: "FanDuel",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Islam Makhachev",  price: -250 },
                { name: "Charles Oliveira", price:  200 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** One boxing fight with full markets. */
export function boxingValidResponse() {
  return [
    {
      id: "e2e-boxing-001",
      commence_time: inDays(3),
      home_team: "Canelo Alvarez",
      away_team: "Dmitry Bivol",
      bookmakers: [
        {
          key: "draftkings",
          title: "DraftKings",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Canelo Alvarez", price: -150 },
                { name: "Dmitry Bivol",   price:  120 },
              ],
            },
            {
              key: "totals",
              outcomes: [
                { name: "Over",  price: -115, point: 9.5 },
                { name: "Under", price: -105, point: 9.5 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** MMA fight with moneyline only — tests graceful degradation when totals absent. */
export function mmaMoneylineOnly() {
  return [
    {
      id: "e2e-mma-incomplete-001",
      commence_time: inDays(3),
      home_team: "Fighter Alpha",
      away_team: "Fighter Beta",
      bookmakers: [
        {
          key: "betmgm",
          title: "BetMGM",
          markets: [
            {
              key: "h2h",
              outcomes: [
                { name: "Fighter Alpha", price: -200 },
                { name: "Fighter Beta",  price:  160 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

// ── Pinnacle guest API format ─────────────────────────────────────────────────

/** Pinnacle /fixtures response for MMA or Boxing. */
export function pinnacleFixtures(sport: "mma" | "boxing") {
  const homeName = sport === "mma" ? "Jon Jones"     : "Canelo Alvarez";
  const awayName = sport === "mma" ? "Stipe Miocic"  : "Dmitry Bivol";
  return {
    fixtures: [
      {
        id:       100001,
        starts:   inDays(3),
        home:     homeName,
        away:     awayName,
        status:   "O",           // O = open for betting
        // parentId intentionally absent — top-level match only
      },
    ],
  };
}

/** Pinnacle /odds response (American odds, period "0" = full match). */
export function pinnacleOdds() {
  return {
    odds: [
      {
        id: 100001,
        periods: {
          "0": {
            moneyline: { home: -380, away: 280 },
            totals:    [{ points: 2.5, over: -110, under: -110 }],
          },
        },
      },
    ],
  };
}
