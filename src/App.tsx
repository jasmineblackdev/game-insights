import { useEffect, useLayoutEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
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
import { StaleLinesBanner } from "@/components/StaleLinesBanner";
import Index from "./pages/Index.tsx";
import EdgeCardPage from "./pages/EdgeCardPage.tsx";
import DailyPlanPage from "./pages/DailyPlanPage.tsx";
import PlayerEdgeDetailPage from "./pages/PlayerEdgeDetailPage.tsx";
import PicksPage from "./pages/PicksPage.tsx";
import RecommendedParlaysPage from "./pages/RecommendedParlaysPage.tsx";
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

function LiveEdgeNotificationRunner() {
  useLiveEdgeNotifications();
  return null;
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <MlbStarterSupabaseSync />
      <PlattParamsSync />
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
              <LiveEdgeNotificationProvider>
                <LiveEdgeNotificationRunner />
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Index />} />
                    <Route path="/edge" element={<EdgeCardPage />} />
                    <Route path="/daily" element={<DailyPlanPage />} />
                    <Route path="/player-edge/:projectionId" element={<PlayerEdgeDetailPage />} />
                    <Route path="/picks" element={<PicksPage />} />
                    <Route path="/parlays" element={<RecommendedParlaysPage />} />
                    <Route path="/ml-performance" element={<MLPerformancePage />} />
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
