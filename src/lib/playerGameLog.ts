/**
 * Player gamelog — fetches the last N games' stats for a player from the
 * ESPN athlete gamelog endpoint and maps them to the prop's stat_type.
 *
 * Used by the PropCard "Last 5" strip. Fire-and-forget: any API failure
 * returns an empty array and the UI hides the strip gracefully.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type GameLogSport = "NBA" | "NFL" | "MLB";

export interface PlayerGameStat {
  /** ISO date of the game (YYYY-MM-DD). */
  date: string;
  /** Opponent abbreviation, e.g. "LAL". */
  opponent: string;
  /** "home" | "away" — parsed from the `atVs` field. */
  homeAway: "home" | "away";
  /** Numeric stat value for the requested stat_type. NaN → skipped. */
  value: number;
}

// ── ESPN endpoint paths ──────────────────────────────────────────────────────

const ATHLETE_GAMELOG: Record<GameLogSport, string> = {
  NBA: "https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes",
  NFL: "https://site.api.espn.com/apis/common/v3/sports/football/nfl/athletes",
  MLB: "https://site.api.espn.com/apis/common/v3/sports/baseball/mlb/athletes",
};

// ── Stat-type → label lookup ─────────────────────────────────────────────────
// Maps our stat_type values to the label strings ESPN uses in `labels` arrays.
// NFL labels overlap across categories (passing/rushing/receiving all have
// "YDS") so we pick the category by name too.

interface StatSpec {
  /** Label strings to match (case-insensitive). */
  labels: string[];
  /** Optional category-name matcher (NFL); case-insensitive substring. */
  categoryContains?: string;
  /** Optional transform (e.g. "5-12" → 5 for three-pointers made). */
  parse?: (raw: string) => number;
}

