/**
 * StaleLinesBanner — sticky banner at the top of the app when the
 * odds provider is failing (quota exhausted, rate-limited, sport
 * key unsupported, etc). Critical safety surface for a betting app:
 * users should never stake real money against silently-cached or
 * mocked odds without knowing.
 *
 * Mounted at App.tsx root. Subscribes to oddsApiHealth's global
 * store so any failed provider call lights it up; auto-clears on
 * the next successful response.
 */

import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";
import { useOddsApiHealth, clearOddsApiStale } from "@/lib/oddsApiHealth";
import { cn } from "@/lib/utils";

export function StaleLinesBanner() {
  const health = useOddsApiHealth();
  const [dismissed, setDismissed] = useState(false);

  if (!health.stale || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "sticky top-0 z-50 w-full",
        "bg-amber-500/95 dark:bg-amber-600/90 text-white",
        "border-b border-amber-700/40 shadow-md",
      )}
    >
      <div className="container max-w-6xl mx-auto px-3 py-2 flex items-center gap-2 text-xs">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <p className="flex-1 font-semibold leading-snug">
          {health.message ?? "Odds provider returned an error — lines may be stale."}
          {health.sportKey ? (
            <span className="ml-1 font-normal opacity-90">({health.sportKey})</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => {
            clearOddsApiStale();
            setDismissed(true);
          }}
          aria-label="Dismiss"
          className="shrink-0 rounded-full p-1 hover:bg-black/10 active:bg-black/20 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
