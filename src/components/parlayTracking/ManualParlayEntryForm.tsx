/**
 * Manual Parlay Entry — modal form for parlays the user placed outside the
 * app. Saved to recommended_parlays with source='user_manual' so analytics
 * roll-ups can compare app-recommended vs manually-entered performance
 * while keeping them clearly labeled.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, X, Layers, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/lib/supabase";
import { useValueParlay } from "@/context/ValueParlayContext";

interface ManualLeg {
  id: string;
  selection: string;
  sport: string;
  bet_type: string;
  odds: string;
}

const blankLeg = (): ManualLeg => ({
  id: crypto.randomUUID(),
  selection: "",
  sport: "NBA",
  bet_type: "",
  odds: "",
});

const SPORTS = ["NBA", "WNBA", "NFL", "MLB", "Boxing", "MMA", "Other"] as const;

/** Map ValueBetCandidate.sport (lower) → form's SPORTS option (caps). */
function sportFromCandidate(s: string): typeof SPORTS[number] {
  const u = s.toUpperCase();
  if (u === "NBA" || u === "WNBA" || u === "NFL" || u === "MLB" || u === "BOXING" || u === "MMA") {
    return u === "BOXING" ? "Boxing" : u === "MMA" ? "MMA" : (u as typeof SPORTS[number]);
  }
  return "Other";
}
const RESULTS: ("won" | "lost" | "push" | "pending")[] = ["won", "lost", "push", "pending"];

function americanToImplied(american: number): number {
  return american >= 0 ? 100 / (american + 100) : -american / (-american + 100);
}

function combineAmericanOdds(legs: number[]): number {
  if (!legs.length) return 0;
  let dec = 1;
  for (const a of legs) {
    dec *= a >= 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
  }
  return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
}

