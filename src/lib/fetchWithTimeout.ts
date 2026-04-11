/** Browser fetch with AbortSignal timeout — improves UX on slow/hung networks. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = 20_000, signal: outer, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else
        outer.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${t ? `: ${t.slice(0, 120)}` : ""}`);
  }
  return (await res.json()) as T;
}
