/**
 * Session-high tracker — keyed by local YYYY-MM-DD so it resets at
 * midnight automatically. Used by the bankroll-discipline trailing
 * drawdown signal: WAIT when current bankroll is ≥15% off today's
 * high.
 *
 * Reads + writes go through localStorage (same persistence model as
 * other bankroll state). Returns the current value or null when
 * unavailable / errored.
 */

const PREFIX = "gamelens-session-high";

function todayLocalYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function key(): string {
  return `${PREFIX}:${todayLocalYmd()}`;
}

export function readSessionHigh(): number | null {
  try {
    const raw = localStorage.getItem(key());
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Update the session high if `current` exceeds the stored max.
 * Returns the (possibly updated) high value. No-op when the new
 * value isn't higher.
 */
export function pokeSessionHigh(current: number): number {
  if (!Number.isFinite(current)) return current;
  const existing = readSessionHigh();
  if (existing != null && current <= existing) return existing;
  try {
    localStorage.setItem(key(), String(current));
  } catch {
    /* private mode — ignore */
  }
  return current;
}
