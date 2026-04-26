/**
 * oddsApiHealth — global tripwire for odds-provider failures.
 *
 * fetchOddsForSport calls markOddsApiStale() when the provider
 * returns a quota / freq-limit / unknown-sport / invalid-market /
 * 5xx response. The StaleLinesBanner subscribes to this store via
 * useOddsApiHealth() and renders a sticky warning so users know the
 * lines on screen may be cached or mocked.
 *
 * Auto-clears after a successful response — the banner only stays up
 * while the next fetch attempt is also failing.
 */

import { useEffect, useState } from "react";

type StaleReason = "quota" | "freq_limit" | "unknown_sport" | "invalid_market" | "network" | "other";

export interface OddsHealthState {
  /** True when at least one provider call failed in a way that means the data on screen is stale or fake. */
  stale: boolean;
  /** Most recent failure reason. */
  reason?: StaleReason;
  /** Sport key that failed (when known). */
  sportKey?: string;
  /** ISO timestamp of the failure. */
  occurredAt?: string;
  /** Human-readable label for the banner. */
  message?: string;
}

let state: OddsHealthState = { stale: false };
const listeners = new Set<(s: OddsHealthState) => void>();

function emit(): void {
  for (const l of listeners) l(state);
}

const REASON_MESSAGES: Record<StaleReason, string> = {
  quota:           "Odds provider quota exhausted — lines may be cached or mocked.",
  freq_limit:      "Odds provider rate-limited — lines may be a few minutes stale.",
  unknown_sport:   "Sport key unsupported by odds provider — falling back to historical lines.",
  invalid_market:  "Market not supported by odds provider — falling back to standard markets.",
  network:         "Odds provider unreachable — using cached lines.",
  other:           "Odds provider returned an error — lines may be stale.",
};

export function markOddsApiStale(args: { reason: StaleReason; sportKey?: string }): void {
  state = {
    stale: true,
    reason: args.reason,
    sportKey: args.sportKey,
    occurredAt: new Date().toISOString(),
    message: REASON_MESSAGES[args.reason],
  };
  emit();
}

export function clearOddsApiStale(): void {
  if (!state.stale) return;
  state = { stale: false };
  emit();
}

/**
 * Detect a stale signal from a fetch Response. Returns true when the
 * caller should treat the data as stale (and the global state has
 * been updated). False on healthy responses.
 */
export async function trackOddsResponse(
  res: Response | null | undefined,
  sportKey: string,
): Promise<boolean> {
  if (!res) {
    markOddsApiStale({ reason: "network", sportKey });
    return true;
  }
  if (res.ok) {
    clearOddsApiStale();
    return false;
  }
  // Inspect body for the the-odds-api error_code; never re-throw.
  let body: { message?: string; error_code?: string } = {};
  try { body = await res.clone().json(); } catch { /* non-JSON */ }
  const code = (body.error_code ?? "").toUpperCase();
  if (res.status === 401 && code === "OUT_OF_USAGE_CREDITS") {
    markOddsApiStale({ reason: "quota", sportKey });
    return true;
  }
  if (res.status === 429 || code === "EXCEEDED_FREQ_LIMIT") {
    markOddsApiStale({ reason: "freq_limit", sportKey });
    return true;
  }
  if (res.status === 404 && code === "UNKNOWN_SPORT") {
    markOddsApiStale({ reason: "unknown_sport", sportKey });
    return true;
  }
  if (res.status === 422 && code === "INVALID_MARKET") {
    markOddsApiStale({ reason: "invalid_market", sportKey });
    return true;
  }
  if (res.status >= 500) {
    markOddsApiStale({ reason: "network", sportKey });
    return true;
  }
  // Other 4xx (bad request etc) — flag as "other" but keep the
  // banner short-lived; subsequent successful calls clear it.
  markOddsApiStale({ reason: "other", sportKey });
  return true;
}

/** React hook — subscribes to the store and triggers rerenders. */
export function useOddsApiHealth(): OddsHealthState {
  const [s, setS] = useState<OddsHealthState>(state);
  useEffect(() => {
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}
