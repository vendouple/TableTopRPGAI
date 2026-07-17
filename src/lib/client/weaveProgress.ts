"use client";

import { useEffect, useRef, useState } from "react";
import type { DmPhase } from "@/lib/campaign/types";

/**
 * The Weaving's monotonic progress model.
 *
 * The server's dmPhase is a *live activity label*, not a timeline: the opening
 * turn paints (image), files sheets (sheet), seeds NPCs (world), paints again…
 * so its raw index regresses by construction, and it drops to undefined
 * entirely during retries, stale sweeps, and the long post-narration tail.
 * Driving a bar off it directly is what made progress leap to ~80% and slump
 * back to ~20%.
 *
 * This hook turns those noisy signals into a bar that only ever rises:
 *  - each phase RATCHETS a floor to that phase's milestone (never down),
 *  - every dmStatus change nudges the floor a hair (work is happening even
 *    when the phase repeats),
 *  - between signals the bar eases asymptotically toward a small headroom
 *    above the floor, so it visibly breathes but never stalls flat or lies
 *    its way to 100%,
 *  - it never passes 95.5% until `complete`, then glides to 100%.
 *
 * The floor itself is a bad animation target on its own: the opening turn's
 * very FIRST tool call is usually `generate_image` for the establishing shot,
 * which sets the floor to the "image" milestone (68%) before the image has
 * even started rendering — and a player sheet write soon after pushes it to
 * "sheet" (82%), often within the first real seconds. If the shown value
 * chased that floor quickly, the bar would already read ~80% by the time
 * anyone looks at the screen, with the true heavy lifting (portraits, prose)
 * still ahead of it. So CLIMB_RATE caps the shown value's ascent in absolute
 * fraction/second regardless of how big the gap to the floor is — the climb
 * to "sheet" takes on the order of a minute of real, watchable counting up
 * from 0, matching how long that stretch actually runs in practice.
 */

const MILESTONES: Record<DmPhase, number> = {
  signal: 0.08,
  world: 0.3,
  scene: 0.5,
  image: 0.68,
  sheet: 0.82,
  integrate: 0.82,
  live: 0.93
};

/** Display order of the constellation nodes (mirrors Weaving's PHASES). */
const PHASE_ORDER: DmPhase[] = ["signal", "world", "scene", "image", "sheet", "live"];

const CEILING = 0.955;
const HEADROOM = 0.09;
const STATUS_NUDGE = 0.012;
// Hard speed limits (fraction/second). Even when the floor leaps — loading the
// page mid-generation lands straight on `sheet` (0.82) — the bar BUILDS toward
// it instead of snapping there. The wait at ~80% is long anyway; spend it
// climbing so the forge reads as continuously working.
const CLIMB_RATE = 0.045;
const FINISH_RATE = 0.12;

export function useWeaveProgress(phase: DmPhase | undefined, status: string | undefined, complete: boolean) {
  const [progress, setProgress] = useState(0.02);
  const [milestone, setMilestone] = useState(0);
  const floorRef = useRef(0.02);
  const shownRef = useRef(0.02);
  const lastStatusRef = useRef<string | undefined>(undefined);

  // A phase signal ratchets the floor up to its milestone — never down, and
  // an undefined phase (retry gaps, stale sweeps) changes nothing at all.
  useEffect(() => {
    if (!phase) return;
    const target = MILESTONES[phase] ?? 0;
    if (target > floorRef.current) floorRef.current = target;
    const index = PHASE_ORDER.indexOf(phase === "integrate" ? "sheet" : phase);
    if (index >= 0) setMilestone((current) => Math.max(current, index));
  }, [phase]);

  // Any status change means the Weaver did something — nudge the floor.
  useEffect(() => {
    if (!status || status === lastStatusRef.current) return;
    lastStatusRef.current = status;
    floorRef.current = Math.min(CEILING - 0.02, floorRef.current + STATUS_NUDGE);
  }, [status]);

  useEffect(() => {
    if (complete) setMilestone(PHASE_ORDER.length - 1);
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      let shown = shownRef.current;
      if (complete) {
        const step = (1.002 - shown) * Math.min(1, dt * 2.4);
        shown = Math.min(1, shown + Math.min(step, FINISH_RATE * dt));
      } else {
        const ceiling = Math.min(CEILING, floorRef.current + HEADROOM);
        // Fast catch-up while below the floor, slow creep above it — but the
        // catch-up is rate-capped, so it ramps rather than leaps.
        const rate = shown < floorRef.current ? 1.5 : 0.14;
        const step = Math.max(0, ceiling - shown) * Math.min(1, dt * rate);
        shown += Math.min(step, CLIMB_RATE * dt);
      }
      if (shown - shownRef.current > 0.0004 || (complete && shown !== shownRef.current)) {
        shownRef.current = shown;
        setProgress(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [complete]);

  return { progress, milestone };
}
