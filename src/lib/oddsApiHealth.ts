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

/**
 * Per-sport lockout — when the provider returns a hard quota error
 * (OUT_OF_USAGE_CREDITS, EXCEEDED_FREQ_LIMIT) we stop hitting that
 * sport for LOCKOUT_TTL_MS so we don't burn through retry budget on
 * a request that's guaranteed to fail. Soft errors (UNKNOWN_SPORT,
 * INVALID_MARKET) don't trigger a lockout — those are bugs in our
 * params and the dev needs to see them, not a quota issue.
 */
const LOCKOUT_TTL_MS = 5 * 60 * 1000;
const lockedUntil = new Map<string, number>();

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
  // Hard-quota responses lock the sport out for LOCKOUT_TTL_MS so we
  // don't retry the same dead request every poll cycle. Networking
  // errors lock too — a sport whose endpoint is unreachable shouldn't
  // be hammered every 30s.
  if ((args.reason === "quota" || args.reason === "freq_limit" || args.reason === "network") && args.sportKey) {
    lockedUntil.set(args.sportKey.toLowerCase(), Date.now() + LOCKOUT_TTL_MS);
  }
  emit();
}

/**
 * Returns true when the sport is in lockout AND the TTL hasn't elapsed.
 * Callers (oddsApiFetch, multiOddsProvider) check this before firing
 * a request and skip the call when locked. Auto-expires.
 */
export function isOddsSportLocked(sportKey: string | undefined): boolean {
  if (!sportKey) return false;
  const until = lockedUntil.get(sportKey.toLowerCase());
  if (!until) return false;
  if (Date.now() >= until) {
    lockedUntil.delete(sportKey.toLowerCase());
    return false;
  }
  return true;
}

/** Test/debug — clear all sport lockouts. */
export function _clearOddsSportLockouts(): void {
  lockedUntil.clear();
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

/**
 * Imperative read of the current health state. Used by code paths
 * that aren't React components (e.g. the system-summary aggregator
 * for Data Health), where subscribing via the hook would force a
 * component-y rewrite for no benefit. Returns a copy.
 */
export function getOddsApiHealthSnapshot(): OddsHealthState {
  return { ...state };
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
