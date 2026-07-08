"use client";

import type { DmPhase } from "@/lib/campaign/types";
import CosmosCanvas from "@/components/three/CosmosCanvas";

const PHASES: Array<{ key: DmPhase; label: string }> = [
  { key: "signal", label: "Reaching the Weaver" },
  { key: "world", label: "Writing the world" },
  { key: "scene", label: "Composing the opening" },
  { key: "image", label: "Painting the vista" },
  { key: "sheet", label: "Forging the heroes" },
  { key: "live", label: "Lighting the stage" }
];

/**
 * Full-screen interlude between the lobby and the living stage. The dice
 * cosmos churns at high drama while a constellation of phases lights up in
 * lockstep with what the server is actually doing (dmPhase).
 */
export default function Weaving({ phase, status, title }: { phase?: DmPhase; status?: string; title: string }) {
  const activeIndex = Math.max(0, PHASES.findIndex((item) => item.key === (phase === "integrate" ? "sheet" : phase)));

  return (
    <div className="weaving screen">
      <CosmosCanvas drama={1} />
      <div className="portal-veil deep" />
      <div className="weaving-center">
        <span className="weaving-kicker">The Weaving begins</span>
        <h1 className="weaving-title">{title}</h1>
        <div className="weaving-constellation">
          {PHASES.map((item, index) => (
            <div key={item.key} className={`weave-node ${index < activeIndex ? "done" : index === activeIndex ? "active" : ""}`}>
              <span className="weave-star" aria-hidden />
              <span className="weave-label">{item.label}</span>
              {index < PHASES.length - 1 ? <span className="weave-thread" aria-hidden /> : null}
            </div>
          ))}
        </div>
        <p className="weaving-status">{status || "The threads are gathering…"}</p>
      </div>
    </div>
  );
}
