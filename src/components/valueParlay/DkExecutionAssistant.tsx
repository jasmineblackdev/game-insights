import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Loader2, MessageSquare, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ValueBetCandidate } from "@/lib/valueParlay/types";

type Mode = "slip" | "pool" | "both";
type Msg  = { role: "user" | "assistant"; content: string };

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/dk-execution-assistant`;

function trimLeg(c: ValueBetCandidate) {
  // Send only the fields the playbook needs — keep the payload small so the
  // model has room for actual reasoning.
  return {
    selectionLabel:        c.selectionLabel,
    sport:                 c.sport,
    pickType:              c.pickType,
    statType:              c.statType,
    matchupLabel:          c.matchupLabel,
    gameTimeLabel:         c.gameTimeLabel,
    americanOdds:          c.americanOdds,
    modelProbability:      Math.round((c.modelProbability ?? 0) * 1000) / 10, // %
    impliedProbability:    Math.round((c.impliedProbability ?? 0) * 1000) / 10,
    edgePct:               Math.round((c.edge ?? 0) * 1000) / 10,
    confidence:            c.confidence,
    volatilityScore:       Math.round(c.volatilityScore ?? 0),
    eligibleAsSingle:      c.eligibleAsSingle ?? null,
    singleBetReason:       c.singleBetReason ?? null,
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
  const [mode, setMode]         = useState<Mode>("both");
  const [input, setInput]       = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Top recommended pool, capped — keeps payload reasonable.
  const recommendedPool = useMemo(
    () =>
      candidatePool
        .filter((c) => c.isRecommended)
        .slice(0, 12),
    [candidatePool],
  );

  const buildContext = () => ({
    mode,
    slipLegs: mode === "pool" ? [] : slipLegs.map(trimLeg),
    candidatePool: mode === "slip" ? [] : recommendedPool.map(trimLeg),
  });

  const send = async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim();
    if (!text || loading) return;
    setError(null);
    setInput("");

    const userMsg: Msg = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantSoFar = "";
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    try {
      const resp = await fetch(CHAT_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? ""}`,
        },
        body: JSON.stringify({
          context: buildContext(),
          messages: [...messages, userMsg],
        }),
      });

      if (!resp.ok || !resp.body) {
        let msg = "Assistant unavailable.";
        try {
          const j = await resp.json();
          if (j?.error) msg = j.error;
        } catch { /* ignore */ }
        if (resp.status === 429) msg = "Rate limited — wait a moment and retry.";
        if (resp.status === 402) msg = "AI credits exhausted. Add funds in Settings → Workspace → Usage.";
        setError(msg);
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
            if (c) upsert(c);
          } catch {
            buf = line + "\n" + buf;
            break;
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error(e);
        setError("Connection lost while streaming.");
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

  const quickPrompts = [
    "Audit my slip — what should I remove?",
    "Build me a SAFE 2-leg from the pool.",
    "Build a CASHOUT 3-leg from the pool.",
    "Should I cash out now?",
  ];

  if (!open) {
    return (
      <div className="rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="font-display font-bold text-sm text-foreground flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-primary" />
              DraftKings Execution Assistant
            </p>
            <p className="text-[11px] text-muted-foreground">
              Converts your GameLens signals into clear "place / remove / do not bet"
              decisions before you tap Submit on DraftKings.
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
          DraftKings Execution Assistant
        </p>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setOpen(false)}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Context source toggle */}
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">Analyze:</span>
        {(["slip", "pool", "both"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-2 py-0.5 rounded-full border transition-colors ${
              mode === m
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted/40 text-muted-foreground border-border/60 hover:bg-muted"
            }`}
          >
            {m === "slip" ? "My slip" : m === "pool" ? "Today's pool" : "Both"}
          </button>
        ))}
        <span className="text-muted-foreground/70 ml-auto tabular-nums">
          {mode !== "pool" ? `${slipLegs.length} slip` : ""}{mode === "both" ? " · " : " "}
          {mode !== "slip" ? `${recommendedPool.length} pool` : ""}
        </span>
      </div>

      {/* Quick prompts */}
      {messages.length === 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {quickPrompts.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => send(q)}
              disabled={loading}
              className="text-[11px] px-2 py-1 rounded-full bg-muted/60 hover:bg-muted text-foreground/80 border border-border/60 disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      ) : null}

      {/* Transcript */}
      <div className="max-h-96 overflow-y-auto space-y-3 rounded-lg bg-muted/20 p-3 text-sm">
        {messages.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">
            Ask anything execution-related, or tap a quick prompt above. The assistant
            sees your current slip and today's recommended pool.
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background border border-border/60 text-foreground"
                }`}
              >
                {m.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-bold [&_ul]:my-1 [&_p]:my-1">
                    <ReactMarkdown>{m.content || "…"}</ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{m.content}</p>
                )}
              </div>
            </div>
          ))
        )}
        {loading && messages[messages.length - 1]?.role === "user" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Thinking…
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : null}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="e.g. Should I drop the Lakers leg?  ·  Build a SAFE 2-leg."
          rows={2}
          className="text-sm resize-none"
          disabled={loading}
        />
        {loading ? (
          <Button size="sm" variant="outline" onClick={cancel}>Stop</Button>
        ) : (
          <Button size="sm" onClick={() => send()} disabled={!input.trim()} className="gap-1">
            <Send className="w-3.5 h-3.5" />
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
