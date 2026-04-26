/**
 * Shared helper to unwrap the odds-api-proxy 200-envelope.
 *
 * The Edge function (supabase/functions/odds-api-proxy/index.ts)
 * wraps upstream 4xx responses in:
 *   HTTP 200 → { proxied: true, upstream_status, error_code, body }
 * so the Supabase JS client doesn't log them as RUNTIME_ERROR.
 *
 * Both oddsApiFetch.fetchViaEdge and multiOddsProvider.proxyGet need
 * to unwrap this envelope before downstream code reads body shape.
 * Centralizing the logic keeps the two paths consistent and makes
 * adding instrumentation trivial.
 */

export interface OddsEnvelopeMeta {
  /** True when the response was wrapped + unwrapped here. */
  unwrapped: boolean;
  /** Upstream status when an envelope was unwrapped. */
  upstreamStatus?: number;
  /** Upstream error_code when present. */
  errorCode?: string;
}

/**
 * If `res` is an odds-api-proxy 200 envelope, reconstruct a Response
 * with the real upstream status. Otherwise pass through unchanged.
 *
 * Returns the unwrapped Response plus a small meta object so callers
 * can log which path was actually hit.
 */
export async function unwrapEdgeEnvelope(res: Response): Promise<{ res: Response; meta: OddsEnvelopeMeta }> {
  if (!res.ok) return { res, meta: { unwrapped: false } };
  let parsed: unknown = null;
  try {
    parsed = await res.clone().json();
  } catch {
    return { res, meta: { unwrapped: false } };
  }
  if (
    typeof parsed === "object" && parsed !== null
    && "proxied" in parsed
    && (parsed as { proxied?: boolean }).proxied === true
  ) {
    const env = parsed as { proxied: true; upstream_status: number; error_code?: string; body?: unknown };
    const bodyJson = JSON.stringify(env.body ?? { error_code: env.error_code ?? "" });
    return {
      res: new Response(bodyJson, {
        status: env.upstream_status,
        headers: { "Content-Type": "application/json" },
      }),
      meta: {
        unwrapped: true,
        upstreamStatus: env.upstream_status,
        errorCode: env.error_code,
      },
    };
  }
  return { res, meta: { unwrapped: false } };
}

/**
 * Structured one-line log of an odds-api fetch. Uses console.debug so
 * it's silent in production browsers by default but available for
 * triage. Format makes filtering easy:
 *   [odds-api] path=oddsApiFetch.edge sport=baseball_mlb status=401 unwrapped=true error=OUT_OF_USAGE_CREDITS
 */
export function logOddsApiCall(args: {
  path: string;            // "oddsApiFetch.edge" | "oddsApiFetch.dev" | "oddsApiFetch.direct" | "multiOddsProvider"
  sportKey?: string;
  status: number;
  unwrapped: boolean;
  errorCode?: string;
}): void {
  const parts: string[] = [
    `path=${args.path}`,
    args.sportKey ? `sport=${args.sportKey}` : "",
    `status=${args.status}`,
    `unwrapped=${args.unwrapped}`,
    args.errorCode ? `error=${args.errorCode}` : "",
  ].filter(Boolean);
  // eslint-disable-next-line no-console
  console.debug(`[odds-api] ${parts.join(" ")}`);
}
