import { NextResponse } from "next/server";
import { getCampaign, getCampaignLock, saveCampaign } from "@/lib/campaign/store";
import { runDungeonMaster, serverLog, serverError } from "@/lib/aqua/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let campaignId = "";
  let action = "";
  try {
    const body = await request.json().catch(() => ({}));
    campaignId = String(body.campaignId || "");
    action = String(body.action || "");
    serverLog("API party", `Incoming POST request | Campaign: ${campaignId} | Action: ${action}`);
    if (!campaignId || !action) return NextResponse.json({ error: "campaignId and action are required" }, { status: 400 });

    let isReleased = false;
    const release = await getCampaignLock(campaignId).acquire();
    const safeRelease = () => {
      if (!isReleased) {
        isReleased = true;
        release();
      }
    };

    try {
      if (action === "start") {
        const campaign = await getCampaign(campaignId);
        const playerId = String(body.playerId || "");
        if (campaign.partyLeaderId && campaign.partyLeaderId !== playerId) return NextResponse.json({ error: "Only the party leader can start the game" }, { status: 403 });
        
        // Duplicate start guard: if campaign is already active, return immediately
        if (campaign.status === "active") {
          serverLog("API party", `Campaign ${campaignId} is already active, skipping start initialization.`);
          return NextResponse.json({ campaign });
        }

        campaign.status = "active";
        campaign.overview = "The Dungeon Master is preparing the opening scene...";
        campaign.currentScene = "A quiet chamber where legends begin. The air is thick with anticipation.";
        await saveCampaign(campaign);

        const opener = [
          "Start the couch campaign now.",
          campaign.campaignType === "dnd"
            ? `Campaign type: Dungeons & Dragons (${campaign.rulesMode === "full" ? "full 5e rules" : "rules-light D&D"}).`
            : "Campaign type: standard tabletop RPG, not D&D. Preserve the setup's genre and do not add fantasy/D&D assumptions unless already present.",
          "Do these steps in order:",
          "1. Call generate_image for the opening background.",
          "2. Call write_campaign_file for quest_log.md with only the first active objective and immediate tasks.",
          "3. If no ending/goal exists, decide hidden high-level win/loss conditions for continuity but do not put them in quest_log.md.",
          "4. Initialize every joined player with inventory, abilities, status/notes, stats, and phone actions.",
          "5. Add any starting NPCs in npcUpdates. If a new NPC appears, call generate_image for their portrait first.",
          "6. Return JSON with title, currentScene, overview, opening story, playerActions, and partyActions.",
          campaign.isRandomized ? "Surprise campaign: choose a creative campaign title and set title." : "",
          campaign.startingStory.trim() ? `Starting background story to adapt: ${campaign.startingStory}` : "No starting story was provided; adapt the joined player backgrounds into an opening scene."
        ].filter(Boolean).join("\n");

        // Release the HTTP request thread lock
        safeRelease();

        // Run campaign start narrative and image generation in the background
        (async () => {
          const bgRelease = await getCampaignLock(campaignId).acquire();
          try {
            serverLog("API party background", `Starting campaign setup narrative in background for campaign: ${campaignId}`);
            await runDungeonMaster(campaignId, "Party Leader", opener, { hiddenUserMessage: true });
            serverLog("API party background", `Campaign setup narrative completed successfully in background for campaign: ${campaignId}`);
          } catch (err) {
            serverError("API party background", `Failed to complete campaign setup narrative in background for campaign: ${campaignId}`, err);
          } finally {
            bgRelease();
          }
        })();

        return NextResponse.json({ campaign });
      }

      if (action === "sway") {
        const guidance = String(body.guidance || "").trim();
        if (!guidance) return NextResponse.json({ error: "guidance is required" }, { status: 400 });
        serverLog("API party", `Swaying campaign: ${campaignId} | Guidance: "${guidance}"`);
        const result = await runDungeonMaster(campaignId, "Game Master", `Game Master guidance: ${guidance}`, { hiddenUserMessage: true });
        return NextResponse.json(result);
      }

      if (action === "editMessage") {
        const campaign = await getCampaign(campaignId);
        const messageId = String(body.messageId || "");
        const content = String(body.content || "");
        serverLog("API party", `Editing assistant message: ${messageId} in campaign: ${campaignId}`);
        const message = campaign.messages.find((item) => item.id === messageId && item.role === "assistant");
        if (!message) return NextResponse.json({ error: "Assistant message not found" }, { status: 404 });
        message.content = content;
        await saveCampaign(campaign);
        return NextResponse.json({ campaign });
      }

      if (action === "editEvent") {
        const campaign = await getCampaign(campaignId);
        const eventId = String(body.eventId || "");
        const newContent = String(body.content || "");
        serverLog("API party", `Editing event: ${eventId} in campaign: ${campaignId}`);
        const event = campaign.displayEvents.find((e) => e.id === eventId);
        if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
        
        const oldContent = event.content || "";
        event.content = newContent;

        // Sync with assistant messages
        for (let i = campaign.messages.length - 1; i >= 0; i--) {
          const msg = campaign.messages[i];
          if (msg.role === "assistant") {
            try {
              const startIdx = msg.content.indexOf("{");
              const endIdx = msg.content.lastIndexOf("}");
              if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                const jsonStr = msg.content.substring(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonStr);
                let updated = false;
                if (parsed && Array.isArray(parsed.story)) {
                  for (const segment of parsed.story) {
                    if (segment && segment.content === oldContent && (!event.speaker || segment.speaker === event.speaker)) {
                      segment.content = newContent;
                      updated = true;
                    }
                  }
                }
                if (updated) {
                  msg.content = msg.content.substring(0, startIdx) + JSON.stringify(parsed) + msg.content.substring(endIdx + 1);
                  break;
                }
              }
            } catch (err) {
              // ignore
            }

            if (msg.content.trim() === oldContent.trim()) {
              msg.content = newContent;
              break;
            }
          }
        }

        await saveCampaign(campaign);
        return NextResponse.json({ campaign });
      }

      if (action === "setBackground") {
        const campaign = await getCampaign(campaignId);
        const url = String(body.url || "").trim();
        if (!url || !campaign.images.some((img) => img.url === url)) {
          return NextResponse.json({ error: "Unknown background url" }, { status: 400 });
        }
        campaign.currentImageUrl = url;
        await saveCampaign(campaign);
        return NextResponse.json({ campaign });
      }

      if (action === "updateSettings") {
        const campaign = await getCampaign(campaignId);
        serverLog("API party", `Updating settings for campaign: ${campaignId}`);
        if (body.showQuestOnTV !== undefined) campaign.showQuestOnTV = !!body.showQuestOnTV;
        if (body.showQuestOnController !== undefined) campaign.showQuestOnController = !!body.showQuestOnController;
        if (body.showPartyInventories !== undefined) campaign.showPartyInventories = !!body.showPartyInventories;
        if (body.showPartyAbilities !== undefined) campaign.showPartyAbilities = !!body.showPartyAbilities;
        if (body.showNpcInventories !== undefined) campaign.showNpcInventories = !!body.showNpcInventories;
        if (body.showNpcAbilities !== undefined) campaign.showNpcAbilities = !!body.showNpcAbilities;
        await saveCampaign(campaign);
        return NextResponse.json({ campaign });
      }

      return NextResponse.json({ error: "Unknown party action" }, { status: 400 });
    } finally {
      safeRelease();
    }
  } catch (error) {
    serverError("API party", `Error processing party action '${action}' for campaign: ${campaignId}`, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown party error" }, { status: 500 });
  }
}
