/**
 * Fail CI / deploy prep if dist/ is not a real Vite production build.
 * Wrong Vercel output (repo root) serves index.html with /src/main.tsx → MIME type errors on /edge.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "dist", "index.html");

if (!fs.existsSync(indexPath)) {
  console.error("verify-spa-dist: missing dist/index.html — run npm run build first");
  process.exit(1);
}

const html = fs.readFileSync(indexPath, "utf8");

if (html.includes("/src/main.tsx") || html.includes('src="/src/')) {
  console.error(
    "verify-spa-dist: dist/index.html still references /src/* (dev entry). Vite build did not transform HTML."
  );
  process.exit(1);
}

if (!/\/assets\/[^"'>\s]+\.js/.test(html)) {
  console.error("verify-spa-dist: dist/index.html has no /assets/*.js script — check vite build output.");
  process.exit(1);
}

console.log("verify-spa-dist: dist/index.html OK (production bundle references)");
