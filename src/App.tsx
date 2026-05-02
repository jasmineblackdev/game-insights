import { useEffect, useLayoutEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EdgeCardProvider } from "@/context/EdgeCardContext";
import { ValueParlayProvider } from "@/context/ValueParlayContext";
import { BankrollProvider } from "@/context/BankrollContext";
import { SharpModeProvider } from "@/context/SharpModeContext";
import { ProModeProvider } from "@/context/ProModeContext";
import { LiveEdgeNotificationProvider } from "@/context/LiveEdgeNotificationContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StickyParlaySlipDrawer } from "@/components/StickyParlaySlipDrawer";
import { useLiveEdgeNotifications } from "@/hooks/useLiveEdgeNotifications";
import { useSupabaseSession } from "@/hooks/useSupabaseSession";
import { queryClient } from "@/lib/queryClient.ts";
import { isSupabaseConfigured } from "@/lib/supabase";
import { pullMlbStarterConfirmationsFromSupabase } from "@/lib/mlbStarterConfirm";
import { syncPlattParamsFromSupabase } from "@/lib/ml/calibration";
import { rehydrateUserLearningFromSupabase } from "@/lib/predictionLearningStorage";
import { StaleLinesBanner } from "@/components/StaleLinesBanner";
import { AppNav } from "@/components/AppNav";
import Index from "./pages/Index.tsx";
import BuilderPage from "./pages/BuilderPage.tsx";
import EdgeCardPage from "./pages/EdgeCardPage.tsx";
import PlayerEdgeDetailPage from "./pages/PlayerEdgeDetailPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import PaperBetsPage from "./pages/PaperBetsPage.tsx";
import MLPerformancePage from "./pages/MLPerformancePage.tsx";
import NotFound from "./pages/NotFound.tsx";

/** SPA navigation keeps window scrollY; short pages (e.g. /edge) then look blank until refresh. */
function ScrollToTop() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);
  return null;
}

/** When signed in, pull MLB starter confirmations from Supabase into localStorage (used by merge + model). */
function MlbStarterSupabaseSync() {
  const session = useSupabaseSession();
  useEffect(() => {
    if (!isSupabaseConfigured || !session?.user) return;
    void pullMlbStarterConfirmationsFromSupabase();
  }, [session?.user?.id]);
  return null;
}

/**
 * One-shot sync of nightly-fitted Platt calibration params from
 * Supabase into the client-side cache. Closes the loop between the
 * ml-recalibrate cron (writes to platt_params) and calibrateProbability
 * (reads from the cache). Without this the nightly recalibration was
 * dead from the user's perspective.
 */
function PlattParamsSync() {
  useEffect(() => {
    if (!isSupabaseConfigured) return;
    void syncPlattParamsFromSupabase();
  }, []);
  return null;
}

/**
 * Pull the user's last `user_learning_snapshots` row into localStorage
 * once per signed-in session. Closes the gap where a fresh device or
 * cleared browser would lose all calibration history while the server
 * had it persisted. The push side already exists in
 * `scheduleUserLearningSnapshotSync` — this is the symmetric pull.
 */
function UserLearningRehydrate() {
  const session = useSupabaseSession();
  useEffect(() => {
    if (!session?.user) return;
    void rehydrateUserLearningFromSupabase();
  }, [session?.user?.id]);
  return null;
}

function LiveEdgeNotificationRunner() {
  useLiveEdgeNotifications();
  return null;
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <MlbStarterSupabaseSync />
      <PlattParamsSync />
      <UserLearningRehydrate />
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <EdgeCardProvider>
          <ValueParlayProvider>
          <BankrollProvider>
          <SharpModeProvider>
          <ProModeProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <ScrollToTop />
              <StaleLinesBanner />
              <AppNav />
              <LiveEdgeNotificationProvider>
                <LiveEdgeNotificationRunner />
                <ErrorBoundary>
                  <Routes>
                    {/* ── Canonical 5-tab routes (Phase A) ─────────────── */}
                    <Route path="/"          element={<Index />} />
                    <Route path="/builder"   element={<BuilderPage />} />
                    <Route path="/insights"  element={<EdgeCardPage />} />
                    <Route path="/paper"     element={<PaperBetsPage />} />
                    <Route path="/settings"  element={<SettingsPage />} />

                    {/* ── Legacy redirects (consolidation Phase 1) ───────
                        /daily → / (Today's Decision lives on Home)
                        /parlays → /paper (Paper is the only tracking surface)
                        /edge, /ml-performance → /insights (analytics hub)
                        /picks deleted entirely — My Picks is gone. */}
                    <Route path="/daily"          element={<Navigate to="/" replace />} />
                    <Route path="/parlays"        element={<Navigate to="/paper" replace />} />
                    <Route path="/edge"           element={<Navigate to="/insights" replace />} />
                    <Route path="/ml-performance" element={<Navigate to="/insights" replace />} />

                    {/* ── Deep links retained ─────────────────────────── */}
                    <Route path="/player-edge/:projectionId" element={<PlayerEdgeDetailPage />} />

                    {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </ErrorBoundary>
                <StickyParlaySlipDrawer />
              </LiveEdgeNotificationProvider>
            </BrowserRouter>
          </TooltipProvider>
          </ProModeProvider>
          </SharpModeProvider>
          </BankrollProvider>
          </ValueParlayProvider>
        </EdgeCardProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
