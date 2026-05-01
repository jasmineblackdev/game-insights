/**
 * /builder — Phase B 3-tab surface.
 *
 *   Plan         Build           Recommended
 *   ─────────    ─────────       ─────────
 *   Daily        ParlayBuilder   Saved parlays
 *   Plan         (5-step flow)   history
 *
 * Only one tab's panel mounts at a time. That's the whole reason this
 * wrapper exists — `DailyPlanPage` and `ParlayBuilderSection` both
 * publish to ValueParlayContext.candidatePool, and last-writer-wins
 * would clobber whichever mounted second. Conditional render =
 * single publisher per render.
 *
 * Tab state lives in the URL (?tab=plan|build|recommended) so:
 *   - /builder              defaults to "build"
 *   - /daily   → redirects  to /builder?tab=plan
 *   - /parlays → redirects  to /builder?tab=recommended
 *
 * Inner pages keep their own headers and chrome — Phase B is a routing
 * move only, not a UI rewrite.
 */

import { useSearchParams } from "react-router-dom";
import { ClipboardList, Layers, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import Index from "./Index";
import DailyPlanPage from "./DailyPlanPage";
import RecommendedParlaysPage from "./RecommendedParlaysPage";

type BuilderTab = "plan" | "build" | "recommended";

const TABS: { id: BuilderTab; label: string; Icon: typeof Sparkles }[] = [
  { id: "plan",        label: "Plan",        Icon: Layers },
  { id: "build",       label: "Build",       Icon: Sparkles },
  { id: "recommended", label: "Recommended", Icon: ClipboardList },
];

function isBuilderTab(v: string | null): v is BuilderTab {
  return v === "plan" || v === "build" || v === "recommended";
}

export default function BuilderPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab: BuilderTab = isBuilderTab(raw) ? raw : "build";

  const handleSelect = (next: BuilderTab) => {
    setSearchParams(
      (sp) => {
        const out = new URLSearchParams(sp);
        if (next === "build") out.delete("tab");
        else out.set("tab", next);
        return out;
      },
      { replace: true },
    );
  };

  return (
    <div>
      <div className="container max-w-6xl mx-auto px-3 pt-3">
        <div
          role="tablist"
          aria-label="Builder sections"
          className="inline-flex items-center rounded-full bg-muted p-0.5 gap-0.5"
        >
          {TABS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => handleSelect(id)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors",
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === "plan" ? (
        <DailyPlanPage />
      ) : tab === "recommended" ? (
        <RecommendedParlaysPage />
      ) : (
        <Index defaultView="parlay_builder" />
      )}
    </div>
  );
}
