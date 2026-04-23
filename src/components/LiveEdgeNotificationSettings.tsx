import { Bell } from "lucide-react";
import { toast } from "sonner";
import { useLiveEdgeNotificationSettings } from "@/context/LiveEdgeNotificationContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { registerGameLensNotifyServiceWorker } from "@/lib/liveEdgeNotificationDelivery";
import { cn } from "@/lib/utils";

export function LiveEdgeNotificationSettings({ className }: { className?: string }) {
  const { settings, setSettings } = useLiveEdgeNotificationSettings();

  const perm =
    typeof Notification !== "undefined" ? Notification.permission : "denied" as NotificationPermission;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("shrink-0 touch-manipulation border-border bg-card", className)}
          aria-label="Live edge alerts"
        >
          <Bell
            className={cn(
              "w-4 h-4",
              settings.masterEnabled && perm === "granted" ? "text-primary" : "text-muted-foreground"
            )}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-1.5rem))] space-y-3" align="end">
        <div>
          <p className="text-sm font-semibold text-foreground">Live edge alerts</p>
          <p className="text-[11px] text-muted-foreground leading-snug mt-1">
            Browser notifications when live checkpoints show actionable value. Max 3 alerts per game, throttled by
            type. Tap opens Edge Card or your ranked pick list.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="notify-master" className="text-xs font-medium cursor-pointer">
            Enable alerts
          </Label>
          <Switch
            id="notify-master"
            checked={settings.masterEnabled}
            onCheckedChange={async (on) => {
              if (on) {
                if (typeof Notification === "undefined") {
                  toast.error("Notifications not supported in this browser.");
                  return;
                }
                const p = await Notification.requestPermission();
                if (p !== "granted") {
                  toast.error("Allow notifications in your browser to enable alerts.");
                  return;
                }
                await registerGameLensNotifyServiceWorker();
              }
              setSettings({ ...settings, masterEnabled: on });
            }}
          />
        </div>

        {perm === "denied" && settings.masterEnabled ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">Notifications are blocked for this site.</p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="notify-bg" className="text-xs cursor-pointer">
            Only when tab in background
          </Label>
          <Switch
            id="notify-bg"
            checked={settings.onlyWhenBackground}
            onCheckedChange={(v) => setSettings({ ...settings, onlyWhenBackground: v })}
          />
        </div>

        <div className="space-y-2 pt-1 border-t border-border/60">
          <p className="text-[10px] font-bold tracking-wide text-muted-foreground">Sports</p>
          {(
            [
              ["nba", "NBA"],
              ["nfl", "NFL"],
              ["mlb", "MLB"],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <Label htmlFor={`sport-${k}`} className="text-xs cursor-pointer">
                {label}
              </Label>
              <Switch
                id={`sport-${k}`}
                checked={settings.sports[k]}
                onCheckedChange={(v) =>
                  setSettings({ ...settings, sports: { ...settings.sports, [k]: v } })
                }
              />
            </div>
          ))}
        </div>

        <div className="space-y-2 pt-1 border-t border-border/60">
          <p className="text-[10px] font-bold tracking-wide text-muted-foreground">Pick style</p>
          <div className="flex rounded-lg border border-border p-0.5 gap-0.5">
            <button
              type="button"
              className={cn(
                "flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-colors",
                settings.pickMode === "safe" ? "bg-primary/15 text-primary" : "text-muted-foreground"
              )}
              onClick={() => setSettings({ ...settings, pickMode: "safe" })}
            >
              Safe only
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 text-[11px] font-semibold py-1.5 rounded-md transition-colors",
                settings.pickMode === "aggressive" ? "bg-primary/15 text-primary" : "text-muted-foreground"
              )}
              onClick={() => setSettings({ ...settings, pickMode: "aggressive" })}
            >
              Aggressive
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Safe: ≥4% edge, high confidence. Aggressive: ≥3% edge, medium+ confidence.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1 border-t border-border/60">
          <Label htmlFor="notify-nba-ht" className="text-xs cursor-pointer leading-snug">
            NBA halftime updates
          </Label>
          <Switch
            id="notify-nba-ht"
            checked={settings.nbaHalftimeUpdates}
            onCheckedChange={(v) => setSettings({ ...settings, nbaHalftimeUpdates: v })}
          />
        </div>

        <div className="flex items-center justify-between gap-3 opacity-70">
          <Label htmlFor="notify-props" className="text-xs cursor-pointer leading-snug">
            Player prop alerts
          </Label>
          <Switch
            id="notify-props"
            checked={settings.playerPropAlerts}
            onCheckedChange={(v) => setSettings({ ...settings, playerPropAlerts: v })}
            disabled
          />
        </div>
        <p className="text-[10px] text-muted-foreground -mt-2">Coming soon — wire to prop live engine.</p>
      </PopoverContent>
    </Popover>
  );
}
