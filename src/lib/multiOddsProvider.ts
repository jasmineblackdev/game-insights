/**
 * Multi-provider odds fallback chain for MMA and Boxing.
 *
 * Priority order (first successful response wins):
 *  1. The Odds API          — via Supabase Edge proxy (server-side key)
 *  2. Pinnacle guest API    — public, no key required
 *  3. SportsDataIO          — if VITE_SDIO_API_KEY configured
 *  4. Sportradar            — if VITE_SPORTRADAR_API_KEY configured
 *  5. OddsJam               — if VITE_ODDSJAM_API_KEY configured
 *  6. OpticOdds             — if VITE_OPTICODDS_API_KEY configured
 *  7. Betfair Exchange      — if VITE_BETFAIR_APP_KEY + VITE_BETFAIR_SESSION configured
 *  8. SportMonks            — if VITE_SPORTMONKS_API_KEY configured
 *
 * Edge formula applied everywhere: edge = model_probability − implied_probability
 */

import { SPORT_CONFIG } from "@/lib/oddsProviderConfig";

// ── Normalized event shape ────────────────────────────────────────────────────

export interface CombatOddsEvent {
  id: string;
  commenceTime: string;  // ISO UTC
  homeName: string;
  awayName: string;
  homeMoneyline: number; // American odds
  awayMoneyline: number;
  drawMoneyline?: number;
  totalRounds?: number;
  overOdds?: number;
  underOdds?: number;
  source: string;        // which provider delivered this
}

// ── Edge formula ──────────────────────────────────────────────────────────────

/** Convert American moneyline to decimal implied probability (no vig). */
export function americanToImplied(ml: number): number {
  if (!Number.isFinite(ml)) return 0.5;
  if (ml > 0) return 100 / (ml + 100);
  return Math.abs(ml) / (Math.abs(ml) + 100);
}

/** Remove the bookmaker vig from a two-way market. */
export function deVig(p1Raw: number, p2Raw: number): { p1: number; p2: number } {
  const total = p1Raw + p2Raw;
  return { p1: p1Raw / total, p2: p2Raw / total };
}

/**
 * Core edge formula: how much value the model sees vs the market.
 *  edge > 0  → model thinks fighter is better than market implies (lean bet)
 *  edge < 0  → market has fighter higher than model (fade)
 */
export function computeEdge(modelProbability: number, americanMoneyline: number): number {
  const implied = americanToImplied(americanMoneyline);
  return Math.round((modelProbability - implied) * 1000) / 10; // returns % e.g. 5.8
}

// ── Supabase Edge proxy helper ────────────────────────────────────────────────

const SUPABASE_URL  = (import.meta.env.VITE_SUPABASE_URL  as string | undefined)?.trim() ?? "https://rxnqjdclqyazferbseeq.supabase.co";
const SUPABASE_ANON = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim()
  ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4bnFqZGNscXlhemZlcmJzZWVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyODQ5NjcsImV4cCI6MjA4Njg2MDk2N30.MA1qhu_gU93MjoDiJsM2FFDlO2iYjSk_kAbwf0rx_9g";

const PROXY_BASE = `${SUPABASE_URL}/functions/v1/odds-api-proxy`;

