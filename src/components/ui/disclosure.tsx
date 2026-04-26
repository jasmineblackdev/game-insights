/**
 * Disclosure — thin native <details>/<summary> wrapper with three
 * styling variants. Six ad-hoc <details> blocks across the app
 * (DailyPlanPage, Index, PlayerEdgeSection, BankrollPanel) reinvented
 * the same three patterns inline; this primitive consolidates them.
 *
 * Variants:
 *   - "card"    — bordered card, bold summary, optional Expand/Hide hint.
 *                 Used for major collapsible content blocks.
 *   - "dashed"  — dashed-border aside, small-caps muted summary.
 *                 Used for per-item footer details and danger-zone settings.
 *   - "chevron" — borderless heading with rotating ChevronDown.
 *                 Used for prominent category sections.
 *
 * Native <details> is intentional — works without JS, no controlled
 * state to manage, and the browser handles open/close itself.
 */

import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DisclosureVariant = "card" | "dashed" | "chevron";

export interface DisclosureProps {
  variant?: DisclosureVariant;
  /** Summary content (text or JSX — e.g. an icon + label). */
  title: ReactNode;
  /** Show "Expand"/"Hide" hint on the right side (card variant only). */
  showHint?: boolean;
  /** Override default open state (rendered as the native attribute). */
  defaultOpen?: boolean;
  /** Extra classes on the wrapping <details>. */
  className?: string;
  /** Extra classes on the <summary>. */
  summaryClassName?: string;
  /** Body content. */
  children: ReactNode;
}

export function Disclosure({
  variant = "card",
  title,
  showHint = false,
  defaultOpen = false,
  className,
  summaryClassName,
  children,
}: DisclosureProps) {
  const detailsClass = cn(
    "group",
    variant === "card" && "rounded-lg border border-border bg-card/40 px-4 py-3",
    variant === "dashed" && "rounded-md border border-dashed border-border bg-card/40 px-2 py-1.5",
    className,
  );

  const summaryClass = cn(
    "cursor-pointer list-none flex items-center select-none",
    variant === "card" && "text-sm font-semibold text-foreground justify-between",
    variant === "dashed" && "text-[10px] uppercase tracking-wider text-muted-foreground font-semibold justify-between",
    variant === "chevron" && "gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground",
    summaryClassName,
  );

  return (
    <details className={detailsClass} open={defaultOpen || undefined}>
      <summary className={summaryClass}>
        {variant === "chevron" && (
          <ChevronDown className="w-4 h-4 group-open:rotate-180 transition-transform" />
        )}
        <span className={variant === "chevron" ? undefined : "flex-1"}>{title}</span>
        {variant === "card" && showHint && (
          <>
            <span className="text-xs text-muted-foreground group-open:hidden">Expand</span>
            <span className="text-xs text-muted-foreground hidden group-open:inline">Hide</span>
          </>
        )}
        {variant === "dashed" && (
          <>
            <span className="text-[9px] group-open:hidden">Show</span>
            <span className="text-[9px] hidden group-open:inline">Hide</span>
          </>
        )}
      </summary>
      <div className={variant === "card" ? "mt-3" : "mt-2"}>{children}</div>
    </details>
  );
}
