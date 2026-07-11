"use client";

import { useEffect, useMemo } from "react";
import { useCampaignPoll } from "@/lib/client/api";
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
    else if (!storyStarted) bgmSetContext("weaving");
    else bgmSetContext(mood || "calm");
  }, [status, storyStarted, mood]);
  useEffect(() => () => bgmStop(), []);

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
