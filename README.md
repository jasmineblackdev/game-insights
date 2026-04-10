# GameLens

AI-assisted matchup intelligence for **NBA**, **NFL**, **MLB**, and **soccer** (EPL in the current ESPN build), plus an **Edge Card** slip builder (sizes **3 / 5 / 7 / 10**).

## Data & API architecture

Target **multi-sport stack** (SportsDataIO → Supabase → clients, with phased StatsBomb / Sportradar) is documented here:

- **[docs/DATA_STACK.md](docs/DATA_STACK.md)** — side-by-side sport matrix, shared DB shape, phases, product parity across sports.
- **`src/lib/dataStack.ts`** — typed, machine-readable definitions (`SPORT_STACK`, `DATA_PHASES`, shared tables) for code and future UI.

**Current web MVP** pulls **ESPN** scoreboards (and optional **football-data.org** / **The Odds API**). For production, deploy the **`espn-proxy`** Supabase Edge Function and set **`VITE_ENABLE_ESPN_PROXY=1`** so clients hit a cached server path instead of ESPN directly (see `.env.example`).

**Edge Card** and **Player Edge** ship in the main bundle so hard refresh on `/edge` and `/player-edge/...` always loads reliably on static hosts. React Query uses bounded retries; scoreboard fetches use **timeouts** for flaky networks.

## Scripts

```bash
npm install
npm run dev
npm run build
```
