/**
 * Debug badge showing odds provider metadata.
 * Only renders in development (import.meta.env.DEV).
 *
 * Displays: provider, cache/live/stale, fallback depth, event count,
 * markets returned, and per-provider health snapshot.
 */

import { useEffect, useState } from "react";
import { getProviderMeta, type OddsProviderMeta } from "@/lib/multiOddsProvider";

interface Props {
  sport: "mma" | "boxing";
}

export function OddsDebugBadge({ sport }: Props) {
  const [meta, setMeta]     = useState<OddsProviderMeta | null>(null);
  const [open, setOpen]     = useState(false);

  useEffect(() => {
    // Poll every 2s — cheap since it's just reading a module-level Map
    const id = setInterval(() => setMeta(getProviderMeta(sport)), 2000);
    setMeta(getProviderMeta(sport)); // immediate read
    return () => clearInterval(id);
  }, [sport]);

  if (!import.meta.env.DEV || !meta) return null;

  const sourceLabel = meta.stale
    ? "STALE"
    : meta.fromCache
      ? "cache"
      : "live";

  const sourceBg = meta.stale
    ? "bg-orange-600"
    : meta.fromCache
      ? "bg-blue-600"
      : "bg-green-700";

  const depthBg = meta.fallbackDepth === 0
    ? "bg-green-700"
    : meta.fallbackDepth <= 2
      ? "bg-yellow-600"
      : "bg-red-600";

  return (
    <div className="fixed bottom-4 right-4 z-50 font-mono text-xs select-none">
      {/* Collapsed pill */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full bg-gray-900/90 border border-gray-700 px-2.5 py-1 text-gray-200 hover:bg-gray-800 transition-colors shadow-lg"
      >
        <span className="text-gray-400">odds</span>
        <span className={`px-1.5 rounded-sm ${sourceBg} text-white`}>{sourceLabel}</span>
        <span className={`px-1.5 rounded-sm ${depthBg} text-white`}>d{meta.fallbackDepth}</span>
        <span className="text-gray-300">{meta.servedBy}</span>
        <span className="text-gray-500">{meta.eventCount}ev</span>
      </button>

      {/* Expanded panel */}
      {open && (
        <div className="mt-1 w-72 rounded-lg bg-gray-900/95 border border-gray-700 shadow-xl text-gray-200 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700 flex justify-between items-center">
            <span className="font-semibold uppercase tracking-wide text-gray-400">{sport} odds debug</span>
            <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-300">✕</button>
          </div>

          <div className="px-3 py-2 space-y-1 border-b border-gray-700">
            <Row label="Provider"       value={meta.servedBy} />
            <Row label="Source"         value={sourceLabel} valueClass={sourceBg + " px-1 rounded text-white"} />
            <Row label="Fallback depth" value={`${meta.fallbackDepth}`} valueClass={depthBg + " px-1 rounded text-white"} />
            <Row label="Events"         value={`${meta.eventCount}`} />
            <Row label="Markets"        value={meta.marketsReturned.join(", ") || "none"} />
            {meta.stale && meta.staleAgeMs > 0 && (
              <Row
                label="Stale age"
                value={meta.staleAgeMs < 3_600_000
                  ? `${Math.round(meta.staleAgeMs / 60_000)}min`
                  : `${(meta.staleAgeMs / 3_600_000).toFixed(1)}h`}
                valueClass="text-orange-400"
              />
            )}
            {meta.lastFreshAt > 0 && (
              <Row
                label="Last fresh"
                value={new Date(meta.lastFreshAt).toLocaleTimeString()}
              />
            )}
          </div>

          <div className="px-3 py-2">
            <div className="text-gray-500 uppercase tracking-wide text-[10px] mb-1">Provider health</div>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left pb-0.5">name</th>
                  <th className="text-right pb-0.5">rate</th>
                  <th className="text-right pb-0.5">p50ms</th>
                  <th className="text-right pb-0.5">mkts</th>
                  <th className="text-right pb-0.5">cb</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(meta.healthSnapshot).map(([name, h]) => (
                  <tr key={name} className={name === meta.servedBy ? "text-green-400" : "text-gray-400"}>
                    <td className="py-0.5 truncate max-w-[80px]">{name}</td>
                    <td className="text-right">{h.successRate}</td>
                    <td className="text-right">{h.avgLatencyMs > 0 ? `${h.avgLatencyMs}` : "—"}</td>
                    <td className="text-right">{h.avgMarkets}</td>
                    <td className={`text-right ${h.circuitOpen ? "text-red-400" : "text-gray-600"}`}>
                      {h.circuitOpen ? "open" : "·"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500">{label}</span>
      <span className={valueClass ?? "text-gray-200"}>{value}</span>
    </div>
  );
}
