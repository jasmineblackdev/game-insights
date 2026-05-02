/**
 * /settings — App preferences only.
 *
 * Phase 1 of the consolidation: this used to be PicksPage (a full
 * "My Picks" tracking surface). Tracking has moved to Paper, which
 * is now the single source of truth for both manual and auto-
 * generated bets. Settings keeps just the per-user toggles —
 * Sharp Mode for now, more to come.
 *
 * Anything tracking-shaped in here would re-create the duplication
 * we just removed. If you need to look up resolved/pending/draft
 * bets, that's /paper.
 */

import { Link } from "react-router-dom";
import { ArrowRight, Settings as SettingsIcon } from "lucide-react";
import { SharpModeSettings } from "@/components/SharpModeSettings";
import { SleeperAccountPanel } from "@/components/settings/SleeperAccountPanel";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container max-w-2xl mx-auto py-6 sm:py-8 space-y-6">
        <div className="flex items-center gap-2">
          <SettingsIcon className="w-5 h-5 text-primary" />
          <div>
            <h1 className="font-display font-bold text-xl text-foreground">Settings</h1>
            <p className="text-[11px] text-muted-foreground">
              Per-user preferences. Bet tracking lives in Paper.
            </p>
          </div>
        </div>

        <SharpModeSettings />

        <SleeperAccountPanel />

        <Link
          to="/paper"
          className="flex items-center justify-between rounded-lg border border-border bg-card/40 px-4 py-3 hover:bg-card transition-colors"
        >
          <div>
            <p className="text-sm font-semibold text-foreground">Bet history</p>
            <p className="text-[11px] text-muted-foreground">
              Drafts, open bets, and settled results all live in Paper.
            </p>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground" />
        </Link>
      </main>
    </div>
  );
}
