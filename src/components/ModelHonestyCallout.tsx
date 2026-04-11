import { Info } from "lucide-react";

type Variant = "edge" | "home";

export function ModelHonestyCallout({ variant = "edge" }: { variant?: Variant }) {
  return (
    <aside
      className="rounded-lg border border-border/80 bg-muted/25 px-3 py-2.5 text-[11px] text-muted-foreground leading-snug"
      aria-label="How to read predictions"
    >
      <div className="flex gap-2">
        <Info className="w-3.5 h-3.5 shrink-0 text-primary mt-0.5" aria-hidden />
        <div className="space-y-1.5 min-w-0">
          <p className="font-semibold text-foreground">Predictions are not guarantees</p>
          <p>
            Win % and &ldquo;confidence&rdquo; describe the model&apos;s view and stability — not a promise of profit
            or outcome. Lines, injuries, and luck move fast; use this as one input, not financial advice.
          </p>
          {variant === "edge" ? (
            <p>
              When you mark <span className="text-foreground font-medium">Win / Loss / Push</span> on saved Edge Cards,
              that record stays on <span className="text-foreground font-medium">this device</span> so you can
              sanity-check how picks performed over time. It is not a published accuracy score unless you later sync
              to an account.
            </p>
          ) : (
            <p>
              Mark results on your saved Edge Cards to build a simple local track record — useful for calibrating how
              much weight you give the model.
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
