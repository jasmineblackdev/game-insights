/**
 * InjuryBadge — small colored pill that appears next to an NFL
 * player name when Sleeper has them flagged with an active injury.
 *
 * Intentionally narrow scope:
 *   • NFL only (hook is keyed to Sleeper's NFL roster). Pass
 *     `sport` to gate — non-NFL renders null.
 *   • Visibility-only — does NOT influence pick scoring or
 *     recommendations. The user can decide how much weight to
 *     put on a given injury.
 *   • Renders nothing when:
 *       - sport is missing or not NFL
 *       - playerName is missing
 *       - no match in the Sleeper feed (uninjured or unknown)
 *       - the feed is still loading (avoids a flash of unstyled
 *         absence on first paint)
 *
 * Uses the shared `useNflInjuries` hook so every instance on a
 * page reads from the same React-Query cache — one network call
 * for the whole roster, used by every badge.
 */

import { cn } from "@/lib/utils";
import { useNflInjuries } from "@/hooks/useNflInjuries";

interface Props {
  playerName: string | null | undefined;
  /** "NFL" / "nfl" / etc. Anything else returns null. */
  sport: string | null | undefined;
  /** Override styling — caller can shrink to fit a tight row. */
  className?: string;
  /** When true, render a slightly larger pill suitable for hero cards. */
  size?: "xs" | "sm";
}

/**
 * Sleeper status → tone mapping. "Out" / "IR" / "PUP" / "Suspended"
 * are red (the player won't play). "Doubtful" is also red.
 * "Questionable" is amber. Anything else is amber by default —
 * we'd rather over-flag than miss a status.
 */
function toneForStatus(status: string): "red" | "amber" {
  const s = status.trim().toLowerCase();
  if (
    s === "out" ||
    s === "ir" ||
    s === "pup" ||
    s === "doubtful" ||
    s === "suspended" ||
    s.startsWith("ir-")
  ) {
    return "red";
  }
  return "amber";
}

/**
 * Short label rendered inside the pill. We compress Sleeper's full
 * status string to a 2-3 char abbreviation that fits a tight row:
 *   "Questionable" → "Q"
 *   "Doubtful"     → "D"
 *   "Out"          → "OUT"
 *   "IR"           → "IR"
 *   "PUP"          → "PUP"
 *   "Suspended"    → "SUSP"
 * Anything else falls back to the first 4 chars uppercased.
 */
function shortLabel(status: string): string {
  const s = status.trim().toLowerCase();
  if (s === "questionable") return "Q";
  if (s === "doubtful")     return "D";
  if (s === "out")          return "OUT";
  if (s === "ir")           return "IR";
  if (s === "pup")          return "PUP";
  if (s === "suspended")    return "SUSP";
  return status.trim().slice(0, 4).toUpperCase();
}

export function InjuryBadge({ playerName, sport, className, size = "xs" }: Props) {
  const { byNameLower } = useNflInjuries();
  if (!playerName) return null;
  const isNfl = (sport ?? "").toLowerCase() === "nfl";
  if (!isNfl) return null;

  const inj = byNameLower.get(playerName.toLowerCase().trim());
  if (!inj) return null;

  const tone = toneForStatus(inj.injuryStatus);
  const label = shortLabel(inj.injuryStatus);
  const titleParts = [
    inj.injuryStatus,
    inj.injuryBodyPart,
    inj.injuryNotes,
  ].filter(Boolean);
  const title = titleParts.length
    ? `Sleeper: ${titleParts.join(" — ")}`
    : `Sleeper: ${inj.injuryStatus}`;

  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full font-bold uppercase tracking-wide leading-none",
        size === "xs"
          ? "px-1.5 py-0.5 text-[9px]"
          : "px-2 py-0.5 text-[10px]",
        tone === "red"
          ? "bg-red-500/15 text-red-700 dark:text-red-400 border border-red-500/30"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30",
        className,
      )}
    >
      {label}
    </span>
  );
}
