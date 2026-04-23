# Model assumptions & data tier

## Scoreboard latency

- The app refreshes ESPN scoreboard JSON on an **HTTP poll** cadence.
- When a feed contains at least one **live** game, polling defaults to **~10s** (configurable via `VITE_SCOREBOARD_POLL_MS_LIVE`). Idle slates use a slower cadence (`VITE_SCOREBOARD_POLL_MS_IDLE`).
- **True sub-second or sub-10s play-by-play** still requires a **partner streaming API** (WebSockets / server push). Poll tuning only approximates fresher scores.

## Live player props (main game cards)

- After the same sport checkpoints as team live picks (Q1 / F5 / round-1, etc.), props are re-ranked with `live_prop_score` in `src/lib/livePropRanking.ts` using live heuristics (pace, score margin, inning). Signals are **not** play-by-play feeds.

## Minutes, snap count, and usage role edges

- **NBA / NFL player props** (`src/lib/valueParlay/playerPropEngine.ts`): baselines blend **last-five and season averages** from card-level trend data, with **team pace** (and similar) as a coarse adjustment. This is **not** a minutes model, snap-share model, or coaching-usage model.

Constants: `src/lib/modelAssumptions.ts` (`PLAYER_PROP_MINUTES_OR_SNAP_MODEL`).

## Learning & accuracy

- **Browser**: `src/lib/predictionLearningStorage.ts` stores rollups (e.g. `gamelens-learn-v1-accuracy-summary`) in **localStorage** for calibration helpers. No product UI is required for this tier.
- **Supabase**:
  - `prediction_accuracy_summary` is rebuilt from `prediction_outcome_log` via `refresh_prediction_accuracy_summary()` (service role / batch). It is **not** the same shape as the client JSON blob.
  - Optional **per-user mirror**: when `VITE_SYNC_CLIENT_LEARNING_TO_SUPABASE=1` and the user is signed in, snapshots sync to `user_learning_snapshots` (see migration). This backs up client learning only; it does not replace server rollups.
