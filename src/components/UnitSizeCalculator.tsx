import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function parseMoney(s: string): number {
  const n = Number.parseFloat(s.replace(/[$,]/g, "").trim());
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function parsePct(s: string): number {
  const n = Number.parseFloat(s.replace(/%/g, "").trim());
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n < 100 ? n.toFixed(2) : n.toFixed(0);
}

type UnitSizeCalculatorProps = {
  /** compact = icon-only trigger */
  variant?: "default" | "compact";
  className?: string;
};

export function UnitSizeCalculator({ variant = "default", className }: UnitSizeCalculatorProps) {
  const [open, setOpen] = useState(false);
  const [bankroll, setBankroll] = useState("1000");
  const [riskPct, setRiskPct] = useState("1");

  const tiers = useMemo(() => {
    const B = parseMoney(bankroll);
    const R = parsePct(riskPct);
    if (!Number.isFinite(B) || !Number.isFinite(R)) return null;
    const base = B * (R / 100);
    return {
      base,
      high: base * 1,
      medium: base * 0.67,
      low: base * 0.33,
    };
  }, [bankroll, riskPct]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={variant === "compact" ? "icon" : "sm"}
          className={className}
          aria-label="Unit size calculator"
        >
          {variant === "compact" ? (
            <Calculator className="w-4 h-4" />
          ) : (
            <>
              <Calculator className="w-3.5 h-3.5 mr-1.5" />
              Units
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Unit size calculator</DialogTitle>
          <DialogDescription>
            Flat risk % of bankroll per play, scaled by confidence tier (illustrative — adjust multipliers to your
            rules).
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="unit-bankroll">Bankroll ($)</Label>
            <Input
              id="unit-bankroll"
              inputMode="decimal"
              value={bankroll}
              onChange={(e) => setBankroll(e.target.value)}
              placeholder="1000"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="unit-risk">Risk per play (% of bankroll)</Label>
            <Input
              id="unit-risk"
              inputMode="decimal"
              value={riskPct}
              onChange={(e) => setRiskPct(e.target.value)}
              placeholder="1"
            />
          </div>
          {tiers ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-3 text-sm space-y-2">
              <p className="text-muted-foreground text-xs">
                Base unit = bankroll × risk% = <span className="text-foreground font-semibold">${fmt(tiers.base)}</span>
              </p>
              <ul className="space-y-1.5 text-foreground">
                <li className="flex justify-between gap-2">
                  <span className="text-confidence-high font-medium">HIGH confidence</span>
                  <span className="font-mono tabular-nums">${fmt(tiers.high)}</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span className="text-amber-600 dark:text-amber-400 font-medium">MED confidence</span>
                  <span className="font-mono tabular-nums">${fmt(tiers.medium)}</span>
                </li>
                <li className="flex justify-between gap-2">
                  <span className="text-muted-foreground font-medium">LOW confidence</span>
                  <span className="font-mono tabular-nums">${fmt(tiers.low)}</span>
                </li>
              </ul>
              <p className="text-[10px] text-muted-foreground pt-1">
                MED uses 0.67× base, LOW uses 0.33× — not financial advice.
              </p>
            </div>
          ) : (
            <p className="text-xs text-destructive">Enter valid bankroll and risk % (0–100).</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
