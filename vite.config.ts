import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const footballDataToken = env.VITE_FOOTBALL_DATA_API_TOKEN;
  /** Dev proxy: prefer server-only key; fall back to VITE_THE_ODDS_API_KEY if that is all you set. */
  const oddsServerKey = (env.THE_ODDS_API_KEY ?? env.VITE_THE_ODDS_API_KEY ?? "").trim();

  const proxy: Record<string, import("vite").ProxyOptions> = {};

  if (footballDataToken) {
    proxy["/football-data-api"] = {
      target: "https://api.football-data.org",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/football-data-api/, "/v4"),
      configure: (p) => {
        p.on("proxyReq", (proxyReq) => {
          proxyReq.setHeader("X-Auth-Token", footballDataToken);
        });
      },
    };
  }

  if (mode === "development" && oddsServerKey) {
    proxy["/__odds-api"] = {
      target: "https://api.the-odds-api.com",
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/__odds-api\/?/, "/v4/"),
      configure: (p) => {
        p.on("proxyReq", (proxyReq) => {
          const path = proxyReq.path || "";
          if (path.includes("apiKey=")) return;
          const join = path.includes("?") ? "&" : "?";
          proxyReq.path = `${path}${join}apiKey=${encodeURIComponent(oddsServerKey)}`;
        });
      },
    };
  }

  return {
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    ...(Object.keys(proxy).length ? { proxy } : {}),
  },
  define: {
    __GAMELENS_ODDS_DEV_PROXY__: JSON.stringify(mode === "development" && Boolean(oddsServerKey)),
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
};
});
