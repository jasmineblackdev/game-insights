/**
 * Bet Decision Assistant
 *
 * Hybrid design: quick actions and core analyses run on a deterministic
 * local engine (executionAssistant.ts) that uses existing optimizer
 * helpers. Freeform follow-up questions stream through the Lovable AI
 * Gateway. The local engine means the assistant stays useful even if
 * the gateway is down or the LOVABLE_API_KEY is missing — quick
 * actions never silently fail.
 *
 * Manual second-device sportsbook workflow only — no DraftKings
 * automation, no sportsbook API, no auto-place. (Older copy referred
 * to this as the "DraftKings Execution Assistant"; the panel was
 * renamed to "Bet Decision Assistant" because the deterministic
 * engine is sportsbook-agnostic.)
 */

import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronRight,
  Layers,
  Loader2,
  MessageSquare,
  Search,
  Send,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useValueParlay } from "@/context/ValueParlayContext";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";
import {
  type AssistantResponse,
  type AssistantWarning,
  auditSlip,
  buildSafeParlay,
  buildCashoutParlay,
  compareSlipVsPool,
  findWeakestLeg,
  improvePayout,
  scanWarnings,
} from "@/lib/valueParlay/executionAssistant";

type ContextMode = "slip" | "pool" | "both";

type Turn =
  | { kind: "user"; text: string }
  | { kind: "assistant_md"; text: string } // streamed LLM response
  | { kind: "assistant_struct"; response: AssistantResponse }; // deterministic engine

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/dk-execution-assistant`;
const HAS_SUPABASE = Boolean(import.meta.env.VITE_SUPABASE_URL);

function trimLeg(c: ValueBetCandidate) {
  return {
    selectionLabel:        c.selectionLabel,
    sport:                 c.sport,
    pickType:              c.pickType,
    statType:              c.statType,
    americanOdds:          c.americanOdds,
    modelProbability:      Math.round((c.modelProbability ?? 0) * 1000) / 10,
    impliedProbability:    Math.round((c.impliedProbability ?? 0) * 1000) / 10,
    edgePct:               Math.round((c.edge ?? 0) * 1000) / 10,
    confidence:            c.confidence,
    volatilityScore:       Math.round(c.volatilityScore ?? 0),
    recentHitRate:         c.recentHitRate ?? null,
    recentHitRateSamples:  c.recentHitRateSamples ?? null,
    staleLineFlag:         c.staleLineFlag ?? false,
    lateChangeInvalidated: c.lateChangeInvalidated ?? false,
    riskBand:              c.riskBand,
  };
}

interface Props {
  slipLegs: ValueBetCandidate[];
  candidatePool: ValueBetCandidate[];
}

export function DkExecutionAssistant({ slipLegs, candidatePool }: Props) {
  const [open, setOpen]         = useState(false);
  const [mode, setMode]         = useState<ContextMode>("both");
  const [input, setInput]       = useState("");
  const [turns, setTurns]       = useState<Turn[]>([]);
  const [llmLoading, setLoading] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { setBuilderLegs, removeValueLeg } = useValueParlay();

  // Recommended pool for engine context — same filter the LLM used.
  const recommendedPool = useMemo(
    () => candidatePool.filter((c) => c.isRecommended).slice(0, 24),
    [candidatePool],
  );

  // Always-on safety scan — surfaces warnings even before user acts.
  const liveWarnings = useMemo<AssistantWarning[]>(() => {
    return scanWarnings({ slipLegs, pool: recommendedPool, context: mode });
  }, [slipLegs, recommendedPool, mode]);

  // "Most pool candidates are AVOID" — fired when the candidate pool
  // exists but the recommended subset is sparse, meaning a SAFE build
  // probably can't pick two high-confidence low-vol legs.
  const poolAvoidWarning = useMemo<AssistantWarning | null>(() => {
    if (candidatePool.length < 5) return null;
    const recommendedRatio = recommendedPool.length / candidatePool.length;
    const safeCandidates = recommendedPool.filter(
      (c) => c.confidence === "high" && (c.volatilityScore ?? 0) < 55,
    );
    if (recommendedRatio < 0.4 || safeCandidates.length < 2) {
      return {
        level: "warn",
        message:
          "Most available picks are marked AVOID. Safe build may be unavailable.",
      };
    }
    return null;
  }, [candidatePool, recommendedPool]);

  const hasSlip = slipLegs.length > 0;
  const hasPool = recommendedPool.length > 0;
  const empty = !hasSlip && candidatePool.length === 0;

  const appendTurns = (...t: Turn[]) => setTurns((prev) => [...prev, ...t]);

  // ── Deterministic quick actions ─────────────────────────────────────
  const runQuickAction = (label: string, response: AssistantResponse) => {
    appendTurns(
      { kind: "user", text: label },
      { kind: "assistant_struct", response },
    );
  };

  const onAuditSlip = () => runQuickAction(
    "Audit my slip — what should I remove?",
    auditSlip({ slipLegs }),
  );
  const onFindWeakest = () => runQuickAction(
    "Find weakest leg",
    findWeakestLeg({ slipLegs }),
  );
  const onBuildSafe = () => runQuickAction(
    "Build SAFE 2-leg",
    buildSafeParlay({ pool: recommendedPool }),
  );
  const onBuildCashout = () => runQuickAction(
    "Build CASH-OUT 3-leg",
    buildCashoutParlay({ pool: recommendedPool }),
  );
  const onImprovePayout = () => runQuickAction(
    "Improve payout without longshots",
    improvePayout({ slipLegs, pool: recommendedPool }),
  );
  const onCompare = () => runQuickAction(
    "Compare my slip vs the pool",
    compareSlipVsPool({ slipLegs, pool: recommendedPool }),
  );

  // ── Apply structured response actions to the slip ──────────────────
  const applyBuiltParlay = (legs: ValueBetCandidate[]) => {
    setBuilderLegs(legs);
    toast.success(`Applied ${legs.length}-leg parlay to slip.`);
  };
  const applyRemoveLeg = (legId: string, label: string) => {
    removeValueLeg(legId);
    toast.success(`Removed ${label}.`);
  };

  // ── Freeform LLM streaming (existing behavior, better errors) ─────
  const sendFreeform = async () => {
    const text = input.trim();
    if (!text || llmLoading) return;
    setLlmError(null);
    setInput("");

    appendTurns({ kind: "user", text });
    setLoading(true);

    if (!HAS_SUPABASE) {
      setLlmError("Assistant unavailable: VITE_SUPABASE_URL is not configured.");
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantSoFar = "";
    const upsertMd = (chunk: string) => {
      assistantSoFar += chunk;
      setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.kind === "assistant_md") {
          return prev.map((t, i) => (i === prev.length - 1 ? { ...t, text: assistantSoFar } as Turn : t));
        }
        return [...prev, { kind: "assistant_md", text: assistantSoFar } as Turn];
      });
    };

    try {
      const llmContext = {
        mode,
        slipLegs: mode === "pool" ? [] : slipLegs.map(trimLeg),
        candidatePool: mode === "slip" ? [] : recommendedPool.map(trimLeg),
      };

      const resp = await fetch(CHAT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""}`,
        },
        body: JSON.stringify({
          context: llmContext,
          messages: turns
            .filter((t): t is Extract<Turn, { kind: "user" } | { kind: "assistant_md" }> =>
              t.kind === "user" || t.kind === "assistant_md")
            .map((t) => ({ role: t.kind === "user" ? "user" : "assistant", content: t.kind === "user" ? t.text : t.text }))
            .concat([{ role: "user", content: text }]),
        }),
      });

      if (!resp.ok || !resp.body) {
        // Be specific so the user knows what's wrong rather than a generic
        // "Assistant unavailable.".
        let detail = "";
        try {
          const j = await resp.json();
          if (j?.error) detail = ` ${j.error}`;
        } catch { /* ignore */ }

        const reason =
          resp.status === 401 || resp.status === 403 ? "edge function rejected the auth header"
          : resp.status === 402 ? "Lovable AI gateway credits exhausted"
          : resp.status === 404 ? "edge function `dk-execution-assistant` not deployed"
          : resp.status === 429 ? "rate limited — try again in a moment"
          : resp.status === 500 ? "edge function error (likely missing LOVABLE_API_KEY secret)"
          : `unexpected status ${resp.status}`;

        setLlmError(
          `Assistant chat unavailable: ${reason}.${detail} ` +
          `Quick actions still work — they run locally.`,
        );
        setLoading(false);
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (json === "[DONE]") { done = true; break; }
          try {
            const p = JSON.parse(json);
            const c = p.choices?.[0]?.delta?.content;
            if (c) upsertMd(c);
          } catch {
            buf = line + "\n" + buf;
            break;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error(e);
        setLlmError("Assistant chat lost the connection. Quick actions still work — they run locally.");
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
  };

  // ── Render ─────────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-display font-bold text-sm text-foreground flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              Bet Decision Assistant
            </p>
            <p className="text-[11px] text-muted-foreground">
              Audit your slip · build SAFE / CASH-OUT alternatives · find the weakest leg.
              Manual second-device workflow.
            </p>
          </div>
          <Button size="sm" onClick={() => setOpen(true)} className="gap-1 shrink-0">
            <MessageSquare className="w-3.5 h-3.5" />
            Open
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-background/60 p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-display font-bold text-sm text-foreground flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" />
          Bet Decision Assistant
        </p>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setOpen(false)}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Context mode pills */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">Analyze:</span>
        {(["slip", "pool", "both"] as ContextMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "px-2 py-0.5 rounded-full border transition-colors",
              mode === m
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted",
            )}
          >
            {m === "slip" ? "My slip" : m === "pool" ? "Today's pool" : "Both"}
          </button>
        ))}
        <span className="text-muted-foreground/70 ml-auto tabular-nums">
          {mode !== "pool" ? `${slipLegs.length} slip` : ""}{mode === "both" ? " · " : " "}
          {mode !== "slip" ? `${recommendedPool.length} pool` : ""}
        </span>
      </div>

      {/* Live safety warnings + pool-avoid heuristic */}
      {liveWarnings.length || poolAvoidWarning ? (
        <div className="space-y-1">
          {liveWarnings.map((w, i) => (
            <WarningRow key={`lw-${i}`} warning={w} />
          ))}
          {poolAvoidWarning ? <WarningRow warning={poolAvoidWarning} /> : null}
        </div>
      ) : null}

      {/* Empty state — neither slip nor pool to act on. */}
      {empty ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-6 text-center">
          <p className="text-sm font-semibold text-foreground">Nothing to analyze yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add legs or choose Today's pool, then run an audit.
          </p>
        </div>
      ) : (
        // Quick actions — bigger, scannable, two-column. Each button
        // shows an inline reason when disabled instead of just a muted
        // background, so the user knows what to do next.
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <QuickAction
            icon={Search}
            label="Audit Slip"
            hint="Verdict + risk read on every leg."
            disabledReason={!hasSlip ? "Add legs to your slip first." : null}
            onClick={onAuditSlip}
          />
          <QuickAction
            icon={Target}
            label="Find Weakest Leg"
            hint="Surface the leg most likely to drop the parlay."
            disabledReason={!hasSlip ? "Add legs to your slip first." : null}
            onClick={onFindWeakest}
          />
          <QuickAction
            icon={ArrowLeftRight}
            label="Compare Slip vs Pool"
            hint="See if today's pool has stronger swaps."
            disabledReason={
              !hasSlip ? "Add legs to your slip first."
              : !hasPool ? "Wait for today's pool to load."
              : null
            }
            onClick={onCompare}
          />
          <QuickAction
            icon={Shield}
            label="Build Safe 2-Leg"
            hint="Two highest-confidence, low-volatility legs."
            disabledReason={!hasPool ? "Wait for today's pool to load." : null}
            onClick={onBuildSafe}
          />
          <QuickAction
            icon={Layers}
            label="Build Cash-Out 3-Leg"
            hint="3-leg target with realistic cash-out exit."
            disabledReason={!hasPool ? "Wait for today's pool to load." : null}
            onClick={onBuildCashout}
          />
          <QuickAction
            icon={TrendingUp}
            label="Improve Payout"
            hint="Lift combined odds without adding longshots."
            disabledReason={!hasPool ? "Wait for today's pool to load." : null}
            onClick={onImprovePayout}
          />
        </div>
      )}

      {/* Chat — secondary surface for freeform follow-ups. Quick
          actions above cover the common decisions; the transcript is
          for "why did you say X" / "what about my last leg?" follow-
          ups that don't fit the quick-action shape. */}
      <div className="flex items-center gap-2 pt-1">
        <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
          Chat (optional)
        </p>
      </div>

      {/* Transcript */}
      <div className="max-h-[28rem] overflow-y-auto space-y-3 rounded-lg bg-muted/20 p-3 text-sm">
        {turns.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">
            Tap a quick action above for an instant decision, or type a freeform question.
            Quick actions run locally and don't depend on the LLM gateway.
          </p>
        ) : (
          turns.map((t, i) => (
            <TurnView
              key={i}
              turn={t}
              onApplyParlay={applyBuiltParlay}
              onRemoveLeg={applyRemoveLeg}
            />
          ))
        )}
        {llmLoading && turns[turns.length - 1]?.kind === "user" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Thinking…
          </div>
        ) : null}
      </div>

      {llmError ? (
        <p className="text-[11px] text-destructive flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{llmError}</span>
        </p>
      ) : null}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendFreeform();
            }
          }}
          placeholder="Ask anything — e.g. Should I drop the Lakers leg?"
          rows={2}
          className="text-sm resize-none"
          disabled={llmLoading}
        />
        {llmLoading ? (
          <Button size="sm" variant="outline" onClick={cancel}>Stop</Button>
        ) : (
          <Button size="sm" onClick={sendFreeform} disabled={!input.trim()} className="gap-1">
            <Send className="w-3.5 h-3.5" />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function QuickAction({
  icon: Icon,
  label,
  hint,
  disabledReason,
  onClick,
}: {
  icon: typeof Sparkles;
  label: string;
  hint: string;
  /** When non-null, the button is disabled and this string explains why. */
  disabledReason: string | null;
  onClick: () => void;
}) {
  const disabled = disabledReason !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : hint}
      className={cn(
        "group flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-all",
        disabled
          ? "border-border/40 bg-muted/10 cursor-not-allowed"
          : "border-border bg-card hover:border-primary/60 hover:bg-primary/[0.04] active:scale-[0.99]",
      )}
    >
      <Icon
        className={cn(
          "w-4 h-4 shrink-0 mt-0.5",
          disabled ? "text-muted-foreground/40" : "text-primary",
        )}
      />
      <div className="flex-1 min-w-0 space-y-0.5">
        <p
          className={cn(
            "text-xs font-bold",
            disabled ? "text-muted-foreground/60" : "text-foreground",
          )}
        >
          {label}
        </p>
        <p
          className={cn(
            "text-[10px] leading-snug",
            disabled ? "text-muted-foreground/50 italic" : "text-muted-foreground",
          )}
        >
          {disabled ? disabledReason : hint}
        </p>
      </div>
    </button>
  );
}

