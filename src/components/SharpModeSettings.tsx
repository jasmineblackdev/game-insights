/**
 * SharpModeSettings — toggle + threshold tuning surface for the
 * disciplined edge-only mode. Embeddable; today lives at the top of
 * PicksPage but can be dropped into a dedicated Settings route later.
 */

import { Crosshair, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useSharpMode } from "@/context/SharpModeContext";
import { SHARP_DEFAULTS } from "@/lib/learning/sharpMode";

export function SharpModeSettings() {
  const { enabled, thresholds, setEnabled, setThresholds, reset } = useSharpMode();

  return (
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
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
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
  );
}
