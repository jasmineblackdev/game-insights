/**
 * ET "sports day" bucketing (Parlay-Intelligence-Bot `GameFormatter.get_api_date`):
 * before 6:00 ET, treat calendar date as previous day for grouping.
 */
const ET = "America/New_York";

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map((x) => Number.parseInt(x, 10));
  return { y, m, d };
}

function addCalendarDaysYmd(ymd: string, delta: number): string {
  const { y, m, d } = parseYmd(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Current calendar date in US/Eastern as `YYYY-MM-DD`. */
function etCalendarYmd(now: Date): string {
  return now.toLocaleDateString("en-CA", { timeZone: ET });
}

function etHour(now: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    hour12: false,
  }).format(now);
  return Number.parseInt(h, 10);
}

/** `{ todayYmd, tomorrowYmd, yesterdayYmd }` with 6am ET rollover. */
export function getSportsDayBoundsEt(now: Date = new Date()): {
  todayYmd: string;
  tomorrowYmd: string;
  yesterdayYmd: string;
} {
  let cal = etCalendarYmd(now);
  if (etHour(now) < 6) {
    cal = addCalendarDaysYmd(cal, -1);
  }
  return {
    todayYmd: cal,
    tomorrowYmd: addCalendarDaysYmd(cal, 1),
    yesterdayYmd: addCalendarDaysYmd(cal, -1),
  };
}

export type ScheduleSection = "today" | "tomorrow" | "other";

export function bucketStartTimeEt(isoUtc: string): ScheduleSection | null {
  const t = new Date(isoUtc);
  if (!Number.isFinite(t.getTime())) return null;
  const gameYmd = t.toLocaleDateString("en-CA", { timeZone: ET });
  const { todayYmd, tomorrowYmd } = getSportsDayBoundsEt();
  if (gameYmd === todayYmd) return "today";
  if (gameYmd === tomorrowYmd) return "tomorrow";
  return "other";
}
