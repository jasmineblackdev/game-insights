/**
 * Manual Parlay Entry — modal form for parlays the user placed outside the
 * app. Saved to recommended_parlays with source='user_manual' so analytics
 * roll-ups can compare app-recommended vs manually-entered performance
 * while keeping them clearly labeled.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, X, Layers, Sparkles, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useValueParlay } from "@/context/ValueParlayContext";
import { bridgeParlayLegs } from "@/lib/learning/parlayLegBridge";

const MAX_SCREENSHOTS = 4;
const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024; // 5 MB cap per image

interface ExtractedParlay {
  combined_american_odds?: number | null;
  wager?: number | null;
  payout?: number | null;
  parlay_outcome?: "won" | "lost" | "push" | "pending" | "partial";
  bet_id?: string | null;
  placed_at?: string | null;
  sport_mix?: string;
  market_mix?: string;
  legs?: Array<{
    selection?: string;
    sport?: string;
    market_type?: string;
    odds?: number | null;
    line_value?: number | null;
    direction?: "MORE" | "LESS" | null;
    stat_type?: string;
    leg_outcome?: "win" | "loss" | "push" | "pending";
    game_label?: string | null;
    final_score?: string | null;
  }>;
}

/** Read a File into a data URI suitable for the edge function. */
function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload  = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

interface ManualLeg {
  id: string;
  selection: string;
  sport: string;
  bet_type: string;
  odds: string;
  /** Per-leg result. Defaults to inheriting parlay-level result; the
   *  screenshot extractor pre-fills this so user only confirms. */
  leg_outcome: "win" | "loss" | "push" | "pending";
  /** Vision-extracted context — passes through to the bridge so the
   *  pattern coach can derive home/away, opponent etc. */
  game_label?: string | null;
  stat_type?: string;
  line_value?: number | null;
  direction?: "MORE" | "LESS" | null;
  final_score?: string | null;
}

const blankLeg = (): ManualLeg => ({
  id: crypto.randomUUID(),
  selection: "",
  sport: "NBA",
  bet_type: "",
  odds: "",
  leg_outcome: "pending",
});