export function ManualParlayEntryForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [legs, setLegs] = useState<ManualLeg[]>([blankLeg(), blankLeg()]);
  const [stake, setStake]     = useState("");
  const [payout, setPayout]   = useState("");
  const [result, setResult]   = useState<"won" | "lost" | "push" | "pending">("pending");
  const [notes, setNotes]     = useState("");
  const [busy, setBusy]       = useState(false);

  // Pull the user's current slip — populates "Import slip" button when
  // they've already built a parlay in the app and want to log it as
  // placed elsewhere instead of retyping every leg.
  const { builderLegs } = useValueParlay();

  const addLeg    = () => setLegs((s) => [...s, blankLeg()]);
  const removeLeg = (id: string) => setLegs((s) => s.length > 1 ? s.filter((l) => l.id !== id) : s);
  const updateLeg = (id: string, k: keyof ManualLeg, v: string) =>
    setLegs((s) => s.map((l) => (l.id === id ? { ...l, [k]: v } : l)));

  /**
   * Replace the form's legs with the user's current parlay slip from
   * ValueParlayContext. Keeps stake / result / notes untouched so a
   * user can iterate on the same logged bet.
   */
  const importFromSlip = () => {
    if (builderLegs.length === 0) {
      toast.message("Slip is empty — add legs first");
      return;
    }
    const imported: ManualLeg[] = builderLegs.map((l) => ({
      id: typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      selection: l.selectionLabel,
      sport:     sportFromCandidate(String(l.sport)),
      bet_type:  l.statType ?? l.marketType,
      odds:      String(l.americanOdds),
    }));
    setLegs(imported);
    toast.success(`Imported ${imported.length} leg${imported.length === 1 ? "" : "s"} from slip`);
  };

  const submit = async () => {
    if (!supabase) { toast.error("Supabase unavailable"); return; }

    const cleanLegs = legs.filter((l) => l.selection.trim() && l.odds.trim());
    if (cleanLegs.length < 1) {
      toast.error("Add at least one leg with a selection and odds.");
      return;
    }

    const oddsNumbers = cleanLegs
      .map((l) => Number(l.odds))
      .filter((n) => Number.isFinite(n) && n !== 0);
    if (oddsNumbers.length !== cleanLegs.length) {
      toast.error("All leg odds must be numeric American odds (e.g. -110 or +250).");
      return;
    }

    const combined = combineAmericanOdds(oddsNumbers);
    const probs    = oddsNumbers.map((a) => americanToImplied(a));
    const combinedProb = probs.reduce((acc, p) => acc * p, 1);

    const sportMix = [...new Set(cleanLegs.map((l) => l.sport.toLowerCase()))].sort().join(",");
    const stakeNum  = Number(stake)  || null;
    const payoutNum = Number(payout) || null;

    setBusy(true);
    try {
      await supabase.from("recommended_parlays").insert([{
        source:                  "user_manual",
        recommended_at:          new Date().toISOString(),
        date:                    new Date().toISOString().slice(0, 10),
        model_version:           "manual",
        rules_only:              false,
        ml_active:               false,
        tier:                    "manual",
        variant:                 "user_manual",
        sport_mix:               sportMix,
        market_mix:              [...new Set(cleanLegs.map((l) => l.bet_type || "manual"))].join(","),
        legs: cleanLegs.map((l) => ({
          selection:     l.selection,
          sport:         l.sport,
          market_type:   l.bet_type || "manual",
          american_odds: Number(l.odds),
          implied_prob:  americanToImplied(Number(l.odds)),
          confidence:    "MED",
          model_status:  "user_manual",
          reason_included: "User manual entry",
          leg_outcome:   "pending",
        })),
        leg_count:               cleanLegs.length,
        combined_american_odds:  combined,
        payout_multiplier:       Math.round(oddsNumbers.reduce((acc, a) => acc * (a >= 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a)), 1) * 100) / 100,
        combined_probability:    Math.round(combinedProb * 10000) / 10000,
        card_score:              null,
        card_confidence:         null,
        warnings:                [],
        reasons:                 ["User manual entry"],
        user_placed:             true,
        user_stake:              stakeNum,
        user_payout:             payoutNum,
        user_notes:              notes || null,
        outcome:                 result,
        resolved_at:             result !== "pending" ? new Date().toISOString() : null,
        session_dedup_key:       `manual:${Date.now()}:${cleanLegs.map((l) => l.selection).join("|")}`,
      }]);
      toast.success("Manual parlay saved");
      onSaved();
    } catch (e) {
      toast.error("Save failed");
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6 space-y-5 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display font-bold text-xl text-foreground">Manual Parlay Entry</h2>
            <p className="text-xs text-muted-foreground">
              Saved alongside app-recommended parlays for analytics. Source = <span className="font-semibold">user_manual</span>.
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick-import: most common case is logging a parlay the user
            just built in the app. Tap once instead of retyping legs. */}
        {builderLegs.length > 0 ? (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-center justify-between gap-3">
            <div className="text-xs">
              <p className="font-bold text-foreground flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-primary" />
                {builderLegs.length} leg{builderLegs.length === 1 ? "" : "s"} on your slip
              </p>
              <p className="text-muted-foreground mt-0.5">
                Skip the typing — pull them in pre-filled.
              </p>
            </div>
            <Button type="button" size="sm" variant="default" onClick={importFromSlip}>
              <Layers className="w-3.5 h-3.5" />
              Import slip
            </Button>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label className="text-xs font-bold tracking-wider uppercase text-muted-foreground">Legs</Label>
          {legs.map((leg) => (
            <div key={leg.id} className="grid grid-cols-12 gap-2 items-end rounded border border-border/60 bg-background/40 p-2">
              <div className="col-span-5">
                <Label className="text-[10px] text-muted-foreground">Team / Player + bet</Label>
                <Input
                  value={leg.selection}
                  onChange={(e) => updateLeg(leg.id, "selection", e.target.value)}
                  placeholder="e.g. LAL ML"
                  className="h-8 text-xs"
                />
              </div>
              <div className="col-span-2">
                <Label className="text-[10px] text-muted-foreground">Sport</Label>
                <select
                  value={leg.sport}
                  onChange={(e) => updateLeg(leg.id, "sport", e.target.value)}
                  className="h-8 w-full text-xs rounded border border-input bg-background px-2"
                >
                  {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="col-span-3">
                <Label className="text-[10px] text-muted-foreground">Bet type</Label>
                <Input
                  value={leg.bet_type}
                  onChange={(e) => updateLeg(leg.id, "bet_type", e.target.value)}
                  placeholder="moneyline / spread / prop"
                  className="h-8 text-xs"
                />
              </div>
              <div className="col-span-2 flex gap-1">
                <div className="flex-1">
                  <Label className="text-[10px] text-muted-foreground">Odds</Label>
                  <Input
                    value={leg.odds}
                    onChange={(e) => updateLeg(leg.id, "odds", e.target.value)}
                    placeholder="-110"
                    className="h-8 text-xs tabular-nums"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeLeg(leg.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addLeg} className="gap-1">
            <Plus className="w-3.5 h-3.5" />
            Add leg
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div>
            <Label className="text-[10px] text-muted-foreground">Stake ($)</Label>
            <Input value={stake} onChange={(e) => setStake(e.target.value)} placeholder="10.00" className="h-8 text-xs tabular-nums" />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Payout ($)</Label>
            <Input value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="48.50" className="h-8 text-xs tabular-nums" />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground">Result</Label>
            <select
              value={result}
              onChange={(e) => setResult(e.target.value as typeof result)}
              className="h-8 w-full text-xs rounded border border-input bg-background px-2 capitalize"
            >
              {RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <div>
          <Label className="text-[10px] text-muted-foreground">Notes</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything worth remembering about this parlay…"
            rows={2}
            className="text-xs"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save parlay"}
          </Button>
        </div>
      </div>
    </div>
  );
}
