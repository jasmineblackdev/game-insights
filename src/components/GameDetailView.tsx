import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { GamePrediction } from "@/data/mockGames";
import { useEdgeCardOptional } from "@/context/EdgeCardContext";
import { getFavoredSide, type EdgeSide } from "@/lib/edgeCardScoring";
import { Button } from "@/components/ui/button";
import { TeamLogo } from "./TeamLogo";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { InjuryImpactMeter } from "./InjuryImpactMeter";
import { PlayerTrendCard } from "./PlayerTrendCard";
import { ArrowLeft, Zap, AlertTriangle, Target, Swords, Clock, RefreshCw, DollarSign, Info, Cloud, Layers, Plus } from "lucide-react";

interface GameDetailViewProps {
  game: GamePrediction;
  onBack: () => void;
}

export function GameDetailView({ game, onBack }: GameDetailViewProps) {
  const edge = useEdgeCardOptional();
  const tw = game.threeWay;
  const favoredSide = getFavoredSide(game);
  const favored = game.winProbability.home >= game.winProbability.away ? "home" : "away";
  const favoredTeam = favored === "home" ? game.homeTeam : game.awayTeam;
  const favoredProb = favored === "home" ? game.winProbability.home : game.winProbability.away;
  const ringProb = tw ? Math.max(tw.home, tw.away) : favoredProb;

  const updatedAt = new Date(game.lastUpdated);
  const timeAgo = Math.round((Date.now() - updatedAt.getTime()) / 60000);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
      className="space-y-4"
    >
      {/* Back + Header */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to games
      </button>

      {/* Matchup Header */}
      <div className="card-shine bg-card rounded-lg border border-border p-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{game.gameTime}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {game.situationalTags.map((tag) => (
              <span key={tag} className="text-[10px] font-semibold tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-6 justify-center py-4">
          <div className={`text-center ${favored === "away" ? "" : "opacity-50"}`}>
            <div className="mb-2 flex justify-center">
              <TeamLogo logo={game.awayTeam.logo} size="lg" />
            </div>
            <div className="font-display font-bold text-lg text-foreground">{game.awayTeam.name}</div>
            <div className="text-sm text-muted-foreground">{game.awayTeam.record} · {game.awayTeam.recentForm}</div>
            <div className="text-2xl font-display font-bold mt-2 text-foreground">
              {tw ? tw.away : game.winProbability.away}%
            </div>
            {tw ? <div className="text-[11px] text-muted-foreground">win (1X2)</div> : null}
          </div>

          {tw ? (
            <div className="flex flex-col items-center gap-2 shrink-0">
              <div className="text-center">
                <div className="text-[10px] font-semibold text-muted-foreground tracking-wider">DRAW</div>
                <div className="text-3xl font-display font-bold text-foreground">{tw.draw}%</div>
              </div>
              <ConfidenceMeter level={game.confidence} probability={ringProb} showRing={false} />
            </div>
          ) : (
            <ConfidenceMeter level={game.confidence} probability={favoredProb} />
          )}

          <div className={`text-center ${favored === "home" ? "" : "opacity-50"}`}>
            <div className="mb-2 flex justify-center">
              <TeamLogo logo={game.homeTeam.logo} size="lg" />
            </div>
            <div className="font-display font-bold text-lg text-foreground">{game.homeTeam.name}</div>
            <div className="text-sm text-muted-foreground">{game.homeTeam.record} · {game.homeTeam.recentForm}</div>
            <div className="text-2xl font-display font-bold mt-2 text-foreground">
              {tw ? tw.home : game.winProbability.home}%
            </div>
            {tw ? <div className="text-[11px] text-muted-foreground">win (1X2)</div> : null}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="w-3 h-3" />
          Updated {timeAgo > 0 ? `${timeAgo}m ago` : "just now"}
        </div>

        {edge && game.status === "upcoming" ? (
          <div className="mt-5 pt-4 border-t border-border flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5 font-semibold"
              disabled={edge.isOnSlip(game.id)}
              onClick={() => {
                const r = edge.addPick(game, favoredSide);
                if (r.ok) {
                  toast.success(
                    `Added ${favoredSide === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} to Edge Card`
                  );
                } else toast.message(r.message ?? "Could not add");
              }}
            >
              <Plus className="w-3.5 h-3.5" />
              {edge.isOnSlip(game.id) ? "On Edge Card" : `Add ${favoredSide === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} to Edge Card`}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={edge.isOnSlip(game.id) || edge.slipFull}
              onClick={() => {
                const other: EdgeSide = favoredSide === "home" ? "away" : "home";
                const r = edge.addPick(game, other);
                if (r.ok) {
                  toast.success(`Added ${other === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} (contrarian)`);
                } else toast.message(r.message ?? "Could not add");
              }}
            >
              Add other side
            </Button>
            <Link
              to="/edge"
              className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-primary hover:underline px-2 py-1.5"
            >
              <Layers className="w-3.5 h-3.5" />
              Open Edge Card builder
            </Link>
          </div>
        ) : null}
      </div>

      {/* Two column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Reasons */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Zap className="w-4 h-4 text-confidence-high" />
            {tw && tw.draw >= Math.max(tw.home, tw.away)
              ? "Why the draw branch is live"
              : `Why ${favoredTeam.abbreviation} is favored to win`}
          </h3>
          <div className="space-y-2.5">
            {game.topReasons.map((reason, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="text-confidence-high font-display font-bold text-xs mt-0.5">{i + 1}</span>
                <span className="text-secondary-foreground">{reason}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Risks */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-risk" />
            Risk Factors
          </h3>
          <div className="space-y-2.5">
            {game.riskFactors.map((risk, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="text-risk font-display font-bold text-xs mt-0.5">!</span>
                <span className="text-secondary-foreground">{risk}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-1.5">UPSET PATH</h4>
            <p className="text-sm text-secondary-foreground">{game.upsetPath}</p>
          </div>
        </div>

        {/* Key Matchup */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Target className="w-4 h-4 text-primary" />
            Key Matchup
          </h3>
          <p className="text-sm text-foreground font-medium mb-4">{game.keyMatchup}</p>

          <div className="space-y-2.5">
            {game.matchupEdges.map((edge) => (
              <div key={edge.label} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{edge.label}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${edge.team === "home" ? "text-confidence-high" : "text-primary"}`}>
                    {edge.team === "home" ? game.homeTeam.abbreviation : game.awayTeam.abbreviation}
                  </span>
                  <span className="text-xs text-secondary-foreground max-w-48 text-right">{edge.description}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Soccer-specific model framing (different from NBA/NFL/MLB scoring). */}
        {game.soccer && (
          <div className="card-shine bg-card rounded-lg border border-border p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-primary" />
              Soccer model layer · {game.soccer.competition}
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Predictions here foreground <span className="text-foreground font-semibold">1X2 implied prices</span>{" "}
              (de-vig) and table context — not the same “spread-first” engine as NBA/NFL/MLB. Layer vendor data for xG,
              congestion, lineups, and set pieces to replace placeholders below.
            </p>
            {(game.soccer.congestion ||
              game.soccer.table?.homePosition != null ||
              game.soccer.table?.awayPosition != null) && (
              <div className="rounded-lg bg-muted/25 border border-border p-3 mb-4 text-xs space-y-2 text-secondary-foreground">
                {game.soccer.table?.homePosition != null && game.soccer.table?.awayPosition != null && (
                  <p>
                    <span className="font-semibold text-foreground">Table · </span>
                    {game.homeTeam.abbreviation} {game.soccer.table.homePosition}th
                    {game.soccer.table.homePoints != null ? ` (${game.soccer.table.homePoints} pts)` : ""} vs{" "}
                    {game.awayTeam.abbreviation} {game.soccer.table.awayPosition}th
                    {game.soccer.table.awayPoints != null ? ` (${game.soccer.table.awayPoints} pts)` : ""}
                    {game.soccer.scheduleSource === "football-data.org" ? " · football-data.org" : ""}
                  </p>
                )}
                {game.soccer.congestion && (
                  <p>
                    <span className="font-semibold text-foreground">Fixture congestion · </span>
                    Completed PL matches: {game.homeTeam.abbreviation}{" "}
                    {game.soccer.congestion.homeLast7} in last 7d / {game.soccer.congestion.homeLast14} in 14d ·{" "}
                    {game.awayTeam.abbreviation} {game.soccer.congestion.awayLast7} in 7d /{" "}
                    {game.soccer.congestion.awayLast14} in 14d
                    {game.soccer.scheduleSource === "espn-scoreboard"
                      ? " (ESPN scoreboard finals; 7d window only — add API token for 14d via football-data.org)"
                      : " (football-data.org)"}
                  </p>
                )}
              </div>
            )}
            <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wide mb-1.5">WHAT TO SCORE NEXT</h4>
            <ul className="space-y-2 text-sm text-secondary-foreground list-disc list-inside mb-4">
              {game.soccer.modelNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
            <h4 className="text-[10px] font-semibold text-muted-foreground tracking-wide mb-1.5">DATA GAPS (THIS BUILD)</h4>
            <ul className="space-y-1.5 text-xs text-muted-foreground list-disc list-inside">
              {game.soccer.dataGaps.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {/* MLB-specific model layer */}
        {game.mlb && (
          <div className="card-shine bg-card rounded-lg border border-border p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Info className="w-4 h-4 text-primary" />
              MLB pregame model layer
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Starter certainty: <span className="text-foreground font-semibold">{game.mlb.pitcherCertainty}</span>
              {game.mlb.awayProbablePitcher || game.mlb.homeProbablePitcher
                ? ` · Away: ${game.mlb.awayProbablePitcher ?? "TBD"} (${game.mlb.awayPitcherHand ?? "?"}) · Home: ${game.mlb.homeProbablePitcher ?? "TBD"} (${game.mlb.homePitcherHand ?? "?"})`
                : " · Probable starters not in this ESPN payload — treat win probability as low-certainty until confirmed."}
            </p>
            <ul className="space-y-2 text-sm text-secondary-foreground list-disc list-inside">
              {game.mlb.modelNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Enrichment: series, PickCenter, weather, Odds API */}
        {game.enrichmentNotes && game.enrichmentNotes.length > 0 && (
          <div className="card-shine bg-card rounded-lg border border-border p-5 lg:col-span-2">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
              <Cloud className="w-4 h-4 text-muted-foreground" />
              Data feed notes
            </h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {game.enrichmentNotes.map((note, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-primary shrink-0">•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Injuries */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-3">
            <Swords className="w-4 h-4 text-destructive" />
            Injury Report
          </h3>
          <div className="space-y-4">
            <InjuryImpactMeter injuries={game.injuries.away} teamAbbr={game.awayTeam.abbreviation} />
            <InjuryImpactMeter injuries={game.injuries.home} teamAbbr={game.homeTeam.abbreviation} />
          </div>
        </div>

        {/* Player Trends - Away */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3 flex items-center gap-2">
            <TeamLogo logo={game.awayTeam.logo} size="md" />
            {game.awayTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.away.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">No leader stats in the feed for this game.</p>
            ) : (
              game.playerTrends.away.map((player) => (
                <PlayerTrendCard key={player.name} player={player} />
              ))
            )}
          </div>
        </div>

        {/* Player Trends - Home */}
        <div className="card-shine bg-card rounded-lg border border-border p-5">
          <h3 className="font-display font-bold text-sm text-foreground mb-3 flex items-center gap-2">
            <TeamLogo logo={game.homeTeam.logo} size="md" />
            {game.homeTeam.abbreviation} Player Trends
          </h3>
          <div className="divide-y divide-border">
            {game.playerTrends.home.length === 0 ? (
              <p className="text-xs text-muted-foreground py-3">No leader stats in the feed for this game.</p>
            ) : (
              game.playerTrends.home.map((player) => (
                <PlayerTrendCard key={player.name} player={player} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Betting Lines */}
      {game.lines && (game.lines.spread || game.lines.total != null || game.lines.homeMl) && (() => {
        const { spread, total, homeMl, awayMl, drawMl } = game.lines!;
        const modelHome = game.winProbability.home;
        const modelAway = game.winProbability.away;
        const modelFavorsHome = modelHome >= modelAway;
        const spreadFavorsHome = (game.lines.spreadNum ?? 0) < 0;
        const modelVsMarketAgree = modelFavorsHome === spreadFavorsHome;

        if (game.league === "soccer" && tw) {
          return (
            <div className="card-shine bg-card rounded-lg border border-border p-5">
              <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-4">
                <DollarSign className="w-4 h-4 text-confidence-high" />
                Betting Lines (1X2)
                <span className="text-[10px] font-normal text-muted-foreground ml-1">via DraftKings</span>
              </h3>

              <div className="grid grid-cols-3 gap-4 text-center mb-4">
                <div className="bg-muted/30 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">HANDICAP</div>
                  <div className="text-base font-display font-bold text-foreground">{spread ?? "—"}</div>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">TOTAL (O/U)</div>
                  <div className="text-base font-display font-bold text-foreground">
                    {total != null ? total : "—"}
                  </div>
                </div>
                <div className="bg-muted/30 rounded-lg p-3">
                  <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">1X2 PRICES</div>
                  <div className="flex flex-col gap-1 text-xs font-bold text-foreground">
                    <span>
                      {game.awayTeam.abbreviation}{" "}
                      <span className={awayMl?.startsWith("-") ? "text-confidence-high" : ""}>{awayMl ?? "—"}</span>
                    </span>
                    <span>
                      Draw <span className="text-muted-foreground font-semibold">{drawMl ?? "—"}</span>
                    </span>
                    <span>
                      {game.homeTeam.abbreviation}{" "}
                      <span className={homeMl?.startsWith("-") ? "text-confidence-high" : ""}>{homeMl ?? "—"}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-lg p-3 text-xs flex items-start gap-2 bg-muted/20 border border-border">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="text-secondary-foreground">
                  <span className="font-semibold text-foreground">1X2 implied (de-vig): </span>
                  {game.awayTeam.abbreviation} {tw.away}% · Draw {tw.draw}% · {game.homeTeam.abbreviation} {tw.home}
                  %. Soccer uses a different engine than spread sports — these are normalized from the three-way book
                  prices, not an independent xG model. Add StatsBomb / vendor xG to disagree with the market on purpose.
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="card-shine bg-card rounded-lg border border-border p-5">
            <h3 className="font-display font-bold text-sm text-foreground flex items-center gap-2 mb-4">
              <DollarSign className="w-4 h-4 text-confidence-high" />
              Betting Lines
              <span className="text-[10px] font-normal text-muted-foreground ml-1">via DraftKings</span>
            </h3>

            <div className="grid grid-cols-3 gap-4 text-center mb-4">
              {/* Spread */}
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">SPREAD</div>
                <div className="text-base font-display font-bold text-foreground">{spread ?? "—"}</div>
              </div>

              {/* Total */}
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">TOTAL (O/U)</div>
                <div className="text-base font-display font-bold text-foreground">
                  {total != null ? total : "—"}
                </div>
              </div>

              {/* Moneylines */}
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="text-[10px] text-muted-foreground font-semibold tracking-wider mb-1">MONEYLINE</div>
                <div className="flex items-center justify-center gap-2 text-sm font-bold">
                  <span className="text-muted-foreground text-[11px]">{game.awayTeam.abbreviation}</span>
                  <span className={awayMl?.startsWith("-") ? "text-confidence-high" : "text-foreground"}>
                    {awayMl ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-[10px]">/</span>
                  <span className={homeMl?.startsWith("-") ? "text-confidence-high" : "text-foreground"}>
                    {homeMl ?? "—"}
                  </span>
                  <span className="text-muted-foreground text-[11px]">{game.homeTeam.abbreviation}</span>
                </div>
              </div>
            </div>

            {/* Model vs market insight */}
            <div className={`rounded-lg p-3 text-xs flex items-start gap-2 ${modelVsMarketAgree ? "bg-confidence-high/10 border border-confidence-high/20" : "bg-risk/10 border border-risk/20"}`}>
              <Zap className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${modelVsMarketAgree ? "text-confidence-high" : "text-risk"}`} />
              <div>
                <span className={`font-semibold ${modelVsMarketAgree ? "text-confidence-high" : "text-risk"}`}>
                  {modelVsMarketAgree ? "Model aligns with market" : "Model diverges from market"} —{" "}
                </span>
                <span className="text-secondary-foreground">
                  Our model gives {modelFavorsHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation}{" "}
                  a {Math.max(modelHome, modelAway)}% win probability.{" "}
                  {!modelVsMarketAgree
                    ? `The market favors ${spreadFavorsHome ? game.homeTeam.abbreviation : game.awayTeam.abbreviation} — investigate before acting.`
                    : "Confidence and market agree on direction."}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Efficiency Comparison */}
      <div className="card-shine bg-card rounded-lg border border-border p-5">
        <h3 className="font-display font-bold text-sm text-foreground mb-1">Team Stats Comparison</h3>
        {game.league === "nba" && (
          <p className="text-[11px] text-muted-foreground mb-3">
            Numbers are ESPN season PPG / opponent PPG after enrichment. True offensive/defensive rating from{" "}
            <span className="text-foreground/90">stats.nba.com</span> needs a Supabase Edge proxy (CORS).
          </p>
        )}
        {game.league === "soccer" && (
          <p className="text-[11px] text-muted-foreground mb-3">
            Goals for/against per match from ESPN team totals. Possession % and xG require event feeds (e.g. StatsBomb)
            — <span className="text-foreground/90">pace</span> here is a placeholder until wired.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center">
          {(game.league === "nfl"
            ? [
                { label: "PPG", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                { label: "Opp PPG", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                { label: "Plays (est.)", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
              ]
            : game.league === "mlb"
              ? [
                  { label: "Runs/G", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                  { label: "Runs allowed", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                  { label: "Innings", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                ]
              : game.league === "soccer"
                ? [
                    { label: "GF / match", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                    { label: "GA / match", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                    { label: "Poss. (est.)", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                  ]
                : [
                    { label: "PPG", away: game.awayTeam.offensiveRating, home: game.homeTeam.offensiveRating, lowerBetter: false },
                    { label: "Opp PPG", away: game.awayTeam.defensiveRating, home: game.homeTeam.defensiveRating, lowerBetter: true },
                    { label: "Pace (est.)", away: game.awayTeam.pace, home: game.homeTeam.pace, lowerBetter: false },
                  ]
          ).map((stat) => {
            const awayBetter = stat.lowerBetter ? stat.away < stat.home : stat.away > stat.home;
            return (
              <div key={stat.label}>
                <div className="text-xs text-muted-foreground mb-2">{stat.label}</div>
                <div className="flex items-center justify-center gap-3">
                  <span className={`text-sm font-semibold ${awayBetter ? "text-confidence-high" : "text-foreground"}`}>
                    {stat.away}
                  </span>
                  <span className="text-xs text-muted-foreground">vs</span>
                  <span className={`text-sm font-semibold ${!awayBetter ? "text-confidence-high" : "text-foreground"}`}>
                    {stat.home}
                  </span>
                </div>
                <div className="flex justify-center gap-3 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{game.awayTeam.abbreviation}</span>
                  <span className="text-[10px] text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground">{game.homeTeam.abbreviation}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
