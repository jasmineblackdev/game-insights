# GameLens data & API stack

This document is the **target architecture** for a multi-sport MVP and phased enrichment. The **current web app** uses ESPN (and optional football-data.org / The Odds API) as a client-side stand-in until SportsDataIO + Supabase ingestion lands.

---

## Recommended base stack (MVP)

| Layer | Choice | Role |
|--------|--------|------|
| **Operational feed** | **SportsDataIO** | Cross-sport: scores, stats, injuries, lineups / depth charts, standings; soccer covers **20+** competitions (not one league only). |
| **Backend** | **Supabase** | Database, auth, Edge Functions (proxy CORS / secrets), optional ingestion cron. |
| **Push** | **Firebase Cloud Messaging** | Alerts on lineup / injury / pitcher / kickoff changes. |
| **Mobile** | **React Native** | Same product surface as web long-term. |

**Deeper intelligence (phased)**

| Add-on | Use |
|--------|-----|
| **StatsBomb** | Soccer xG, event-level tactics, smarter explanations. |
| **Sportradar** | MLB push probable pitchers + real-time lineups; richer soccer lineups if needed. |
| **football-data.org** | Lightweight soccer fixtures / standings (already optional in web MVP). |

---

## Side-by-side sport matrix

| Sport | Main prediction drivers | Must-have data | Nice-to-have | MVP API |
|-------|-------------------------|----------------|--------------|---------|
| **NBA** | Injuries, rotations, usage, rest, matchup style | Schedules, injuries, lineups/depth, player/team stats, standings | Odds, news | SportsDataIO NBA |
| **NFL** | QB form, OL vs pass rush, injuries, depth stability, RZ, turnovers, rest | Schedules, injuries, depth charts, stats, standings | Odds, news, return timelines | SportsDataIO NFL |
| **MLB** | Probable/confirmed SP, bullpen fatigue, splits, lineup strength | Schedules, projected/confirmed lineups & pitchers, injuries, splits, pitch data | Statcast, push SP changes | SportsDataIO MLB (+ Sportradar push) |
| **Soccer** | Possession profile, xG, lineups, congestion, home/away, style vs style | Fixtures, standings, lineups, live status, team/player stats | xG/events, tactics | SportsDataIO Soccer (+ StatsBomb) |

---

## Per-sport MVP model outputs

### NBA

- Win probability, confidence, top 3 reasons, biggest risk, injury impact, **what changed** since last update.

### NFL

- Win probability, confidence, trench edge, QB edge, injury risk, upset path.

### MLB

- Win probability, starter edge, bullpen risk, handedness edge, lineup confidence, **prediction pending pitcher confirmation** when applicable.

### Soccer

- Home / draw / away probabilities, confidence, xG edge (when wired), possession/control edge, congestion warning, lineup confirmation status.

---

## Shared backend pattern

```
External APIs → ingestion jobs → normalized DB → sport-specific engine → clients (web / React Native)
```

### Core tables (all sports)

`teams`, `players`, `games`, `injuries`, `lineups_or_depth`, `team_game_logs`, `player_game_logs`, `predictions`, `prediction_factors`, `prediction_versions`, `user_favorites`, `user_alerts`

### Sport-specific extensions

| Sport | Additional tables / domains |
|-------|----------------------------|
| NBA | `rotations`, `usage_trends` |
| NFL | `depth_charts`, `qb_metrics` |
| MLB | `probable_pitchers`, `bullpen_usage`, `team_splits` |
| Soccer | `fixtures`, `lineups`, `xg_metrics`, `congestion_metrics` |

---

## Shared product features (all sports)

- Daily best picks  
- Edge Card: Pick 3 / 4 / 6, manual + auto-build  
- Confidence, top reasons, biggest risk, last updated  
- Replacement suggestion when conditions change  
- Prediction history & hit rate (track in `predictions` / versions)  

---

## Phased API plan

### Phase 1 — Real MVP

SportsDataIO + Supabase + FCM + React Native (single operational vendor across NBA, NFL, MLB, Soccer).

### Phase 2 — Smarter analytics

StatsBomb (soccer xG/events); Sportradar MLB (push probable pitchers, richer lineups).

### Phase 3 — Premium

Odds comparison, line movement, news/sentiment, accuracy dashboards by sport (SportsDataIO can supply odds/market data when you enable it).

---

## Current web repo (interim)

| Source | Role |
|--------|------|
| ESPN site API | Live scoreboards, injuries, summaries (browser; proxy if blocked). |
| football-data.org | Optional EPL congestion + table (token + dev proxy). |
| The Odds API | Optional US-book spreads + MLB **F5 (first 5 innings)** leg lines; soccer uses **per-league** keys mapped from ESPN slugs (`src/lib/oddsSportKeys.ts`). List keys anytime with `GET /v4/sports/?all=true` (free, no quota). |

Treat this as **demo/iteration** until data is normalized through Supabase per the pipeline above.

Structured machine-readable definitions: `src/lib/dataStack.ts`.

---

## Not in this pass (limits)

- **Sub-10s scoreboard streaming** — True near–real-time play-by-play still needs ESPN or partner **WebSockets** or **server push**. The SPA uses **HTTP polling** only; when a scoreboard feed has at least one **live** game, polling defaults to **~10s** (see `VITE_SCOREBOARD_POLL_MS_LIVE` in `.env.example` and `src/lib/scoreboardPollConfig.ts`). That tightens freshness but is **not** a streaming stack.

- **Minutes / snap / xG “role” models** — Player prop and soccer “role” style signals use **trend + pace heuristics** until real minutes, snap, and xG/event feeds exist. See `docs/MODEL_ASSUMPTIONS.md` and `src/lib/modelAssumptions.ts`.

- **Accuracy / learning persistence (no product UI)** — Client rollups live in **localStorage** via `src/lib/predictionLearningStorage.ts` (e.g. `gamelens-learn-v1-accuracy-summary`). **Optional**: set `VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE=1` with a signed-in user to upsert a mirror into `user_learning_snapshots` (migration `20260410200000_user_learning_snapshots.sql`). Server rollup `prediction_accuracy_summary` is still built from `prediction_outcome_log` via `refresh_prediction_accuracy_summary()` (service role / batch); neither server rollup nor the snapshot table is exposed in the app UI here.
