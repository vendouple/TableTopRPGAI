"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, useCampaignPoll, Campaign } from "@/lib/client/api";
import { bgmSetContext, bgmSetTheme, bgmStop } from "@/lib/client/audio";
import { useWeaveProgress } from "@/lib/client/weaveProgress";
import HostLobby from "@/components/HostLobby";
import HostStage from "@/components/HostStage";
import Weaving from "@/components/Weaving";
import StoryPause, { StoryPauseKind } from "@/components/StoryPause";
import MusicWidget from "@/components/MusicWidget";
import CosmosCanvas from "@/components/three/CosmosCanvas";

/** How long the forged world holds on screen before the stage takes over. */
const FINALE_MS = 3200;

type PauseInfo = { kind: StoryPauseKind; detail?: string; playerName?: string };

/** What the Weaver is splicing right now, if anything (mid-game only). */
function derivePause(campaign: Campaign, storyStarted: boolean): PauseInfo | null {
  if (campaign.status !== "active" || !storyStarted) return null;
  const status = campaign.dmStatus || "";
  if (/reintegrating/i.test(status)) return { kind: "reconnect", detail: status };
  if (/lost thread/i.test(status)) return { kind: "depart", detail: status };
  if (/integrating new player|forging character sheet/i.test(status)) {
    const forging = campaign.players.find((p) => (p.status || "").toLowerCase().includes("generating profile"));
    return { kind: "join", detail: status, playerName: forging?.characterName || forging?.name };
  }
  const forging = campaign.players.find((p) => (p.status || "").toLowerCase().includes("generating profile"));
  if (forging) return { kind: "join", playerName: forging.characterName || forging.name };
  return null;
}

/**
 * The TV's brain: polls the campaign as the host (heartbeat) and moves the
 * screen between the Gathering, the Weaving, and the living Stage.
 */