const parseFraction = (raw: string): number => {
  const m = raw.match(/^(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : NaN;
};

const STAT_LOOKUP: Record<GameLogSport, Record<string, StatSpec>> = {
  NBA: {
    points:     { labels: ["PTS", "P"] },
    rebounds:   { labels: ["REB", "R"] },
    assists:    { labels: ["AST", "A"] },
    threes:     { labels: ["3PT", "3PM"], parse: parseFraction },
    pra:        { labels: [] }, // computed below
  },
  NFL: {
    passing_yards:   { labels: ["YDS", "PASS YDS"], categoryContains: "pass" },
    rushing_yards:   { labels: ["YDS", "RUSH YDS"], categoryContains: "rush" },
    receiving_yards: { labels: ["YDS", "REC YDS"], categoryContains: "receiv" },
    receptions:      { labels: ["REC"],            categoryContains: "receiv" },
  },
  MLB: {
    hits:         { labels: ["H"]  },
    total_bases:  { labels: ["TB"] },
    strikeouts:   { labels: ["K", "SO"] },
    home_runs:    { labels: ["HR"] },
    stolen_bases: { labels: ["SB"] },
    rbi:          { labels: ["RBI"] },
    runs:         { labels: ["R"]  },
  },
};

// ── Session cache ────────────────────────────────────────────────────────────
// Keyed by `${sport}:${athleteId}:${statType}:${limit}`. One fetch per key per
// page load; React Query layer on top adds cross-component deduplication.

const cache = new Map<string, PlayerGameStat[]>();

// ── Main fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch the last `limit` games' stat values for a player.
 * Returns [] on any failure, empty gamelog, or unsupported sport.
 */
export async function fetchPlayerLastGames(
  sport: string,
  athleteId: string | undefined,
  statType: string,
  limit = 5,
): Promise<PlayerGameStat[]> {
  if (!athleteId) return [];
  const s = sport.toUpperCase() as GameLogSport;
  if (!ATHLETE_GAMELOG[s]) return [];

  const spec = STAT_LOOKUP[s]?.[statType.toLowerCase()];
  if (!spec && statType.toLowerCase() !== "pra") return [];

  const key = `${s}:${athleteId}:${statType}:${limit}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = `${ATHLETE_GAMELOG[s]}/${athleteId}/gamelog`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) { cache.set(key, []); return []; }

    const json = (await res.json()) as EspnGameLog;
    const events = json.events ?? {};
    const seasonTypes = json.seasonTypes ?? [];

    const rows: PlayerGameStat[] = [];
    for (const st of seasonTypes) {
      for (const cat of st.categories ?? []) {
        // Skip non-"total" aggregate rows — we want per-event rows only.
        if (cat.events == null) continue;
        const labels = cat.labels ?? [];
        if (!labels.length) continue;

        // NFL category-name gate
        if (s === "NFL" && spec?.categoryContains) {
          const n = (cat.name ?? "").toLowerCase();
          if (!n.includes(spec.categoryContains)) continue;
        }

        // For PRA: we need to sum points + rebounds + assists → iterate differently
        if (statType.toLowerCase() === "pra" && s === "NBA") {
          const pIdx = findLabelIdx(labels, ["PTS", "P"]);
          const rIdx = findLabelIdx(labels, ["REB", "R"]);
          const aIdx = findLabelIdx(labels, ["AST", "A"]);
          if (pIdx < 0 || rIdx < 0 || aIdx < 0) continue;
          for (const e of cat.events) {
            const ev = events[e.eventId];
            if (!ev) continue;
            const p = Number(e.stats?.[pIdx]);
            const r = Number(e.stats?.[rIdx]);
            const a = Number(e.stats?.[aIdx]);
            if (!Number.isFinite(p + r + a)) continue;
            rows.push({
              date:     (ev.date ?? "").slice(0, 10),
              opponent: parseOpponent(ev.atVs),
              homeAway: (ev.atVs ?? "").startsWith("@") ? "away" : "home",
              value:    p + r + a,
            });
          }
          continue;
        }

        if (!spec) continue;
        const idx = findLabelIdx(labels, spec.labels);
        if (idx < 0) continue;

        for (const e of cat.events) {
          const ev = events[e.eventId];
          if (!ev) continue;
          const raw = e.stats?.[idx];
          if (raw == null) continue;
          const value = spec.parse ? spec.parse(String(raw)) : Number(raw);
          if (!Number.isFinite(value)) continue;
          rows.push({
            date:     (ev.date ?? "").slice(0, 10),
            opponent: parseOpponent(ev.atVs),
            homeAway: (ev.atVs ?? "").startsWith("@") ? "away" : "home",
            value,
          });
        }
      }
    }

    // De-dup by date+opponent (sometimes multiple categories surface the same
    // event), then sort descending and slice.
    const seen = new Set<string>();
    const deduped: PlayerGameStat[] = [];
    for (const r of rows) {
      const k = `${r.date}:${r.opponent}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(r);
    }
    deduped.sort((a, b) => (a.date < b.date ? 1 : -1));
    const out = deduped.slice(0, limit);
    cache.set(key, out);
    return out;
  } catch {
    clearTimeout(timer);
    cache.set(key, []);
    return [];
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findLabelIdx(labels: string[], wanted: string[]): number {
  const norm = labels.map((l) => (l ?? "").trim().toUpperCase());
  for (const w of wanted) {
    const i = norm.indexOf(w.toUpperCase());
    if (i >= 0) return i;
  }
  return -1;
}

function parseOpponent(atVs: string | undefined): string {
  if (!atVs) return "";
  return atVs.replace(/^(@|vs\s*)/i, "").trim().toUpperCase();
}

// ── ESPN gamelog response shape (partial) ────────────────────────────────────

interface EspnGameLog {
  events?: Record<string, EspnEvent>;
  seasonTypes?: EspnSeasonType[];
}
interface EspnEvent {
  date?: string;
  atVs?: string;
  gameResult?: string;
}
interface EspnSeasonType {
  type?: number;
  name?: string;
  categories?: EspnCategory[];
}
interface EspnCategory {
  type?: string;
  name?: string;
  labels?: string[];
  events?: { eventId: string; stats?: string[] }[];
}
