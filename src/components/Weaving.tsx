"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import WorldForge from "@/components/three/WorldForge";
import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

/**
 * Full-screen interlude between the lobby and the living stage — and it is
 * ALL the Worldforge now. The campaign's world assembles live in 3D while the
 * ground inscription ring doubles as the progress sigil: a bright arc
 * inscribes it clockwise, a percent glyph rides its near edge, and the title
 * hangs in the sky — every readout lives inside the three.js scene. The only
 * DOM chrome left is the standing join summons (late heroes must be able to
 * scan a real QR code) and an invisible progressbar for screen readers.
 * Progress is monotonic (`useWeaveProgress` upstream), so the build only ever
 * advances.
 */
export default function Weaving({
  title,
  progress,
  complete = false,
  joinCode,
  theme = "none"
}: {
  title: string;
  /** 0..1, monotonic — from useWeaveProgress. */
  progress: number;
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

  const percent = complete ? Math.floor(progress * 100) : Math.min(99, Math.floor(progress * 100));

  return (
    <div className="weaving screen" data-music-theme={visual.key}>
      <WorldForge mode="weaving" progress={progress} theme={visual.key} title={title} />
      <div className="portal-veil weaving-veil" />
      <div className="weaving-scan" aria-hidden />

      {/* The scene carries every visible readout; this is for screen readers. */}
      <div
        className="sr-only"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Weaving ${title}`}
      >
        {percent}%
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
