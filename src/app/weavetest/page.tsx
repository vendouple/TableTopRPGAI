"use client";

// TEMPORARY dev-only harness for eyeballing the Weaving sigil + forge:
//   /weavetest?theme=scifi&p=0.4      — fixed progress
//   /weavetest?theme=horror           — animated (timer-driven, works hidden)
//   /weavetest?rm=1&p=0.85            — force reduced-motion: WorldForge renders
//                                       one synchronous frame, exercising the
//                                       whole frame path without RAF
//   /weavetest?lobby=1&theme=western  — bare lobby-mode WorldForge
//   /weavetest?hook=1&stopAt=0.57     — exercises useWeaveProgress directly:
//                                       climbs via real phase/status signals,
//                                       then flips `complete` while progress
//                                       is stuck at `stopAt` (reproducing the
//                                       reported "finishes early, cuts off"
//                                       bug) and logs the aggregate close-out.
// Not linked from anywhere; delete after verification.

import { useEffect, useRef, useState } from "react";
import Weaving from "@/components/Weaving";
import WorldForge from "@/components/three/WorldForge";
import { useWeaveProgress } from "@/lib/client/weaveProgress";
import type { DmPhase } from "@/lib/campaign/types";

function HookHarness({ stopAt, slow }: { stopAt: number; slow: boolean }) {
  const [phase, setPhase] = useState<DmPhase | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [complete, setComplete] = useState(false);
  const startRef = useRef(0);
  const completeAtRef = useRef<{ t: number; p: number } | null>(null);
  const settledAtRef = useRef<number | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const weave = useWeaveProgress(true, phase, status, complete);

  useEffect(() => {
    startRef.current = performance.now();
    // A slow-then-fast climb, mimicking "2s/percent then 0.5s/percent": a
    // status nudge every 900ms for the first stretch (slow), then every
    // 220ms (fast) — before stopping the climb altogether at `stopAt` to
    // simulate the server finishing while the bar is still catching up.
    let n = 0;
    let cancelled = false;
    const scheduleNext = () => {
      if (cancelled) return;
      n += 1;
      const delay = slow ? 900 : n < 6 ? 900 : 220;
      setTimeout(() => {
        if (cancelled) return;
        setStatus(`tick-${n}`);
        if (n === 2) setPhase("world");
        if (n === 5) setPhase("scene");
        if (n === 9) setPhase("image");
        scheduleNext();
      }, delay);
    };
    scheduleNext();
    return () => {
      cancelled = true;
    };
  }, [slow, stopAt]);

  useEffect(() => {
    if (!complete && weave.progress >= stopAt) {
      setComplete(true);
      completeAtRef.current = { t: performance.now() - startRef.current, p: weave.progress };
      setLog((l) => [...l, `complete fired at t=${(completeAtRef.current!.t / 1000).toFixed(2)}s, progress=${(weave.progress * 100).toFixed(1)}%`]);
    }
  }, [complete, weave.progress, stopAt]);

  useEffect(() => {
    if (complete && weave.progress >= 0.999 && settledAtRef.current === null) {
      settledAtRef.current = performance.now() - startRef.current;
      const closeSec = completeAtRef.current ? (settledAtRef.current - completeAtRef.current.t) / 1000 : 0;
      setLog((l) => [...l, `SETTLED at t=${(settledAtRef.current! / 1000).toFixed(2)}s — close-out took ${closeSec.toFixed(2)}s`]);
    }
  }, [complete, weave.progress]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b0d16", color: "#e8dcc0", fontFamily: "monospace", padding: 24, fontSize: 14, overflow: "auto" }}>
      <h1>useWeaveProgress hook harness</h1>
      <p>stopAt={stopAt} slow={String(slow)}</p>
      <p style={{ fontSize: 32 }}>{(weave.progress * 100).toFixed(2)}%</p>
      <div style={{ width: 400, height: 16, background: "#222", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ width: `${weave.progress * 100}%`, height: "100%", background: "#e0b25f", transition: "none" }} />
      </div>
      <p>phase={phase} status={status} complete={String(complete)}</p>
      <ul>
        {log.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </div>
  );
}

export default function WeaveTest() {
  const [progress, setProgress] = useState(0);
  const [theme, setTheme] = useState("fantasy");
  const [fixed, setFixed] = useState<number | null>(null);
  const [lobby, setLobby] = useState(false);
  const [hook, setHook] = useState(false);
  const [stopAt, setStopAt] = useState(0.57);
  const [slow, setSlow] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTheme(params.get("theme") || "fantasy");
    setLobby(params.get("lobby") === "1");
    setHook(params.get("hook") === "1");
    setSlow(params.get("slow") === "1");
    const stop = params.get("stopAt");
    if (stop !== null) setStopAt(Math.min(1, Math.max(0.05, parseFloat(stop) || 0.57)));
    const p = params.get("p");
    if (p !== null) setFixed(Math.min(1, Math.max(0, parseFloat(p) || 0)));
    if (params.get("rm") === "1") {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) =>
        query.includes("prefers-reduced-motion")
          ? ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList)
          : orig(query)) as typeof window.matchMedia;
    }
    if (params.get("hook") === "1") {
      // Test-only: some automation contexts never foreground this tab, and
      // browsers fully SUSPEND requestAnimationFrame (not just throttle it,
      // like setTimeout) for backgrounded pages — the hook's tick loop would
      // silently never run. Polyfill with setTimeout so the harness actually
      // ticks regardless of tab visibility.
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16)) as typeof requestAnimationFrame;
      window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof cancelAnimationFrame;
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (fixed !== null) {
      setProgress(fixed);
      return;
    }
    const timer = setInterval(() => setProgress((prev) => Math.min(1, prev + 0.03)), 500);
    return () => clearInterval(timer);
  }, [ready, fixed]);

  if (!ready) return null;
  if (hook) return <HookHarness stopAt={stopAt} slow={slow} />;
  if (lobby) {
    return (
      <div className="lobby screen">
        <WorldForge mode="lobby" drama={0.6} theme={theme} />
      </div>
    );
  }
  return (
    <Weaving
      title="The Ashen Crown"
      progress={progress}
      complete={progress >= 1}
      joinCode="TEST42"
      theme={theme}
    />
  );
}