export default function HostExperience({ campaignId, onExit }: { campaignId: string; onExit: () => void }) {
  const { campaign, lost } = useCampaignPoll(campaignId, true);

  const storyStarted = useMemo(
    () => !!campaign?.displayEvents.some((event) => event.type === "narration" || event.type === "dialogue"),
    [campaign?.displayEvents]
  );

  // One bard for the whole host journey: lobby score → weaving score →
  // mood-matched stage score, crossfading at each transition.
  const mood = campaign?.ambience?.mood;
  const status = campaign?.status;
  // When the saga has ended, the outro score is tailored to HOW it ended
  // (victory vs defeat vs cliffhanger…) via BGM/outro-<kind>/<genre>/.
  const endingKind = campaign?.ending?.kind;
  // The campaign's genre theme (fantasy/scifi/modern/…) chosen at start; it
  // biases the score toward BGM/<mood>/<theme>/ shelves, falling back to the
  // neutral mood roots when that themed shelf is empty. D&D always reads as
  // fantasy even before the classifier has run.
  const musicTheme = campaign?.musicTheme || (campaign?.campaignType === "dnd" ? "fantasy" : null);
  useEffect(() => {
    bgmSetTheme(musicTheme);
  }, [musicTheme]);
  useEffect(() => {
    if (!status) return;
    if (status === "lobby") bgmSetContext("lobby");
    else if (status === "completed") bgmSetContext(endingKind ? `outro-${endingKind}` : "outro");
    else if (!storyStarted) bgmSetContext("weaving");
    else bgmSetContext(mood || "calm");
  }, [status, storyStarted, mood, endingKind]);
  useEffect(() => () => bgmStop(), []);

  // Turn deadline backstop (#1/#2): the TV is always present, so it nudges the
  // server when a round/turn stalls — resolving an exploration round with
  // whoever locked in, or skipping an idle/absent combatant. Fires at most once
  // per deadline; the server re-checks `auto` so eager clients don't race.
  const backstopRef = useRef<string | null>(null);
  useEffect(() => {
    if (!campaign || campaign.status !== "active" || campaign.dmStatus) return;
    const ts = campaign.turnState;
    if (!ts?.deadlineAt) return;
    if (Date.now() <= new Date(ts.deadlineAt).getTime()) return;
    if (backstopRef.current === ts.deadlineAt) return;
    backstopRef.current = ts.deadlineAt;
    const hasPending = !!campaign.pendingActions && Object.keys(campaign.pendingActions).length > 0;
    if (ts.mode === "exploration" && hasPending) {
      api.party({ campaignId: campaign.id, action: "resolveRound", auto: true }).catch(() => {});
    } else if (ts.mode === "combat") {
      api.party({ campaignId: campaign.id, action: "skipTurn", auto: true }).catch(() => {});
    }
  }, [campaign]);

  // Presence backstop: only the TV polls unconditionally, so it periodically
  // asks the server to reconcile who's still connected — flipping timed-out
  // players away and weaving their departure (or a woven-out player's return)
  // into the story as a background DM turn.
  const sweepRef = useRef(0);
  useEffect(() => {
    if (!campaign || campaign.status !== "active" || !storyStarted) return;
    const now = Date.now();
    if (now - sweepRef.current < 12000) return;
    sweepRef.current = now;
    api.party({ campaignId: campaign.id, action: "sweepPresence" }).catch(() => {});
  }, [campaign, storyStarted]);

  // The Weaving's monotonic progress — phases ratchet, status changes nudge,
  // and the bar never regresses no matter how the raw dmPhase jumps around.
  const weave = useWeaveProgress(campaign?.dmPhase, campaign?.dmStatus, storyStarted);

  // When the opening finishes, hold the forged world on screen for a beat —
  // the shockwave finale plays out — before handing over to the stage. On a
  // fresh mount of an already-running story, skip straight to the stage.
  const [finaleUntil, setFinaleUntil] = useState(0);
  const [, forceRender] = useState(0);
  const prevStoryStarted = useRef<boolean | null>(null);
  useEffect(() => {
    if (!campaign) return;
    const was = prevStoryStarted.current;
    prevStoryStarted.current = storyStarted;
    if (was === false && storyStarted && campaign.status === "active") {
      setFinaleUntil(Date.now() + FINALE_MS);
      const timer = setTimeout(() => forceRender((n) => n + 1), FINALE_MS + 50);
      return () => clearTimeout(timer);
    }
  }, [campaign, storyStarted]);

  // The mid-game intermission (join / reconnect / departure). Once shown it
  // lingers until the integration's beats actually land (or a grace timeout),
  // bridging the brief dmStatus gap between profile forge and splice-in.
  const pause = useMemo(() => (campaign ? derivePause(campaign, storyStarted) : null), [campaign, storyStarted]);
  const [visiblePause, setVisiblePause] = useState<PauseInfo | null>(null);
  const pauseEventsRef = useRef(0);
  useEffect(() => {
    const eventCount = campaign?.displayEvents.length ?? 0;
    if (pause) {
      setVisiblePause(pause);
      pauseEventsRef.current = eventCount;
      return;
    }
    if (!visiblePause) return;
    if (eventCount > pauseEventsRef.current) {
      setVisiblePause(null);
      return;
    }
    const timer = setTimeout(() => setVisiblePause(null), 4000);
    return () => clearTimeout(timer);
  }, [pause, campaign?.displayEvents.length, visiblePause]);

  if (!campaign) {
    return (
      <div className="screen loading-screen">
        <CosmosCanvas drama={0.5} />
        <div className="portal-veil" />
        <div className="loading-center">
          <span className="forge-circle" aria-hidden />
          <p>{lost ? "The table is unreachable — is the server still running?" : "Opening the saga…"}</p>
        </div>
      </div>
    );
  }

  if (campaign.status === "lobby") {
    return (
      <>
        <HostLobby campaign={campaign} theme={musicTheme} />
        <MusicWidget />
      </>
    );
  }

  const inFinale = storyStarted && Date.now() < finaleUntil;
  if (!storyStarted || inFinale) {
    return (
      <>
        <Weaving
          title={campaign.isRandomized && !storyStarted ? "Breaking the seal…" : campaign.title}
          status={campaign.dmStatus}
          progress={weave.progress}
          milestone={weave.milestone}
          complete={inFinale}
          joinCode={campaign.joinCode}
          theme={musicTheme}
        />
        <MusicWidget />
      </>
    );
  }

  return (
    <>
      <HostStage campaign={campaign} onExit={onExit} theme={musicTheme} />
      {visiblePause ? (
        <StoryPause kind={visiblePause.kind} detail={visiblePause.detail} playerName={visiblePause.playerName} theme={musicTheme} />
      ) : null}
      <MusicWidget />
    </>
  );
}
