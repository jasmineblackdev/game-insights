# GameLens

AI-assisted matchup intelligence for **NBA**, **NFL**, **MLB**, and **soccer** (EPL in the current ESPN build), plus an **Edge Card** slip builder (Pick 3 / 4 / 6).

## Data & API architecture

Target **multi-sport stack** (SportsDataIO → Supabase → clients, with phased StatsBomb / Sportradar) is documented here:

- **[docs/DATA_STACK.md](docs/DATA_STACK.md)** — side-by-side sport matrix, shared DB shape, phases, product parity across sports.
- **`src/lib/dataStack.ts`** — typed, machine-readable definitions (`SPORT_STACK`, `DATA_PHASES`, shared tables) for code and future UI.

**Current web MVP** still pulls **ESPN** (and optional **football-data.org** / **The Odds API**) in the browser; normalize through Supabase when you wire SportsDataIO.

## Scripts

```bash
npm install
npm run dev
npm run build
```
