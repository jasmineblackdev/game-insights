import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (i) => Math.min(1000 * 2 ** i, 10_000),
      networkMode: "online",
    },
    mutations: {
      retry: 1,
    },
  },
});
