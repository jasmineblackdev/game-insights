import { lazy, Suspense } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EdgeCardProvider } from "@/context/EdgeCardContext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { RouteFallback } from "@/components/RouteFallback.tsx";
import { queryClient } from "@/lib/queryClient.ts";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";

const EdgeCardPage = lazy(() => import("./pages/EdgeCardPage.tsx"));
const PlayerEdgeDetailPage = lazy(() => import("./pages/PlayerEdgeDetailPage.tsx"));

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <EdgeCardProvider>
          <TooltipProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <ErrorBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Index />} />
                    <Route path="/edge" element={<EdgeCardPage />} />
                    <Route path="/player-edge/:projectionId" element={<PlayerEdgeDetailPage />} />
                    {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
            </BrowserRouter>
          </TooltipProvider>
        </EdgeCardProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