const LEG_OUTCOMES: ("pending" | "win" | "loss" | "push")[] = ["pending", "win", "loss", "push"];

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

  // Screenshot ingestion: drop one or more bet-slip images, the
  // parse-parlay-screenshot edge function calls Anthropic Vision and
  // returns structured parlay JSON. The form pre-fills from that and
  // the user verifies before saving.
  const [screenshots, setScreenshots]   = useState<File[]>([]);
  const [previews, setPreviews]         = useState<string[]>([]);
  const [extracting, setExtracting]     = useState(false);

  // Pull the user's current slip — populates "Import slip" button when
  // they've already built a parlay in the app and want to log it as
  // placed elsewhere instead of retyping every leg.
  const { builderLegs } = useValueParlay();

  const onScreenshotsPicked = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) {
      toast.message("Pick image files only");
      return;
    }
    const oversize = arr.find((f) => f.size > MAX_BYTES_PER_IMAGE);
    if (oversize) {
      toast.error(`"${oversize.name}" is over 5 MB — please pick a smaller screenshot`);
      return;
    }
    const next = [...screenshots, ...arr].slice(0, MAX_SCREENSHOTS);
    setScreenshots(next);
    setPreviews(next.map((f) => URL.createObjectURL(f)));
  };

  const removeScreenshot = (i: number) => {
    const next = screenshots.filter((_, idx) => idx !== i);
    setScreenshots(next);
    setPreviews((p) => {
      const removed = p[i];
      if (removed) URL.revokeObjectURL(removed);
      return next.map((f) => URL.createObjectURL(f));
    });
  };

  /**
   * Pre-fill the form from an extracted parlay. Conservative: we
   * don't blow away values the user has already typed unless the
   * extracted value is non-empty.
   */
  const applyExtracted = (p: ExtractedParlay) => {
    if (Array.isArray(p.legs) && p.legs.length > 0) {
      const next: ManualLeg[] = p.legs.map((l) => ({
        id: typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        selection: l.selection ?? "",
        sport:     sportFromCandidate(String(l.sport ?? "Other")),
        bet_type:  l.market_type ?? "",
        odds:      l.odds != null ? String(l.odds) : "",
        leg_outcome: l.leg_outcome ?? "pending",
        game_label:  l.game_label ?? null,
        stat_type:   l.stat_type,
        line_value:  l.line_value ?? null,
        direction:   l.direction ?? null,
        final_score: l.final_score ?? null,
      }));
      setLegs(next);
    }
    if (p.wager != null && Number.isFinite(p.wager))   setStake(String(p.wager));
    if (p.payout != null && Number.isFinite(p.payout)) setPayout(String(p.payout));
    if (p.parlay_outcome === "won" || p.parlay_outcome === "lost" || p.parlay_outcome === "push" || p.parlay_outcome === "pending") {
      setResult(p.parlay_outcome);
    }
    const noteParts: string[] = [];
    if (p.bet_id)    noteParts.push(`Bet ID: ${p.bet_id}`);
    if (p.placed_at) noteParts.push(`Placed: ${p.placed_at}`);
    noteParts.push("Ingested from screenshot — verify legs before saving.");
    setNotes((prev) => (prev ? `${prev}\n${noteParts.join(" · ")}` : noteParts.join(" · ")));
  };

  const extractFromScreenshots = async () => {
    if (!supabase) { toast.error("Supabase unavailable"); return; }
    if (screenshots.length === 0) { toast.message("Add at least one screenshot"); return; }
    setExtracting(true);
    try {
      const images = await Promise.all(screenshots.map(fileToDataUri));
      const { data, error } = await supabase.functions.invoke<{
        parlay?: ExtractedParlay;
        error?: string;
        detail?: string;
      }>("parse-parlay-screenshot", { body: { images } });
      if (error) throw new Error(error.message);
      if (!data?.parlay) {
        toast.error(data?.error ?? "Could not extract parlay");
        if (data?.detail) console.warn("[parse-parlay-screenshot]", data.detail);
        return;
      }
      applyExtracted(data.parlay);
      const legCount = data.parlay.legs?.length ?? 0;
      toast.success(`Extracted ${legCount} leg${legCount === 1 ? "" : "s"} — verify before saving`);
    } catch (e) {
      toast.error("Screenshot extraction failed");
      console.error(e);
    } finally {
      setExtracting(false);
    }
  };

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
      leg_outcome: "pending",
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

    // Per-leg outcomes: prefer the per-leg value the user (or vision
    // extractor) set. Only fall back to inferring from parlay-level
    // result for legacy rows where leg_outcome is "pending" — and even
    // then, only when parlay-level result is "won" (which requires every
    // leg to have hit). For "lost" / "push" we leave pending legs alone
    // so the bridge skips them.
    const builtLegs = cleanLegs.map((l) => {
      const legOutcome: "win" | "loss" | "push" | "pending" = l.leg_outcome !== "pending"
        ? l.leg_outcome
        : (result === "won" ? "win" : "pending");
      return {
        selection:     l.selection,
        sport:         l.sport,
        market_type:   l.bet_type || "manual",
        american_odds: Number(l.odds),
        implied_prob:  americanToImplied(Number(l.odds)),
        confidence:    "MED",
        model_status:  "user_manual",
        reason_included: "User manual entry",
        leg_outcome:   legOutcome,
        // Vision-extracted context (when available) flows to the bridge
        // for home/away + day-of-week feature derivation.
        game_label:    l.game_label ?? null,
        stat_type:     l.stat_type ?? null,
        line_value:    l.line_value ?? null,
        direction:     l.direction ?? null,
        final_score:   l.final_score ?? null,
      };
    });

    setBusy(true);
    try {
      const { data: inserted, error: insertErr } = await supabase
        .from("recommended_parlays")
        .insert([{
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
          legs:                    builtLegs,
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
        }])
        .select("id, source, date, recommended_at, resolved_at, user_id")
        .single();

      if (insertErr) throw insertErr;
      toast.success("Manual parlay saved");

      // Bridge settled legs into prediction_history. Now that legs
      // carry their own outcomes (from vision extract or per-leg
      // dropdown), we can fire whenever ANY leg has a non-pending
      // outcome — the bridge skips pending legs internally. This
      // captures the legs-that-hit on a losing parlay too.
      const hasSettledLeg = builtLegs.some((l) => l.leg_outcome !== "pending");
      if (inserted && hasSettledLeg) {
        void bridgeParlayLegs({
          id: inserted.id as string,
          source: inserted.source as string,
          date: inserted.date as string,
          recommended_at: inserted.recommended_at as string,
          resolved_at: inserted.resolved_at as string | null,
          user_id: (inserted.user_id as string | null) ?? null,
          legs: builtLegs,
        }).then((r) => {
          if (r.inserted > 0) toast.message(`ML training: bridged ${r.inserted} leg${r.inserted === 1 ? "" : "s"} into prediction_history`);
        }).catch(() => { /* swallow — non-critical */ });
      }

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

        {/* Screenshot ingestion: drop a DraftKings (or any sportsbook)
            bet-slip screenshot, the parse-parlay-screenshot edge fn
            calls Anthropic Vision and pre-fills the form. User
            verifies before saving — vision OCR isn't perfect on
            small text. */}
        <div className="rounded-md border border-dashed border-primary/30 bg-primary/[0.03] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5" />
              Bet slip screenshot{previews.length > 1 ? "s" : ""}{" "}
              <span className="text-[10px] text-muted-foreground/70 font-normal normal-case tracking-normal">
                (up to {MAX_SCREENSHOTS}, ≤5MB each)
              </span>
            </Label>
            {previews.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="default"
                onClick={extractFromScreenshots}
                disabled={extracting}
              >
                {extracting ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting…</> : <><Sparkles className="w-3.5 h-3.5" /> Extract</>}
              </Button>
            ) : null}
          </div>
          {previews.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {previews.map((src, i) => (
                <div key={src} className="relative">
                  <img
                    src={src}
                    alt={`screenshot ${i + 1}`}
                    className="h-20 w-auto rounded border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeScreenshot(i)}
                    className="absolute -top-1 -right-1 bg-background border border-border rounded-full p-0.5 text-muted-foreground hover:text-destructive"
                    aria-label="Remove screenshot"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <label className="flex items-center justify-center gap-2 text-xs text-muted-foreground border border-dashed border-border rounded h-12 cursor-pointer hover:bg-muted/30">
            <Plus className="w-3.5 h-3.5" />
            {previews.length === 0 ? "Add screenshot(s)" : `Add another (${previews.length}/${MAX_SCREENSHOTS})`}
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onScreenshotsPicked(e.target.files)}
              disabled={previews.length >= MAX_SCREENSHOTS}
            />
          </label>
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
                <div className="flex flex-col">
                  <Label className="text-[10px] text-muted-foreground">Hit?</Label>
                  <button
                    type="button"
                    onClick={() => {
                      const i = LEG_OUTCOMES.indexOf(leg.leg_outcome);
                      const next = LEG_OUTCOMES[(i + 1) % LEG_OUTCOMES.length];
                      setLegs((s) => s.map((x) => (x.id === leg.id ? { ...x, leg_outcome: next } : x)));
                    }}
                    title={`Per-leg outcome: ${leg.leg_outcome} (click to cycle)`}
                    className={cn(
                      "h-8 w-8 rounded border text-xs font-bold tabular-nums",
                      leg.leg_outcome === "win"  && "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                      leg.leg_outcome === "loss" && "border-red-500/40 bg-red-500/10 text-red-500",
                      leg.leg_outcome === "push" && "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                      leg.leg_outcome === "pending" && "border-border bg-muted/40 text-muted-foreground",
                    )}
                  >
                    {leg.leg_outcome === "win" ? "W" : leg.leg_outcome === "loss" ? "L" : leg.leg_outcome === "push" ? "P" : "—"}
                  </button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 mt-auto text-muted-foreground hover:text-destructive"
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