function WarningRow({ warning }: { warning: AssistantWarning }) {
  return (
    <div className={cn(
      "rounded-md border px-2.5 py-1.5 text-[11px] flex items-start gap-1.5",
      warning.level === "block"
        ? "border-red-500/40 bg-red-500/[0.06] text-red-700 dark:text-red-400"
        : "border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400",
    )}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      <span>{warning.message}</span>
    </div>
  );
}

function TurnView({
  turn,
  onApplyParlay,
  onRemoveLeg,
}: {
  turn: Turn;
  onApplyParlay: (legs: ValueBetCandidate[]) => void;
  onRemoveLeg: (legId: string, label: string) => void;
}) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm bg-primary text-primary-foreground">
          <p className="whitespace-pre-wrap">{turn.text}</p>
        </div>
      </div>
    );
  }
  if (turn.kind === "assistant_md") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm bg-background border border-border/60 text-foreground">
          <div className="prose prose-sm dark:prose-invert max-w-none [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-bold [&_ul]:my-1 [&_p]:my-1">
            <ReactMarkdown>{turn.text || "…"}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }
  // Structured response card
  return <StructuredResponseCard
    response={turn.response}
    onApplyParlay={onApplyParlay}
    onRemoveLeg={onRemoveLeg}
  />;
}

function StructuredResponseCard({
  response,
  onApplyParlay,
  onRemoveLeg,
}: {
  response: AssistantResponse;
  onApplyParlay: (legs: ValueBetCandidate[]) => void;
  onRemoveLeg: (legId: string, label: string) => void;
}) {
  const verdictTone =
    response.verdict === "PLACE" || response.verdict === "BUILD" ? "border-emerald-500/40 bg-emerald-500/[0.06]"
    : response.verdict === "MODIFY" ? "border-amber-500/40 bg-amber-500/[0.06]"
    : response.verdict === "AVOID" ? "border-red-500/40 bg-red-500/[0.06]"
    : "border-border/60 bg-muted/30";
  const verdictText =
    response.verdict === "PLACE" || response.verdict === "BUILD" ? "text-emerald-700 dark:text-emerald-400"
    : response.verdict === "MODIFY" ? "text-amber-700 dark:text-amber-400"
    : response.verdict === "AVOID" ? "text-red-700 dark:text-red-400"
    : "text-muted-foreground";
  const riskTone =
    response.risk === "Low" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
    : response.risk === "Medium" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
    : "bg-red-500/15 text-red-700 dark:text-red-400";

  return (
    <div className={cn("rounded-lg border px-3 py-3 space-y-2", verdictTone)}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={cn("text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", verdictText, "bg-background/60 border border-current/30")}>
          {response.verdict.replace("_", " ")}
        </span>
        <span className="text-sm font-bold text-foreground">{response.title}</span>
        <span className={cn("ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full uppercase", riskTone)}>
          Risk {response.risk}
        </span>
      </div>
      <p className="text-xs text-foreground">{response.summary}</p>

      {response.weakestLeg ? (
        <div className="text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">Weakest leg: </span>
          {response.weakestLeg.label} — {response.weakestLeg.reason}
        </div>
      ) : null}

      {response.builtParlay && response.builtParlay.legs.length ? (
        <div className="rounded-md bg-background/60 border border-border/40 p-2 space-y-1">
          <p className="text-[11px] font-semibold text-foreground">
            {response.builtParlay.legs.length}-leg build
          </p>
          <ul className="text-[11px] text-muted-foreground space-y-0.5">
            {response.builtParlay.legs.map((l) => (
              <li key={l.id} className="flex items-center gap-1.5">
                <Check className="w-3 h-3 text-emerald-600" />
                <span className="text-foreground">{l.selectionLabel}</span>
                <span className="tabular-nums">{l.americanOdds > 0 ? `+${l.americanOdds}` : l.americanOdds}</span>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="default"
            className="w-full h-7 text-[11px] mt-1"
            onClick={() => response.builtParlay && onApplyParlay(response.builtParlay.legs)}
          >
            Apply to slip
          </Button>
        </div>
      ) : null}

      {response.actions.length ? (
        <div className="space-y-1">
          {response.actions.map((a, i) => (
            <ActionRow
              key={i}
              action={a}
              onRemove={response.weakestLeg && a.kind === "remove"
                ? () => response.weakestLeg && onRemoveLeg(response.weakestLeg.legId, response.weakestLeg.label)
                : undefined}
            />
          ))}
        </div>
      ) : null}

      {response.warnings.length ? (
        <div className="space-y-1 pt-1 border-t border-current/20">
          {response.warnings.map((w, i) => (
            <WarningRow key={i} warning={w} />
          ))}
        </div>
      ) : null}

      <div className="rounded-md bg-background/80 border border-border/40 px-2.5 py-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">DraftKings instruction</p>
        <p className="text-[12px] text-foreground">{response.draftKingsInstruction}</p>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  onRemove,
}: {
  action: { kind: string; text: string; legId?: string };
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-foreground">
      <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="flex-1 min-w-0">{action.text}</span>
      {onRemove ? (
        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}
