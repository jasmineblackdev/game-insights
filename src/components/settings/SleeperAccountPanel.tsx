/**
 * Sleeper Account panel — Settings surface for linking a Sleeper
 * username to the GameLens session.
 *
 * What it does today (visibility-only):
 *   • Stores the user's preferred Sleeper username in localStorage
 *     (`gamelens-sleeper-username`).
 *   • Looks up the user via the proxy and shows their display name
 *     + numeric user_id.
 *   • Lists their leagues across NFL / NBA / MLB for the current
 *     and prior season — empty state when none exist.
 *
 * What it explicitly does NOT do:
 *   • Pull the user's roster, lineup, or fantasy projections into
 *     the recommendation pipeline. Future commits can wire those
 *     in once the user has decided how much weight personal
 *     fantasy intel should carry against the model's edges.
 *   • Auth / login. Sleeper's username endpoint is public, no
 *     login required, so the user can connect any Sleeper
 *     username they know.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, User, Link2, Link2Off } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  fetchSleeperUser,
  fetchSleeperUserLeagues,
  type SleeperLeague,
  type SleeperSport,
  type SleeperUser,
} from "@/lib/sleeperFetch";

const STORAGE_KEY = "gamelens-sleeper-username";
const DEFAULT_USERNAME = "jazzblackartist";
const SPORTS: SleeperSport[] = ["nfl", "nba", "mlb"];

function currentSeason(): number {
  // NFL season label uses the year the regular season starts. The
  // simplest universal definition: use the current calendar year.
  // Sleeper accepts either the kickoff year or the year+1 for
  // year-round leagues; our consumer code shows both seasons so
  // off-season returns aren't wrongly empty.
  return new Date().getFullYear();
}

interface LookupState {
  user:    SleeperUser | null;
  leagues: Array<{ sport: SleeperSport; season: number; rows: SleeperLeague[] }>;
}

export function SleeperAccountPanel() {
  const [username, setUsername] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_USERNAME;
    return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_USERNAME;
  });
  const [draft, setDraft]       = useState(username);
  const [loading, setLoading]   = useState(false);
  const [state, setState]       = useState<LookupState | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const seasons = useMemo(() => {
    const cur = currentSeason();
    return [cur, cur - 1];
  }, []);

  const lookup = async (name: string) => {
    if (!name.trim()) {
      setError("Enter a Sleeper username.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const user = await fetchSleeperUser(name);
      if (!user) {
        setState(null);
        setError(`No Sleeper user found for "${name}".`);
        return;
      }
      // Pull leagues for both seasons across the supported sports.
      // Six small requests, all parallel — quick even on the proxy.
      const tasks = SPORTS.flatMap((sport) =>
        seasons.map((season) =>
          fetchSleeperUserLeagues(user.user_id, sport, season).then((rows) => ({
            sport, season, rows,
          })),
        ),
      );
      const allLeagues = await Promise.all(tasks);
      setState({
        user,
        // Drop empty (sport, season) pairs so the panel doesn't
        // show six "no leagues" rows for a quiet account.
        leagues: allLeagues.filter((l) => l.rows.length > 0),
      });
      // Persist on success only — no point storing a username that
      // doesn't resolve.
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, name.trim());
      }
      setUsername(name.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  // Auto-lookup on mount with the stored / default username so the
  // panel is populated by the time the user scrolls to it.
  useEffect(() => {
    void lookup(username);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnect = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setUsername("");
    setDraft("");
    setState(null);
    setError(null);
    toast.message("Sleeper account disconnected from this device.");
  };

  return (
    <section className="rounded-lg border border-border bg-card/40 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-display font-bold text-foreground flex items-center gap-2">
            <User className="w-4 h-4 text-primary" />
            Sleeper account
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Link your Sleeper username so GameLens can show your fantasy leagues.
            Visibility only — your roster never feeds into pick scoring.
          </p>
        </div>
        {state?.user ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={disconnect}
            className="h-7 gap-1 text-xs text-muted-foreground"
          >
            <Link2Off className="w-3 h-3" />
            Disconnect
          </Button>
        ) : null}
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Sleeper username
          </p>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="jazzblackartist"
            className="h-9 text-sm"
            onKeyDown={(e) => { if (e.key === "Enter") void lookup(draft); }}
          />
        </div>
        <Button
          size="sm"
          onClick={() => void lookup(draft)}
          disabled={loading || !draft.trim()}
          className="h-9 gap-1"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
          {loading ? "Looking up…" : "Connect"}
        </Button>
      </div>

      {error ? (
        <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>
      ) : null}

      {state?.user ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.04] px-3 py-2 text-xs space-y-1">
          <p className="font-semibold text-foreground flex items-center gap-2">
            {state.user.display_name}
            <span className="text-muted-foreground font-normal">@{state.user.username}</span>
          </p>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            user_id {state.user.user_id}
          </p>
        </div>
      ) : null}

      {state?.user ? (
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            Fantasy leagues
          </p>
          {state.leagues.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">
              No leagues found across NFL · NBA · MLB for {seasons.join(", ")}.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {state.leagues.map((bucket) => (
                <li
                  key={`${bucket.sport}-${bucket.season}`}
                  className="rounded-md border border-border/40 bg-background/40 px-3 py-2"
                >
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                    {bucket.sport.toUpperCase()} · {bucket.season} · {bucket.rows.length} league{bucket.rows.length === 1 ? "" : "s"}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {bucket.rows.map((lg) => (
                      <li
                        key={lg.league_id}
                        className="flex items-center justify-between gap-2 text-xs"
                      >
                        <span className="text-foreground truncate">{lg.name}</span>
                        <span className={cn(
                          "shrink-0 text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded-full border",
                          lg.status === "in_season"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                            : lg.status === "complete"
                              ? "bg-muted/40 text-muted-foreground border-border/40"
                              : "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
                        )}>
                          {lg.status.replace(/_/g, " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
