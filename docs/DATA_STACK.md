# GameLens data & API stack

This document is the **target architecture** for a multi-sport MVP and phased enrichment. The **current web app** uses ESPN (and optional football-data.org / The Odds API) as a client-side stand-in until SportsDataIO + Supabase ingestion lands.

---

## Recommended base stack (MVP)

| Layer | Choice | Role |
|--------|--------|------|
| **Operational feed** | **SportsDataIO** | Cross-sport: scores, stats, injuries, lineups / depth charts, standings for NBA, NFL, MLB, Boxing, UFC/MMA. |
| **Backend** | **Supabase** | Database, auth, Edge Functions (proxy CORS / secrets), optional ingestion cron. |
| **Push** | **Firebase Cloud Messaging** | Alerts on lineup / injury / pitcher / kickoff changes. |
| **Mobile** | **React Native** | Same product surface as web long-term. |

**Deeper intelligence (phased)**

| Add-on | Use |
|--------|-----|
| **Sportradar** | MLB push probable pitchers + real-time lineups. |
| **The Odds API** | Boxing / UFC moneyline odds, optional US-book lines across supported sports. |

---

## Side-by-side sport matrix

| Sport | Main prediction drivers | Must-have data | Nice-to-have | MVP API |
|-------|-------------------------|----------------|--------------|---------|
| **NBA** | Injuries, rotations, usage, rest, matchup style | Schedules, injuries, lineups/depth, player/team stats, standings | Odds, news | SportsDataIO NBA |
| **NFL** | QB form, OL vs pass rush, injuries, depth stability, RZ, turnovers, rest | Schedules, injuries, depth charts, stats, standings | Odds, news, return timelines | SportsDataIO NFL |
| **MLB** | Probable/confirmed SP, bullpen fatigue, splits, lineup strength | Schedules, projected/confirmed lineups & pitchers, injuries, splits, pitch data | Statcast, push SP changes | SportsDataIO MLB (+ Sportradar push) |
| **Boxing** | Style matchup, recent form, KO power, reach/height, age curve | Fight schedules, results, opening odds | Round-by-round stats, landed/thrown punches | The Odds API + ESPN |
| **UFC/MMA** | Striking vs grappling style, layoff, cardio, camp changes | Fight schedules, results, opening odds | Fight camp history, finish rates | The Odds API + ESPN |

---

## Per-sport MVP model outputs

### NBA

- Win probability, confidence, top 3 reasons, biggest risk, injury impact, **what changed** since last update.

### NFL

- Win probability, confidence, trench edge, QB edge, injury risk, upset path.

### MLB

- Win probability, starter edge, bullpen risk, handedness edge, lineup confidence, **prediction pending pitcher confirmation** when applicable.

### Boxing / UFC-MMA

- Moneyline win probability, style-matchup edge, finish-method probabilities (KO/TKO, submission, decision), round-total O/U, recent-form confidence.

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
| Boxing | `boxing_fighters`, `boxing_fights`, `boxing_predictions`, `boxing_prediction_factors` |
| UFC/MMA | `mma_fighters`, `mma_fights`, `mma_predictions`, `mma_prediction_factors` |

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

SportsDataIO + Supabase + FCM + React Native (single operational vendor across NBA, NFL, MLB; Boxing / UFC via The Odds API + ESPN).

### Phase 2 — Smarter analytics

Sportradar MLB (push probable pitchers, richer lineups); deeper combat-sport camp/style feeds.

### Phase 3 — Premium

Odds comparison, line movement, news/sentiment, accuracy dashboards by sport (SportsDataIO can supply odds/market data when you enable it).

---

## Current web repo (interim)

| Source | Role |
|--------|------|
| ESPN site API | Live scoreboards, injuries, summaries (browser; proxy if blocked). |
| The Odds API | Optional US-book spreads + MLB **F5 (first 5 innings)** leg lines; Boxing / UFC / MMA moneylines. List keys anytime with `GET /v4/sports/?all=true` (free, no quota). |

Treat this as **demo/iteration** until data is normalized through Supabase per the pipeline above.

Structured machine-readable definitions: `src/lib/dataStack.ts`.

---

## GameLens learning intelligence (Supabase)

Migration `20260421100000_gamelens_learning_intelligence.sql` adds server-side learning storage (no product UI changes):

| Object | Role |
|--------|------|
| `prediction_history` | One row per settled pick: sport, market type, pick, odds, implied/model prob, edge, confidence, risk score, reason tags, checkpoint, phase, scores, outcome, error size, odds bucket. |
| `prediction_error_tags` / `prediction_history_error_tags` | Miss attribution codes (injury, lineup, blowout, market move, …). |
| `prediction_learning_results` | Optional Brier / calibration residual per history row (not the legacy `prediction_results` player-prop table). |
| `feature_weight_history` | Phase-3 weight change audit (min samples enforced in app/SQL before apply). |
| `confidence_calibration_history` | Empirical hit rates by sport × confidence × phase. |
| `market_accuracy_summary` / `checkpoint_accuracy_summary` | Rollups via `refresh_learning_*` (service role); **minimum sample sizes** in SQL. |
| `learning_internal_suggestions()` | Internal hint strings when aggregates are sufficient. |
| `submit_prediction_learning_record` | RPC used by `src/lib/predictionLearningIntelligence.ts` (browser + optional auth). |

Phases: **1** = logging + rollups, **2** = calibration/threshold tuning from history, **3** = adaptive weights. Set `VITE_LEARNING_ENGINE_PHASE` to tag rows; tuning jobs remain service-side.

---

## Not in this pass (limits)

- **Sub-10s scoreboard streaming** — True near–real-time play-by-play still needs ESPN or partner **WebSockets** or **server push**. The SPA uses **HTTP polling** only; when a scoreboard feed has at least one **live** game, polling defaults to **~10s** (see `VITE_SCOREBOARD_POLL_MS_LIVE` in `.env.example` and `src/lib/scoreboardPollConfig.ts`). That tightens freshness but is **not** a streaming stack.

- **Minutes / snap / usage role models** — Player prop signals use **trend + pace heuristics** until real minutes, snap, and usage-event feeds exist. See `docs/MODEL_ASSUMPTIONS.md` and `src/lib/modelAssumptions.ts`.

- **Accuracy / learning persistence (no product UI)** — Client rollups live in **localStorage** via `src/lib/predictionLearningStorage.ts` (e.g. `gamelens-learn-v1-accuracy-summary`). **Optional**: set `VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE=1` with a signed-in user to upsert a mirror into `user_learning_snapshots` (migration `20260410200000_user_learning_snapshots.sql`). Server rollup `prediction_accuracy_summary` is still built from `prediction_outcome_log` via `refresh_prediction_accuracy_summary()` (service role / batch); neither server rollup nor the snapshot table is exposed in the app UI here.
