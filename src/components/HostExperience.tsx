"use client";

import { useEffect, useMemo, useRef } from "react";
import { api, useCampaignPoll } from "@/lib/client/api";
import { bgmSetContext, bgmSetTheme, bgmStop } from "@/lib/client/audio";
import HostLobby from "@/components/HostLobby";
import HostStage from "@/components/HostStage";
import Weaving from "@/components/Weaving";
import MusicWidget from "@/components/MusicWidget";
import CosmosCanvas from "@/components/three/CosmosCanvas";

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

  if (!storyStarted) {
    return (
      <>
        <Weaving
          phase={campaign.dmPhase}
          status={campaign.dmStatus}
          title={campaign.isRandomized && !storyStarted ? "Breaking the seal…" : campaign.title}
          theme={musicTheme}
        />
        <MusicWidget />
      </>
    );
  }

  return (
    <>
      <HostStage campaign={campaign} onExit={onExit} theme={musicTheme} />
      <MusicWidget />
    </>
  );
}
