import { useEffect, useLayoutEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EdgeCardProvider } from "@/context/EdgeCardContext";
import { LiveEdgeNotificationProvider } from "@/context/LiveEdgeNotificationContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useLiveEdgeNotifications } from "@/hooks/useLiveEdgeNotifications";
import { useSupabaseSession } from "@/hooks/useSupabaseSession";
import { queryClient } from "@/lib/queryClient.ts";
import { isSupabaseConfigured } from "@/lib/supabase";
import { pullMlbStarterConfirmationsFromSupabase } from "@/lib/mlbStarterConfirm";
import Index from "./pages/Index.tsx";
import EdgeCardPage from "./pages/EdgeCardPage.tsx";
import PlayerEdgeDetailPage from "./pages/PlayerEdgeDetailPage.tsx";
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

function LiveEdgeNotificationRunner() {
  useLiveEdgeNotifications();
  return null;
}

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <MlbStarterSupabaseSync />
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <EdgeCardProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <ScrollToTop />
              <LiveEdgeNotificationProvider>
                <LiveEdgeNotificationRunner />
                <ErrorBoundary>
                  <Routes>
                    <Route path="/" element={<Index />} />
                    <Route path="/edge" element={<EdgeCardPage />} />
                    <Route path="/player-edge/:projectionId" element={<PlayerEdgeDetailPage />} />
                    {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </ErrorBoundary>
              </LiveEdgeNotificationProvider>
            </BrowserRouter>
          </TooltipProvider>
        </EdgeCardProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
