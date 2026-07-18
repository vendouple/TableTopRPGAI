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
 *
 * `active` gates the whole model to the weave itself. The hook is mounted for
 * the campaign's entire life, and the LOBBY already emits weave-shaped
 * signals: every join forges a portrait with dmPhase "sheet" (the 82%
 * milestone) and a churn of dmStatus updates. Left ungated, a few minutes of
 * lobby ratchets the floor to 0.82 and creeps the shown value to ~91% before
 * the weave even begins — the "starts at 90%" bug. While inactive nothing
 * ratchets, nudges, or ticks; on the lobby→weave flip everything resets to 0
 * and the signals present at that instant are swallowed (only *changes* after
 * activation count). A fresh mount that is already active (TV reload
 * mid-weave) accepts the current phase immediately — the rate-capped climb is
 * the designed behavior there.
 *
 * On `complete`, the finish climb to 100% is NOT a fixed sprint. A fixed rate
 * either looks like a sudden rush (opening was slow, the tail is instant) or
 * — the actual bug reported — gets cut off mid-flight: the host's finale
 * window used to be a fixed wall-clock guess, and if the bar was still at say
 * 57% when the turn actually finished, a fast fixed rate could still fail to
 * land 100% before that window closed, and the screen would cut straight to
 * the live stage with the bar (and its ritual/shockwave) never finishing —
 * "skips the rest". Two changes fix this together:
 *  - the finish rate is now derived from this climb's own AGGREGATE pace
 *    (total progress gained ÷ total time spent climbing) — so if the climb
 *    ran slow, the close-out reads as a continuation of that same pace
 *    instead of snapping fast; if the climb happened to run fast, the
 *    close-out doesn't linger either. Bounded to a sane duration window
 *    (FINISH_SECONDS_MIN..MAX) so an unusually short or long climb still
 *    resolves at a reasonable, watchable speed rather than an average that's
 *    instant or glacial.
 *  - the host no longer times the finale off a fixed constant at all — it
 *    waits for `progress` to actually reach ~100% before cutting away (see
 *    HostExperience). This hook only owns the pacing; the caller owns not
 *    cutting it off early.
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

const CEILING = 0.955;
const HEADROOM = 0.09;
const STATUS_NUDGE = 0.012;
// Hard speed limit (fraction/second) on the shown value's ascent — independent
// of how big the gap to the floor is. 0.013 means closing an 0.8 gap (cold
// start to "sheet") takes ~60s of real, watchable counting, matching how long
// that stretch actually runs — instead of the floor's near-instant jump.
const CLIMB_RATE = 0.013;
const NEAR_CEILING_RATE = 0.05;
// Bounds on the finish close-out's total duration (seconds), regardless of
// what the aggregate pace works out to — see the doc comment above.
const FINISH_SECONDS_MIN = 1.3;
const FINISH_SECONDS_MAX = 5.5;
const FINISH_RATE_DEFAULT = 0.16;

export function useWeaveProgress(active: boolean, phase: DmPhase | undefined, status: string | undefined, complete: boolean) {
  const [progress, setProgress] = useState(0);
  const floorRef = useRef(0);
  const shownRef = useRef(0);
  const paintedRef = useRef(0);
  const lastStatusRef = useRef<string | undefined>(undefined);
  const activeRef = useRef(active);
  const stalePhaseRef = useRef<DmPhase | undefined>(undefined);
  // Aggregate pacing for the finish close-out (see doc comment above).
  const elapsedClimbRef = useRef(0);
  const finishRateRef = useRef(FINISH_RATE_DEFAULT);
  const finishCapturedRef = useRef(false);

  // Activation edge (lobby → weave): wipe anything the lobby accumulated and
  // swallow the phase/status lingering at the flip. Declared FIRST so it runs
  // before the ratchet effects below on the same commit.
  useEffect(() => {
    if (active && !activeRef.current) {
      floorRef.current = 0;
      shownRef.current = 0;
      paintedRef.current = 0;
      elapsedClimbRef.current = 0;
      finishCapturedRef.current = false;
      finishRateRef.current = FINISH_RATE_DEFAULT;
      setProgress(0);
      lastStatusRef.current = status;
      stalePhaseRef.current = phase;
    }
    activeRef.current = active;
  }, [active, phase, status]);

  // A phase signal ratchets the floor up to its milestone — never down, and
  // an undefined phase (retry gaps, stale sweeps) changes nothing at all.
  useEffect(() => {
    if (!active || !phase) return;
    if (stalePhaseRef.current) {
      if (phase === stalePhaseRef.current) return;
      stalePhaseRef.current = undefined;
    }
    const target = MILESTONES[phase] ?? 0;
    if (target > floorRef.current) floorRef.current = target;
  }, [active, phase]);

  // Any status change means the Weaver did something — nudge the floor.
  useEffect(() => {
    if (!active || !status || status === lastStatusRef.current) return;
    lastStatusRef.current = status;
    floorRef.current = Math.min(CEILING - 0.02, floorRef.current + STATUS_NUDGE);
  }, [active, status]);

  useEffect(() => {
    if (!active && !complete) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      let shown = shownRef.current;
      if (complete) {
        // Capture the aggregate pace exactly once, the instant completion is
        // seen: total progress this climb made ÷ total time it took. That
        // average becomes the close-out's rate, bounded to a sane duration —
        // a climb that ran slow finishes at roughly that same felt speed
        // instead of suddenly sprinting; one that ran fast doesn't linger.
        if (!finishCapturedRef.current) {
          finishCapturedRef.current = true;
          const elapsed = Math.max(0.4, elapsedClimbRef.current);
          const avgPace = shown > 0.001 ? shown / elapsed : CLIMB_RATE;
          const gap = Math.max(0.001, 1.002 - shown);
          const idealSeconds = gap / Math.max(0.0005, avgPace);
          const seconds = Math.min(FINISH_SECONDS_MAX, Math.max(FINISH_SECONDS_MIN, idealSeconds));
          finishRateRef.current = gap / seconds;
        }
        const step = (1.002 - shown) * Math.min(1, dt * 2.4);
        shown = Math.min(1, shown + Math.min(step, finishRateRef.current * dt));
      } else {
        elapsedClimbRef.current += dt;
        finishCapturedRef.current = false;
        const ceiling = Math.min(CEILING, floorRef.current + HEADROOM);
        // Fast catch-up while below the floor, slow creep above it — but the
        // catch-up is rate-capped, so it ramps rather than leaps.
        const rate = shown < floorRef.current ? 1.5 : NEAR_CEILING_RATE;
        const step = Math.max(0, ceiling - shown) * Math.min(1, dt * rate);
        shown += Math.min(step, CLIMB_RATE * dt);
      }
      // ALWAYS bank the accumulated value — the per-frame increment is tiny
      // (CLIMB_RATE / 60 ≈ 0.0002), so gating the ref on a visible delta is
      // what froze the bar at 1%. Only the React repaint is throttled.
      shownRef.current = shown;
      if (shown - paintedRef.current > 0.0005 || (complete && shown !== paintedRef.current)) {
        paintedRef.current = shown;
        setProgress(shown);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, complete]);

  return { progress };
}
