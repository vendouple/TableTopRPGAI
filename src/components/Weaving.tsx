"use client";

import type { DmPhase } from "@/lib/campaign/types";
import WeavingLoom from "@/components/three/WeavingLoom";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

const PHASES: Array<{ key: DmPhase; label: string }> = [
  { key: "signal", label: "Reaching the Weaver" },
  { key: "world", label: "Writing the world" },
  { key: "scene", label: "Composing the opening" },
  { key: "image", label: "Painting the vista" },
  { key: "sheet", label: "Forging the heroes" },
  { key: "live", label: "Lighting the stage" }
];

/**
 * Full-screen interlude between the lobby and the living stage — and the
 * same loom that spins up whenever a hero joins mid-saga or a lost thread
 * reconnects (`mode`). A world is woven live in 3D in the campaign theme's
 * palette and glyphs; the constellation of phases lights up in lockstep with
 * what the server is actually doing (dmPhase), and the loom pulses with the
 * weaving score.
 */
export default function Weaving({
  phase,
  status,
  title,
  theme = "none",
  mode = "opening"
}: {
  phase?: DmPhase;
  status?: string;
  title: string;
  theme?: ThemeKey | string | null;
  mode?: "opening" | "join" | "reconnect";
}) {
  const visual = themeVisual(theme);
  const activeIndex = Math.max(0, PHASES.findIndex((item) => item.key === (phase === "integrate" ? "sheet" : phase)));
  const progress = (activeIndex + 1) / PHASES.length;

  const kicker =
    mode === "join" ? visual.copy.join : mode === "reconnect" ? visual.copy.reconnect : visual.copy.kicker;
  const idleLine = mode === "opening" ? visual.copy.gathering : visual.copy.joinGathering;

  return (
    <div className="weaving screen" data-music-theme={visual.key}>
      <WeavingLoom progress={mode === "opening" ? progress : 0.75} theme={visual.key} />
      <div className="portal-veil weaving-veil" />
      <div className="weaving-center">
        <span className="weaving-kicker">{kicker}</span>
        <h1 className="weaving-title">{title}</h1>
        {mode === "opening" ? (
          <div className="weaving-constellation">
            {PHASES.map((item, index) => (
              <div key={item.key} className={`weave-node ${index < activeIndex ? "done" : index === activeIndex ? "active" : ""}`}>
                <span className="weave-star" aria-hidden />
                <span className="weave-label">{item.label}</span>
                {index < PHASES.length - 1 ? <span className="weave-thread" aria-hidden /> : null}
              </div>
            ))}
          </div>
        ) : null}
        <p className="weaving-status">{status || idleLine}</p>
      </div>
    </div>
  );
}