async function proxyGet(params: Record<string, string>): Promise<Response | null> {
  try {
    const q = new URLSearchParams(params);
    const res = await fetch(`${PROXY_BASE}?${q}`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON}`, apikey: SUPABASE_ANON },
    });
    return res;
  } catch {
    return null;
  }
}

// ── Name matching ─────────────────────────────────────────────────────────────

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function fuzzyNameMatch(a: string, b: string): boolean {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const wa = na.split(" ").filter((x) => x.length > 2);
  const wb = nb.split(" ").filter((x) => x.length > 2);
  return wa.some((x) => nb.includes(x)) || wb.some((x) => na.includes(x));
}

// ── Provider 1: The Odds API ─────────────────────────────────────────────────

const THE_ODDS_API_SPORT: Record<string, string> = {
  mma: "mma_mixed_martial_arts",
  boxing: "boxing",
};

async function fromTheOddsApi(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const sportKey = THE_ODDS_API_SPORT[sport];
  const res = await proxyGet({
    provider: "the-odds-api",
    route: "odds",
    sportKey,
    markets: "h2h,totals",
    regions: "us",
    oddsFormat: "american",
  });
  if (!res?.ok) {
    // Quota / rate-limit / unknown-sport responses surface via the
    // oddsApiHealth banner (see oddsApiFetch.trackOddsResponse).
    // Throwing here previously bubbled up as a RUNTIME_ERROR in the
    // console even though the banner was already up. Return null so
    // the multi-provider fallback chain proceeds to the next source.
    if (res?.status === 401 || res?.status === 402 || res?.status === 429) {
      const body = await res.json().catch(() => ({})) as { error_code?: string };
      if (body.error_code === "OUT_OF_USAGE_CREDITS") {
        // Mark the sport so we don't keep retrying — the per-sport
        // TTL lockout in oddsApiHealth handles the 5-minute cooldown.
        const { markOddsApiStale } = await import("@/lib/oddsApiHealth");
        markOddsApiStale({ reason: "quota", sportKey });
        return null;
      }
    }
    return null;
  }
  const events = await res.json().catch(() => null) as unknown;
  if (!Array.isArray(events)) return null;

  return (events as Array<Record<string, unknown>>).flatMap((ev) => {
    if (!ev.id || !ev.home_team || !ev.away_team) return [];
    const books = ev.bookmakers as Array<{ key?: string; markets?: Array<{ key?: string; outcomes?: Array<{ name?: string; price?: number; point?: number }> }> }> | undefined;
    const book = books?.find((b) => ["draftkings","fanduel","betmgm","pinnacle","caesars"].some((k) => (b.key ?? "").includes(k))) ?? books?.[0];
    const h2h = book?.markets?.find((m) => m.key === "h2h");
    const totals = book?.markets?.find((m) => m.key === "totals");

    let homeML: number | undefined, awayML: number | undefined, drawML: number | undefined;
    for (const o of h2h?.outcomes ?? []) {
      if (!o.name || typeof o.price !== "number") continue;
      const nl = o.name.toLowerCase();
      if (nl.includes("draw")) { drawML = o.price; continue; }
      if (fuzzyNameMatch(o.name, ev.home_team as string)) homeML = o.price;
      else if (fuzzyNameMatch(o.name, ev.away_team as string)) awayML = o.price;
    }
    if (homeML == null || awayML == null) return [];

    let totalRounds: number | undefined, overOdds: number | undefined, underOdds: number | undefined;
    for (const o of totals?.outcomes ?? []) {
      const nl = (o.name ?? "").toLowerCase();
      if (nl.includes("over"))  { overOdds = o.price; if (o.point != null) totalRounds = o.point; }
      if (nl.includes("under")) { underOdds = o.price; }
    }

    return [{
      id: ev.id as string,
      commenceTime: ev.commence_time as string,
      homeName: ev.home_team as string,
      awayName: ev.away_team as string,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      ...(drawML != null ? { drawMoneyline: drawML } : {}),
      ...(totalRounds != null ? { totalRounds, overOdds, underOdds } : {}),
      source: "TheOddsAPI",
    }] as CombatOddsEvent[];
  });
}

// ── Provider 2: Pinnacle (public guest API, no key) ──────────────────────────

interface PinnacleFixture {
  id: number;
  parentId?: number;
  starts: string;
  home: string;
  away: string;
  status: string; // O=open, H=hidden, I=in-progress
}

interface PinnacleOdds {
  id: number;
  periods: Record<string, {
    lineId?: number;
    moneyline?: { home?: number; away?: number; draw?: number };
    totals?: Array<{ points?: number; over?: number; under?: number }>;
  }>;
}

/**
 * Feature flag — disabled by default because guest.api.pinnacle.com
 * is unreachable from the Supabase Edge runtime (DNS resolution
 * fails), and every call generates a 502 in the production console.
 * Set VITE_PINNACLE_PROVIDER_ENABLED=true in your env once the
 * egress path is fixed to flip this back on.
 */
const PINNACLE_PROVIDER_ENABLED =
  (import.meta.env.VITE_PINNACLE_PROVIDER_ENABLED ?? "").toLowerCase() === "true";

async function fromPinnacle(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  if (!PINNACLE_PROVIDER_ENABLED) return null;
  // Fetch fixtures + odds in parallel via Edge proxy (server-side avoids CORS)
  const [fixtureRes, oddsRes] = await Promise.all([
    proxyGet({ provider: "pinnacle", sport, subroute: "fixtures" }),
    proxyGet({ provider: "pinnacle", sport, subroute: "odds"     }),
  ]);
  if (!fixtureRes?.ok || !oddsRes?.ok) return null;

  const fixtureBody = await fixtureRes.json().catch(() => null) as { fixtures?: PinnacleFixture[] } | null;
  const oddsBody    = await oddsRes.json().catch(() => null) as { odds?: PinnacleOdds[] } | null;
  if (!fixtureBody?.fixtures?.length || !oddsBody?.odds?.length) return null;

  const oddsById = new Map<number, PinnacleOdds>();
  for (const o of oddsBody.odds) oddsById.set(o.id, o);

  const results: CombatOddsEvent[] = [];
  for (const fix of fixtureBody.fixtures) {
    if (fix.parentId != null) continue; // skip sub-periods (individual rounds etc.)
    if (fix.status !== "O" && fix.status !== "I") continue;

    const odds = oddsById.get(fix.id);
    if (!odds) continue;

    // Period "0" = full match / fight
    const period = odds.periods["0"];
    if (!period?.moneyline?.home || !period?.moneyline?.away) continue;

    const totalEntry = period.totals?.[0];

    results.push({
      id:            `pinnacle-${fix.id}`,
      commenceTime:  fix.starts,
      homeName:      fix.home,
      awayName:      fix.away,
      homeMoneyline: period.moneyline.home,
      awayMoneyline: period.moneyline.away,
      ...(period.moneyline.draw != null ? { drawMoneyline: period.moneyline.draw } : {}),
      ...(totalEntry?.points != null ? {
        totalRounds: totalEntry.points,
        overOdds:    totalEntry.over,
        underOdds:   totalEntry.under,
      } : {}),
      source: "Pinnacle",
    });
  }
  return results.length ? results : null;
}

// ── Provider 3: SportsDataIO ─────────────────────────────────────────────────

interface SdioFight {
  FightId?: number;
  Status?: string;
  DateTime?: string;
  Fighter1FirstName?: string;
  Fighter1LastName?: string;
  Fighter2FirstName?: string;
  Fighter2LastName?: string;
  Fighter1MoneyLine?: number;
  Fighter2MoneyLine?: number;
}

async function fromSportsDataIo(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const year = new Date().getFullYear().toString();
  const res = await proxyGet({ provider: "sportsdata-io", sport, season: year });
  if (!res?.ok) return null;
  const fights = await res.json().catch(() => null) as SdioFight[] | null;
  if (!Array.isArray(fights)) return null;

  const now = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const f of fights) {
    if (!f.DateTime || !f.Fighter1MoneyLine || !f.Fighter2MoneyLine) continue;
    const ts = new Date(f.DateTime).getTime();
    if (!Number.isFinite(ts) || ts < now - 3_600_000) continue; // skip past fights
    const homeName = `${f.Fighter1FirstName ?? ""} ${f.Fighter1LastName ?? ""}`.trim();
    const awayName = `${f.Fighter2FirstName ?? ""} ${f.Fighter2LastName ?? ""}`.trim();
    if (!homeName || !awayName) continue;
    results.push({
      id:            `sdio-${f.FightId ?? ts}`,
      commenceTime:  new Date(f.DateTime).toISOString(),
      homeName,
      awayName,
      homeMoneyline: f.Fighter1MoneyLine,
      awayMoneyline: f.Fighter2MoneyLine,
      source: "SportsDataIO",
    });
  }
  return results.length ? results : null;
}

// ── Provider 4: Sportradar ────────────────────────────────────────────────────

interface SportradarCompetitor { abbreviation?: string; name?: string }
interface SportradarMatch {
  id?: string;
  scheduled?: string;
  status?: string;
  competitors?: SportradarCompetitor[];
  markets?: Array<{ market_type?: string; books?: Array<{ outcomes?: Array<{ name?: string; odds?: number }> }> }>;
}

async function fromSportradar(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const now = new Date();
  const year  = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  const res = await proxyGet({ provider: "sportradar", sport, year, month, day });
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as { sport_events?: SportradarMatch[] } | null;
  if (!body?.sport_events?.length) return null;

  const nowMs = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const ev of body.sport_events) {
    if (!ev.scheduled || !ev.competitors || ev.competitors.length < 2) continue;
    if (new Date(ev.scheduled).getTime() < nowMs - 3_600_000) continue;

    const [home, away] = ev.competitors;
    const h2hMarket = ev.markets?.find((m) => m.market_type === "2way" || m.market_type === "moneyline");
    const book = h2hMarket?.books?.[0];
    let homeML: number | undefined, awayML: number | undefined;
    for (const o of book?.outcomes ?? []) {
      if (fuzzyNameMatch(o.name ?? "", home.name ?? "")) homeML = o.odds;
      else if (fuzzyNameMatch(o.name ?? "", away.name ?? "")) awayML = o.odds;
    }
    if (!homeML || !awayML || !home.name || !away.name) continue;
    results.push({
      id:            `sr-${ev.id ?? ev.scheduled}`,
      commenceTime:  ev.scheduled,
      homeName:      home.name,
      awayName:      away.name,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      source: "Sportradar",
    });
  }
  return results.length ? results : null;
}

// ── Provider 5: OddsJam ───────────────────────────────────────────────────────

interface OddsJamGame {
  id?: string;
  start_date?: string;
  home_team?: string;
  away_team?: string;
  odds?: Array<{ bookmaker?: string; price?: number; name?: string; bet_points?: number }>;
}

async function fromOddsJam(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const res = await proxyGet({ provider: "oddsjam", sport, bookmakers: "pinnacle,draftkings,fanduel" });
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as { data?: OddsJamGame[] } | null;
  if (!Array.isArray(body?.data)) return null;

  const nowMs = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const g of body.data!) {
    if (!g.start_date || !g.home_team || !g.away_team || !g.odds?.length) continue;
    if (new Date(g.start_date).getTime() < nowMs - 3_600_000) continue;

    // Prefer Pinnacle prices (sharpest), fallback to DK/FD
    const pinnacleOdds = g.odds.filter((o) => o.bookmaker?.toLowerCase().includes("pinnacle"));
    const oddsToUse = pinnacleOdds.length ? pinnacleOdds : g.odds;

    let homeML: number | undefined, awayML: number | undefined;
    let totalRounds: number | undefined, overOdds: number | undefined;
    for (const o of oddsToUse) {
      if (!o.name || typeof o.price !== "number") continue;
      const nl = o.name.toLowerCase();
      if (nl === "draw") continue;
      if (nl.includes("over")) { overOdds = o.price; if (o.bet_points != null) totalRounds = o.bet_points; }
      else if (fuzzyNameMatch(o.name, g.home_team)) homeML = o.price;
      else if (fuzzyNameMatch(o.name, g.away_team)) awayML = o.price;
    }
    if (homeML == null || awayML == null) continue;
    results.push({
      id:            `oj-${g.id ?? g.start_date}`,
      commenceTime:  g.start_date,
      homeName:      g.home_team,
      awayName:      g.away_team,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      ...(totalRounds != null ? { totalRounds, overOdds } : {}),
      source: "OddsJam",
    });
  }
  return results.length ? results : null;
}

// ── Provider 6: OpticOdds ────────────────────────────────────────────────────

interface OpticFixture {
  id?: string;
  start_date?: string;
  participants?: Array<{ name?: string; is_home?: boolean }>;
  odds?: Array<{ market?: string; price?: number; participant?: string }>;
}

async function fromOpticOdds(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const res = await proxyGet({ provider: "opticodds", sport, market: "moneyline" });
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as { data?: OpticFixture[] } | null;
  if (!Array.isArray(body?.data)) return null;

  const nowMs = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const f of body.data!) {
    if (!f.start_date || !f.participants?.length || !f.odds?.length) continue;
    if (new Date(f.start_date).getTime() < nowMs - 3_600_000) continue;

    const home = f.participants.find((p) => p.is_home);
    const away = f.participants.find((p) => !p.is_home);
    if (!home?.name || !away?.name) continue;

    let homeML: number | undefined, awayML: number | undefined;
    for (const o of f.odds) {
      if (o.market !== "moneyline" || typeof o.price !== "number") continue;
      if (fuzzyNameMatch(o.participant ?? "", home.name)) homeML = o.price;
      else if (fuzzyNameMatch(o.participant ?? "", away.name)) awayML = o.price;
    }
    if (homeML == null || awayML == null) continue;
    results.push({
      id:            `oc-${f.id ?? f.start_date}`,
      commenceTime:  f.start_date,
      homeName:      home.name,
      awayName:      away.name,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      source: "OpticOdds",
    });
  }
  return results.length ? results : null;
}

// ── Provider 7: Betfair Exchange ─────────────────────────────────────────────

async function fromBetfair(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const res = await proxyGet({ provider: "betfair", sport });
  if (!res?.ok) return null;
  // Betfair returns market catalogue — mapping to standard fight format is complex.
  // Parsing logic: extract MATCH_ODDS markets, map runner names to fighter names.
  const body = await res.json().catch(() => null) as Array<{ marketName?: string; event?: { name?: string }; runners?: Array<{ runnerName?: string; lastPriceTraded?: number }> }> | null;
  if (!Array.isArray(body)) return null;

  const nowMs = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const mkt of body) {
    const eventName = mkt.event?.name ?? mkt.marketName ?? "";
    const runners   = mkt.runners ?? [];
    if (runners.length < 2) continue;

    // Betfair decimal odds → American
    const decToAmerican = (dec: number): number =>
      dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));

    const [r1, r2] = runners;
    const homeML = r1.lastPriceTraded != null ? decToAmerican(r1.lastPriceTraded) : undefined;
    const awayML = r2.lastPriceTraded != null ? decToAmerican(r2.lastPriceTraded) : undefined;
    if (homeML == null || awayML == null) continue;

    // Betfair event name format: "Fighter A v Fighter B" or "Fighter A vs Fighter B"
    const parts = eventName.split(/ vs?\.? /i);
    const homeName = parts[0]?.trim() ?? `Fighter A`;
    const awayName = parts[1]?.trim() ?? `Fighter B`;

    results.push({
      id:            `bf-${mkt.marketName ?? nowMs}`,
      commenceTime:  new Date(nowMs + 86_400_000).toISOString(), // Betfair doesn't return commence time in catalogue
      homeName,
      awayName,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      source: "Betfair",
    });
  }
  return results.length ? results : null;
}

// ── Provider 8: SportMonks ────────────────────────────────────────────────────

async function fromSportMonks(sport: "mma" | "boxing"): Promise<CombatOddsEvent[] | null> {
  const res = await proxyGet({ provider: "sportmonks", sport });
  if (!res?.ok) return null;
  const body = await res.json().catch(() => null) as { data?: Array<Record<string, unknown>> } | null;
  if (!Array.isArray(body?.data)) return null;

  const nowMs = Date.now();
  const results: CombatOddsEvent[] = [];
  for (const fix of body.data!) {
    const startingAt = fix.starting_at as string | undefined ?? fix.date as string | undefined;
    if (!startingAt) continue;
    if (new Date(startingAt).getTime() < nowMs - 3_600_000) continue;

    const participants = fix.participants as Array<{ name?: string; pivot?: { location?: string } }> | undefined ?? [];
    const home = participants.find((p) => p.pivot?.location === "home");
    const away = participants.find((p) => p.pivot?.location === "away");
    if (!home?.name || !away?.name) continue;

    const odds = fix.odds as Array<{ market_description?: string; label?: string; value?: string }> | undefined ?? [];
    let homeML: number | undefined, awayML: number | undefined;
    for (const o of odds) {
      if (o.market_description !== "Moneyline" && o.market_description !== "1X2" && o.market_description !== "Match Winner") continue;
      const val = Number(o.value);
      if (!Number.isFinite(val)) continue;
      // SportMonks returns European decimal odds — convert to American
      const american = val >= 2 ? Math.round((val - 1) * 100) : Math.round(-100 / (val - 1));
      if (fuzzyNameMatch(o.label ?? "", home.name)) homeML = american;
      else if (fuzzyNameMatch(o.label ?? "", away.name)) awayML = american;
    }
    if (homeML == null || awayML == null) continue;
    results.push({
      id:            `sm-${fix.id ?? startingAt}`,
      commenceTime:  new Date(startingAt).toISOString(),
      homeName:      home.name,
      awayName:      away.name,
      homeMoneyline: homeML,
      awayMoneyline: awayML,
      source: "SportMonks",
    });
  }
  return results.length ? results : null;
}

// ── Provider health tracking (in-memory, resets on page reload) ───────────────

type FailureType = "none" | "quota" | "auth" | "malformed" | "network";

interface ProviderHealth {
  totalAttempts:           number;
  totalSuccesses:          number;
  consecutiveFailures:     number;
  consecutiveMalformed:    number; // tracked separately for schema-drift alerting
  lastFailureTime:         number;
  lastSuccessTime:         number;
  lastFailureType:         FailureType;
  // Latency tracking (exponential moving average)
  avgLatencyMs:            number;
  lastLatencyMs:           number;
  // Market completeness (avg markets per successful response)
  avgMarketsCount:         number;
}

/** Circuit breaker timeouts by failure type (ms). */
const CIRCUIT_TIMEOUT: Record<FailureType, number> = {
  none:       0,
  quota:      15 * 60 * 1000,  // 15 min — quota won't un-exhaust before then
  auth:       60 * 60 * 1000,  // 1 hr   — wrong key won't fix itself
  malformed:   5 * 60 * 1000,  // 5 min  — schema drift; retry soon
  network:     2 * 60 * 1000,  // 2 min  — transient; retry quickly
};

/** EMA smoothing factor for latency (0 = ignore new, 1 = ignore history). */
const LATENCY_EMA_ALPHA = 0.3;

const healthState = new Map<string, ProviderHealth>();

function getHealth(name: string): ProviderHealth {
  if (!healthState.has(name)) {
    healthState.set(name, {
      totalAttempts:        0,
      totalSuccesses:       0,
      consecutiveFailures:  0,
      consecutiveMalformed: 0,
      lastFailureTime:      0,
      lastSuccessTime:      0,
      lastFailureType:      "none",
      avgLatencyMs:         0,
      lastLatencyMs:        0,
      avgMarketsCount:      0,
    });
  }
  return healthState.get(name)!;
}

function recordSuccess(name: string, latencyMs: number, marketsCount: number): void {
  const h = getHealth(name);
  h.totalAttempts++;
  h.totalSuccesses++;
  h.consecutiveFailures  = 0;
  h.consecutiveMalformed = 0;
  h.lastFailureType      = "none";
  h.lastSuccessTime      = Date.now();
  h.lastLatencyMs        = latencyMs;
  // EMA latency
  h.avgLatencyMs = h.avgLatencyMs === 0
    ? latencyMs
    : h.avgLatencyMs * (1 - LATENCY_EMA_ALPHA) + latencyMs * LATENCY_EMA_ALPHA;
  // EMA market completeness
  h.avgMarketsCount = h.avgMarketsCount === 0
    ? marketsCount
    : h.avgMarketsCount * (1 - LATENCY_EMA_ALPHA) + marketsCount * LATENCY_EMA_ALPHA;
}

function recordFailure(name: string, type: FailureType): void {
  const h = getHealth(name);
  h.totalAttempts++;
  h.consecutiveFailures++;
  h.lastFailureTime = Date.now();
  h.lastFailureType = type;
  if (type === "malformed") {
    h.consecutiveMalformed++;
    if (h.consecutiveMalformed >= 3) {
      // console.error is the current alerting channel.
      // ⚠️  TICKET REQUIRED: this should route to Sentry / structured server logs,
      //    not just devtools. Schema drift is a reliability issue, not a debug hint:
      //    it silently breaks fight data for all users until someone notices.
      //    Track as: "Add Sentry/server-log pipeline for schema drift alerts in
      //    odds provider fallback chain" — assign to whoever owns error reporting.
      console.error(
        `[oddsProvider] SCHEMA DRIFT ALERT: "${name}" has returned ${h.consecutiveMalformed} ` +
        `consecutive malformed responses. Check provider docs for API changes.`,
      );
    }
  } else {
    h.consecutiveMalformed = 0;
  }
}

function isCircuitOpen(name: string): boolean {
  const h = getHealth(name);
  if (h.consecutiveFailures === 0) return false;
  const timeout = CIRCUIT_TIMEOUT[h.lastFailureType];
  return Date.now() - h.lastFailureTime < timeout;
}

/**
 * Dynamic health score — higher = try first.
 *
 * Components:
 *  - smoothedRate (0–100 pts): Laplace-smoothed success rate — (s+1)/(n+2).
 *    Starts at 50 with no data, converges to true rate as sample grows.
 *    Avoids the noise cliff of raw rate with small samples (0/1 = 0 vs 1/2 = 50).
 *  - failure penalty: -10 per consecutive failure
 *  - latency penalty: -1 pt per 200ms avg latency (fast providers score higher)
 *  - market completeness bonus: up to +10 × completenessWeight, normalized to
 *    expectedMarkets from SPORT_CONFIG so providers are not biased by absolute count
 *  - recovery probe bonus: small bonus (+8 max) so demoted providers get
 *    occasional probes instead of staying buried forever. Gated on smoothed
 *    rate ≥ 0.4 to prevent a repeatedly broken provider from leapfrogging.
 *  - base priority: -baseIndex (original order as tiebreaker)
 *
 * Future improvement: weight recovery gate by Wilson confidence interval so
 * the gate tightens as sample size grows and 1/2 is treated differently
 * from 50/100. At current traffic volumes Laplace is sufficient.
 */
function healthScore(name: string, baseIndex: number, sport?: "mma" | "boxing"): number {
  const h      = getHealth(name);
  const now    = Date.now();
  const config = sport ? SPORT_CONFIG[sport] : null;

  // Laplace-smoothed success rate: (successes + 1) / (attempts + 2)
  // Examples: 0 attempts → 0.50, 0/1 → 0.33, 1/2 → 0.50, 5/5 → 0.86
  const smoothedRate   = (h.totalSuccesses + 1) / (h.totalAttempts + 2);
  const failurePenalty = h.consecutiveFailures * 10;
  const latencyPenalty = h.avgLatencyMs > 0 ? Math.floor(h.avgLatencyMs / 200) : 0;

  // Normalized completeness: actual / expected markets from sport config.
  // completenessWeight scales the bonus so team sports (where spread+total
  // are required) penalize incomplete providers more than combat sports do.
  const expectedMarkets    = config?.expectedMarkets.length ?? 3;
  const completenessWeight = config?.completenessWeight ?? 1.0;
  const completeness       = h.avgMarketsCount > 0 ? Math.min(1, h.avgMarketsCount / expectedMarkets) : 0;
  const marketBonus        = Math.round(completeness * 10 * completenessWeight);

  // Recovery probe bonus: at most +8 pts after 5 min without a try.
  // Gated on smoothed rate ≥ 0.4 (not 0.5) to account for small-sample noise —
  // a provider at 1/2 (smoothed 0.5) should still get probe opportunities.
  const lastTried      = Math.max(h.lastFailureTime, h.lastSuccessTime);
  const timeSinceTried = lastTried === 0 ? 0 : now - lastTried;
  const historicallyOk = smoothedRate >= 0.4;
  const recoveryBonus  = historicallyOk
    ? Math.min(8, (timeSinceTried / (5 * 60 * 1000)) * 3)
    : 0;

  return smoothedRate * 100
    - failurePenalty
    - latencyPenalty
    + marketBonus
    + recoveryBonus
    - baseIndex;
}

// ── Short-window cache + stale-last-good fallback ─────────────────────────────

interface CacheEntry {
  events:      CombatOddsEvent[];
  source:      string;
  fetchedAt:   number;
  lastFreshAt: number; // UTC ms when live data was last successfully fetched
}

const responseCache = new Map<string, CacheEntry>(); // live (TTL-expired entries removed)
const staleCache    = new Map<string, CacheEntry>(); // last-known-good

/**
 * Cache key format: `combat-odds:{sport}`
 *
 * Intentionally coarse — one unified list per sport. If future screens need
 * different markets / regions / time windows expand to:
 *   `combat-odds:{sport}:{marketSet}:{region}:{dateBucket}`
 *
 * TTL and max-stale-age are now driven by SPORT_CONFIG so each sport gets
 * freshness windows appropriate to how fast its lines move.
 */
function getCacheLive(key: string, ttlMs: number): CacheEntry | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > ttlMs) { responseCache.delete(key); return null; }
  return entry;
}

function setCache(key: string, events: CombatOddsEvent[], source: string): void {
  const now   = Date.now();
  const entry: CacheEntry = { events, source, fetchedAt: now, lastFreshAt: now };
  responseCache.set(key, entry);
  // Preserve lastFreshAt from the previous stale entry if it exists, but always
  // update fetchedAt so age calculations are correct.
  staleCache.set(key, { ...entry });
}

// ── Provider result metadata ───────────────────────────────────────────────────

export interface OddsProviderMeta {
  servedBy:        string;
  fallbackDepth:   number;    // 0 = primary won, 1 = first fallback, etc.
  marketsReturned: string[];  // e.g. ["moneyline", "totals"]
  eventCount:      number;
  fromCache:       boolean;
  stale:           boolean;   // true when served from last-known-good after all providers fail
  staleAgeMs:      number;    // ms since last fresh fetch (0 when not stale)
  lastFreshAt:     number;    // UTC ms of last successful live fetch (0 = unknown)
  healthSnapshot:  Record<string, {
    successRate:  string;
    circuitOpen:  boolean;
    avgLatencyMs: number;
    avgMarkets:   string;
  }>;
}

function inferMarkets(events: CombatOddsEvent[]): string[] {
  const markets: string[] = [];
  if (events.some((e) => e.homeMoneyline != null)) markets.push("moneyline");
  if (events.some((e) => e.totalRounds   != null)) markets.push("totals");
  if (events.some((e) => e.drawMoneyline != null)) markets.push("draw");
  return markets;
}

/**
 * Build a health snapshot for one sport only.
 * Keys in the returned object are plain provider names (suffix stripped)
 * so the debug badge and callers never see internal namespaced keys.
 */
function buildSnapshot(sport: "mma" | "boxing"): OddsProviderMeta["healthSnapshot"] {
  const suffix = `:${sport}`;
  const out: OddsProviderMeta["healthSnapshot"] = {};
  for (const [key, h] of healthState.entries()) {
    if (!key.endsWith(suffix)) continue;
    const displayName = key.slice(0, -suffix.length);
    out[displayName] = {
      successRate:  h.totalAttempts === 0 ? "untried" : `${Math.round(h.totalSuccesses / h.totalAttempts * 100)}%`,
      circuitOpen:  isCircuitOpen(key),
      avgLatencyMs: Math.round(h.avgLatencyMs),
      avgMarkets:   h.avgMarketsCount === 0 ? "—" : h.avgMarketsCount.toFixed(1),
    };
  }
  return out;
}

// Last meta per sport — readable by debug badge without re-fetching
const lastMetaStore = new Map<string, OddsProviderMeta>();

/**
 * Returns the most recent fetch metadata for a sport.
 * Reads from a module-level Map — purely in-memory, no network call, O(1).
 * Safe to poll from UI at any frequency.
 */
export function getProviderMeta(sport: "mma" | "boxing"): OddsProviderMeta | null {
  return lastMetaStore.get(sport) ?? null;
}

// ── Fallback chain definition ─────────────────────────────────────────────────

type Provider = {
  name:     string;
  fn:       (sport: "mma" | "boxing") => Promise<CombatOddsEvent[] | null>;
  envGate?: string;
  /**
   * "opportunistic" providers are best-effort: no SLA, may change without notice.
   * They run last and log a warning when serving data.
   */
  tier: "primary" | "secondary" | "opportunistic";
};

const PROVIDERS: Provider[] = [
  // Primary — contract-backed, documented error codes
  { name: "TheOddsAPI",   fn: fromTheOddsApi,   tier: "primary" },
  // Secondary — established data vendors with explicit API contracts
  { name: "SportsDataIO", fn: fromSportsDataIo,  tier: "secondary", envGate: "VITE_SDIO_API_KEY"       },
  { name: "Sportradar",   fn: fromSportradar,    tier: "secondary", envGate: "VITE_SPORTRADAR_API_KEY"  },
  { name: "OddsJam",      fn: fromOddsJam,       tier: "secondary", envGate: "VITE_ODDSJAM_API_KEY"     },
  { name: "OpticOdds",    fn: fromOpticOdds,     tier: "secondary", envGate: "VITE_OPTICODDS_API_KEY"   },
  { name: "Betfair",      fn: fromBetfair,       tier: "secondary", envGate: "VITE_BETFAIR_APP_KEY"     },
  { name: "SportMonks",   fn: fromSportMonks,    tier: "secondary", envGate: "VITE_SPORTMONKS_API_KEY"  },
  // Opportunistic — public/guest endpoint, no SLA, may change without notice
  { name: "Pinnacle",     fn: fromPinnacle,      tier: "opportunistic" },
];

function classifyError(msg: string): FailureType {
  if (msg.includes("quota_exhausted"))                              return "quota";
  if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) return "auth";
  if (msg.includes("upstream_failed") || msg.includes("network") || msg.includes("fetch")) return "network";
  return "malformed";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch combat odds with full resilience:
 *  - 2-minute live cache (coarse key per sport; expand if multi-market needed)
 *  - circuit breakers per failure type
 *  - health-score-ordered provider list (latency + completeness + time-decay)
 *  - stale last-known-good fallback if all live providers fail
 *  - schema-drift alerting after 3 consecutive malformed responses
 *  - result metadata for transparency / debug badge
 */
export async function fetchCombatOddsWithMeta(
  sport: "mma" | "boxing",
): Promise<{ events: CombatOddsEvent[]; meta: OddsProviderMeta }> {
  const cacheKey = `combat-odds:${sport}`;
  const config   = SPORT_CONFIG[sport];

  const live = getCacheLive(cacheKey, config.cacheTtlMs);
  if (live) {
    const meta: OddsProviderMeta = {
      servedBy:        live.source,
      fallbackDepth:   0,
      marketsReturned: inferMarkets(live.events),
      eventCount:      live.events.length,
      fromCache:       true,
      stale:           false,
      staleAgeMs:      0,
      lastFreshAt:     live.lastFreshAt,
      healthSnapshot:  buildSnapshot(sport),
    };
    lastMetaStore.set(sport, meta);
    return { events: live.events, meta };
  }

  const env = import.meta.env as Record<string, string | undefined>;

  // Health state is namespaced by sport so MMA and NBA rankings never blend.
  // e.g. "TheOddsAPI:mma" and "TheOddsAPI:nba" are tracked independently.
  // Circuit breakers will open per-sport: the cost of not sharing them is one
  // extra failed request before a sibling sport's circuit opens independently.
  const hKey = (name: string) => `${name}:${sport}`;

  const eligible = PROVIDERS
    .filter((p) => !p.envGate || env[p.envGate]?.trim())
    .map((p, i) => ({ p, score: healthScore(hKey(p.name), i, sport) }))
    .sort((a, b) => b.score - a.score)
    .map(({ p }) => p);

  const errors: string[] = [];
  let depth = 0;

  for (const p of eligible) {
    const key = hKey(p.name);
    if (isCircuitOpen(key)) {
      const h = getHealth(key);
      errors.push(`${p.name}: circuit open (${h.lastFailureType})`);
      continue;
    }

    const t0 = Date.now();
    try {
      const events = await p.fn(sport);

      if (!events || events.length === 0) {
        continue; // empty response — no health penalty, just skip
      }

      const latency = Date.now() - t0;
      const markets = inferMarkets(events);
      recordSuccess(key, latency, markets.length);
      setCache(cacheKey, events, p.name);

      const now2 = Date.now();
      const meta: OddsProviderMeta = {
        servedBy:        p.name,
        fallbackDepth:   depth,
        marketsReturned: markets,
        eventCount:      events.length,
        fromCache:       false,
        stale:           false,
        staleAgeMs:      0,
        lastFreshAt:     now2,
        healthSnapshot:  buildSnapshot(sport),
      };
      lastMetaStore.set(sport, meta);

      if (p.tier === "opportunistic") {
        console.warn(
          `[oddsProvider] ${sport} served by OPPORTUNISTIC "${p.name}" (depth=${depth}, ${latency}ms, markets=${markets.join(",")}) — best-effort only`,
        );
      } else {
        console.info(
          `[oddsProvider] ${sport} ← ${p.name} (depth=${depth}, ${latency}ms, events=${events.length}, markets=${markets.join(",")})`,
        );
      }

      return { events, meta };

    } catch (err) {
      const msg   = err instanceof Error ? err.message : String(err);
      const ftype = classifyError(msg);
      recordFailure(key, ftype);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[oddsProvider] ${p.name} failed (${ftype}, ${Date.now() - t0}ms): ${msg}`);
    }

    depth++;
  }

  // All live providers failed — serve stale last-known-good if available and fresh enough
  const staleEntry = staleCache.get(cacheKey);
  if (staleEntry) {
    const staleAgeMs   = Date.now() - staleEntry.lastFreshAt;
    const maxStaleMs   = config.maxStaleMs;
    if (staleAgeMs > maxStaleMs) {
      // Data is dangerously old — serving it could mislead more than it helps
      console.warn(
        `[oddsProvider] ${sport} — stale cache is ${Math.round(staleAgeMs / 3_600_000)}h old ` +
        `(limit ${maxStaleMs / 3_600_000}h). Discarding to avoid misleading data.`,
      );
    } else {
      const markets = inferMarkets(staleEntry.events);
      console.warn(
        `[oddsProvider] ${sport} — all providers failed; serving stale data from ` +
        `"${staleEntry.source}" (${Math.round(staleAgeMs / 60_000)}min old)`,
      );
      const meta: OddsProviderMeta = {
        servedBy:        staleEntry.source,
        fallbackDepth:   depth,
        marketsReturned: markets,
        eventCount:      staleEntry.events.length,
        fromCache:       true,
        stale:           true,
        staleAgeMs,
        lastFreshAt:     staleEntry.lastFreshAt,
        healthSnapshot:  buildSnapshot(sport),
      };
      lastMetaStore.set(sport, meta);
      return { events: staleEntry.events, meta };
    }
  }

  const detail = errors.length ? ` — ${errors.join("; ")}` : "";
  throw new Error(`No ${sport.toUpperCase()} odds available from any provider${detail}`);
}

/**
 * Convenience wrapper — returns just the events array.
 * Use fetchCombatOddsWithMeta when you need source/health metadata.
 */
export async function fetchCombatOddsWithFallback(sport: "mma" | "boxing"): Promise<CombatOddsEvent[]> {
  const { events } = await fetchCombatOddsWithMeta(sport);
  return events;
}
