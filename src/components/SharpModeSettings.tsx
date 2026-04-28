/**
 * SharpModeSettings — toggle + threshold tuning surface for the
 * disciplined edge-only mode. Embeddable; today lives at the top of
 * PicksPage but can be dropped into a dedicated Settings route later.
 */

import { useEffect } from "react";
import { Crosshair, Crown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useSharpMode } from "@/context/SharpModeContext";
import { useProMode } from "@/context/ProModeContext";
import { SHARP_DEFAULTS } from "@/lib/learning/sharpMode";

export function SharpModeSettings() {
  const { enabled, thresholds, setEnabled, setThresholds, reset } = useSharpMode();
  const pro = useProMode();

  // Pro Mode forces Sharp on as a dependency — Sharp's filter pipeline
  // is what produces the candidates the Pro pipeline ranks by EV.
  // Toggling Sharp off while Pro is on is non-sensical, so we lock it.
  useEffect(() => {
    if (pro.enabled && !enabled) setEnabled(true);
  }, [pro.enabled, enabled, setEnabled]);

  return (
    <div className="space-y-4">
      {/* Pro Mode toggle — top-of-stack since it cascades. */}
      <section className="rounded-lg border-2 border-violet-500/30 bg-violet-500/[0.04] p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Crown className="w-5 h-5 text-violet-600 dark:text-violet-400 mt-0.5" />
            <div>
              <h2 className="font-display font-bold text-base text-foreground">Pro Mode</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Disciplined daily decision pipeline. Sport Priority → Sharp filter → Bankroll
                discipline → Scaling Ladder. Emits at most one Pro Bet per day to the queue.
                Empty days are valid.
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Forces Sharp Mode on. One trade max per day. Bankroll guardrails (Stop Loss /
                Profit Lock) gate Confirm.
              </p>
            </div>
          </div>
          <Switch checked={pro.enabled} onCheckedChange={pro.setEnabled} />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Crosshair className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mt-0.5" />
          <div>
            <h2 className="font-display font-bold text-base text-foreground">Sharp Mode</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Stricter filter pipeline — only legs with measurable edge, positive EV, and enough
              sample-size history surface. Daily Plan drops the Upside tier. Empty days are valid.
            </p>
            {pro.enabled ? (
              <p className="text-[11px] text-violet-600 dark:text-violet-400 mt-1 font-semibold">
                Required by Pro Mode — toggle disabled.
              </p>
            ) : null}
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={pro.enabled} />
      </div>

      {enabled ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-border/60">
          <div>
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Edge floor</Label>
            <div className="flex items-baseline gap-1">
              <Input
                type="number"
                step="0.01"
                value={thresholds.edgeThreshold}
                onChange={(e) => setThresholds({ edgeThreshold: Number(e.target.value) || 0 })}
                className="h-8 text-xs tabular-nums"
              />
              <span className="text-[10px] text-muted-foreground">pp</span>
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">EV floor</Label>
            <Input
              type="number"
              step="0.01"
              value={thresholds.evThreshold}
              onChange={(e) => setThresholds({ evThreshold: Number(e.target.value) || 0 })}
              className="h-8 text-xs tabular-nums"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Min samples</Label>
            <Input
              type="number"
              step="5"
              value={thresholds.minSampleCount}
              onChange={(e) => setThresholds({ minSampleCount: Number(e.target.value) || 0 })}
              className="h-8 text-xs tabular-nums"
            />
          </div>
          <div>
            <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Max legs</Label>
            <Input
              type="number"
              step="1"
              min="1"
              max="5"
              value={thresholds.maxLegs}
              onChange={(e) => setThresholds({ maxLegs: Number(e.target.value) || 1 })}
              className="h-8 text-xs tabular-nums"
            />
          </div>
          <div className="col-span-2 sm:col-span-4 flex items-center justify-between pt-1">
            <p className="text-[10px] text-muted-foreground">
              Defaults: edge ≥ {(SHARP_DEFAULTS.edgeThreshold * 100).toFixed(0)}pp, EV ≥ {SHARP_DEFAULTS.evThreshold},{" "}
              {SHARP_DEFAULTS.minSampleCount}+ samples, max {SHARP_DEFAULTS.maxLegs} legs.
            </p>
            <Button type="button" size="sm" variant="ghost" className="gap-1" onClick={reset}>
              <RotateCcw className="w-3.5 h-3.5" />
              Reset
            </Button>
          </div>
        </div>
      ) : null}
      </section>
    </div>
  );
}
