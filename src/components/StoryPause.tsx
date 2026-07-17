"use client";

import { themeVisual, ThemeKey } from "@/components/three/themeVisuals";

export type StoryPauseKind = "join" | "reconnect" | "depart";

/**
 * The gentle intermission: whenever the Weaver has to stop the tale to splice
 * a hero in (mid-game join), stitch one back (reconnect), or weave a lost
 * thread out (disconnect timeout), the stage dims under a plain spinner —
 * a deliberate breath, not a spectacle — until the timeline is whole again.
 */
export default function StoryPause({
  kind,
  detail,
  playerName,
  theme
}: {
  kind: StoryPauseKind;
  /** The live dmStatus line, shown small under the kicker. */
  detail?: string;
  playerName?: string;
  theme?: ThemeKey | string | null;
}) {
  const visual = themeVisual(theme);
  const kicker =
    kind === "reconnect" ? visual.copy.reconnect : kind === "depart" ? visual.copy.depart : visual.copy.join;

  return (
    <div className="story-pause" role="status" data-music-theme={visual.key}>
      <div className="story-pause-center">
        <span className="forge-circle" aria-hidden />
        <span className="story-pause-kicker">{kicker}</span>
        {playerName ? <span className="story-pause-name">{playerName}</span> : null}
        <p className="story-pause-detail">{detail || visual.copy.joinGathering}</p>
        <span className="story-pause-hint">The tale is paused while the threads are rewoven</span>
      </div>
    </div>
  );
}
