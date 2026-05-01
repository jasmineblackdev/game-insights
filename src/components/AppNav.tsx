/**
 * AppNav — top-level 5-tab navigation. Visible on every route.
 *
 * Phase A of the simplified nav restructure. Existing per-page chrome
 * (e.g. Index's internal viewMode tabs) is intentionally left in place
 * for now — Phase B/C/D/E will collapse the duplication. This is the
 * routing scaffold only.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────┐
 *   │ Home   Builder   Insights   Paper   Settings           │
 *   └────────────────────────────────────────────────────────┘
 *
 * Anchored inside the StatusStrip / banner stack at the App.tsx root.
 * Mobile: scrollable horizontal pill row; desktop: centered.
 */

import { NavLink } from "react-router-dom";
import { BarChart3, FlaskConical, Home, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/",         label: "Home",     Icon: Home },
  { to: "/builder",  label: "Builder",  Icon: Sparkles },
  { to: "/insights", label: "Insights", Icon: BarChart3 },
  { to: "/paper",    label: "Paper",    Icon: FlaskConical },
  { to: "/settings", label: "Settings", Icon: Settings },
] as const;

export function AppNav() {
  return (
    <nav
      className="sticky top-0 z-30 w-full border-b border-border/60 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      aria-label="Primary"
    >
      <div className="container max-w-6xl mx-auto px-3 py-1.5 flex items-center gap-1 overflow-x-auto scrollbar-none">
        {TABS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            // Match exactly on "/" so it doesn't stay active for child routes.
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors shrink-0",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )
            }
          >
            <Icon className="w-3.5 h-3.5 shrink-0" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
