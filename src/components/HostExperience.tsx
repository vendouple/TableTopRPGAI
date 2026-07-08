"use client";

import { useMemo } from "react";
import { useCampaignPoll } from "@/lib/client/api";
import HostLobby from "@/components/HostLobby";
import HostStage from "@/components/HostStage";
import Weaving from "@/components/Weaving";
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
    return <HostLobby campaign={campaign} />;
  }

  if (!storyStarted) {
    return (
      <Weaving
        phase={campaign.dmPhase}
        status={campaign.dmStatus}
        title={campaign.isRandomized && !storyStarted ? "Breaking the seal…" : campaign.title}
      />
    );
  }

  return <HostStage campaign={campaign} onExit={onExit} />;
}
