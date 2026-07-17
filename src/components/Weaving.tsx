"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import WorldForge from "@/components/three/WorldForge";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

const PHASES: Array<{ label: string }> = [
  { label: "Reaching the Weaver" },
  { label: "Writing the world" },
  { label: "Composing the opening" },
  { label: "Painting the vista" },
  { label: "Forging the heroes" },
  { label: "Lighting the stage" }
];

/** Forge-stage word for the HUD, by progress quartile. */
function forgeStage(progress: number, complete: boolean) {
  if (complete) return "The world holds";
  if (progress < 0.25) return "Gathering the threads";
  if (progress < 0.5) return "Weaving the fabric";
  if (progress < 0.78) return "Raising the world";
  return "Stabilizing the tale";
}

/**
 * Full-screen interlude between the lobby and the living stage. The Worldforge
 * assembles the campaign's world live in 3D — scattered wireframe fragments
 * tractor in, lock, and materialize — driven by a monotonic progress model
 * (`useWeaveProgress` upstream) so the bar and the build only ever advance.
 * The join summons stays on screen so late heroes can scan in mid-weave; the
 * server seats them the moment the opening is done.
 */
export default function Weaving({
  title,
  status,
  progress,
  milestone,
  complete = false,
  joinCode,
  theme = "none"
}: {
  title: string;
  status?: string;
  /** 0..1, monotonic — from useWeaveProgress. */
  progress: number;
  /** Highest constellation node reached (index into PHASES). */
  milestone: number;
  /** True once the opening is woven: the forge finishes and flares. */
  complete?: boolean;
  joinCode?: string;
  theme?: ThemeKey | string | null;
}) {
  const visual = themeVisual(theme);
  const [joinUrl, setJoinUrl] = useState("");

  useEffect(() => {
    if (!joinCode) return;
    setJoinUrl(`${window.location.origin}/?controller=1&code=${joinCode}`);
  }, [joinCode]);

  const percent = complete ? 100 : Math.min(99, Math.floor(progress * 100));
  const activeIndex = complete ? PHASES.length : milestone;

  return (
    <div className="weaving screen" data-music-theme={visual.key}>
      <WorldForge mode="weaving" progress={complete ? 1 : progress} theme={visual.key} />
      <div className="portal-veil weaving-veil" />
      <div className="weaving-scan" aria-hidden />

      <header className="weaving-hud" aria-hidden>
        <span className="weaving-hud-label">{visual.copy.kicker}</span>
        <span className="weaving-hud-stage">{forgeStage(progress, complete)}</span>
      </header>

      <div className="weaving-center">
        <span className="weaving-kicker">{visual.copy.kicker}</span>
        <h1 className={`weaving-title ${complete ? "forged" : ""}`}>{title}</h1>

        <div className="weaving-constellation">
          {PHASES.map((item, index) => (
            <div
              key={item.label}
              className={`weave-node ${index < activeIndex ? "done" : index === activeIndex ? "active" : ""}`}
            >
              <span className="weave-star" aria-hidden />
              <span className="weave-label">{item.label}</span>
              {index < PHASES.length - 1 ? <span className="weave-thread" aria-hidden /> : null}
            </div>
          ))}
        </div>

        <div className="weaving-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="weaving-progress-track">
            <div className="weaving-progress-fill" style={{ width: `${complete ? 100 : progress * 100}%` }} />
          </div>
          <span className="weaving-percent">{percent}%</span>
        </div>

        <p className="weaving-status">{complete ? visual.copy.kicker : status || visual.copy.gathering}</p>
      </div>

      {joinCode ? (
        <aside className="weaving-summons panel">
          <span className="summons-label">Late to the table?</span>
          <div className="weaving-summons-row">
            {joinUrl ? (
              <div className="join-qr small">
                <QRCodeSVG value={joinUrl} size={84} bgColor="transparent" fgColor={visual.accentBright} level="M" />
              </div>
            ) : null}
            <div className="weaving-summons-code">
              <span className="join-code compact" aria-label={`Join code ${joinCode}`}>
                {joinCode.split("").map((char, index) => (
                  <span key={index} className="join-code-glyph small" style={{ animationDelay: `${index * 0.12}s` }}>{char}</span>
                ))}
              </span>
              <span className="join-hint">Scan or enter the code — you&apos;ll be seated the moment the world is ready.</span>
            </div>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
