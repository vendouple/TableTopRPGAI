import { NextResponse } from "next/server";
import { getCampaign, getCampaignLock, saveCampaign, safePushDisplayEvent, ensureLocations, getFocusedLocation, getPlayerLocation, reconcilePresence, playerLastSeen } from "@/lib/campaign/store";
import { runDungeonMaster, repaintBackdrop, resolveExplorationRound, advanceCombatAndRunEnemies, serverLog, serverError } from "@/lib/aqua/chat";
import { turnMode, deadlinePassed, syncFocusedMirror } from "@/lib/campaign/turns";

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
          "1. Call generate_image for the opening background, and call update_location to seed the opening scene's objects, cover, exits, hazards, and a few useful narrative zones.",
          "2. Call write_campaign_file for quest_log.md with only the first active objective and immediate tasks, and write_campaign_file for storyline.md with your private arc (chapters, intended ending, 'Current: Chapter 1').",
          "3. If no ending/goal exists, decide hidden high-level win/loss conditions in storyline.md but do not put them in quest_log.md.",
          "4. Initialize every joined player with inventory, abilities, status/notes, stats, and phone actions (via update_campaign_state playerUpdates).",
          "5. Add any starting NPCs in npcUpdates. If a new NPC appears, call generate_image for their portrait first.",
          "6. Call set_ambience for the opening scene's mood" + (campaign.musicTheme ? "." : ", and call set_theme ONCE with the campaign's genre score."),
          "7. END by calling narrate_turn EXACTLY ONCE with the opening story beats, title, currentScene, overview, playerActions, and partyActions. Do not write prose or JSON outside of narrate_turn.",
          campaign.isRandomized ? "Surprise campaign: invent a creative campaign title and pass it as narrate_turn's title." : "",
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

      if (action === "nudge") {
        serverLog("API party", `Nudge (repaint backdrop) for campaign: ${campaignId}`);
        const before = await getCampaign(campaignId);
        if (before.status !== "active") {
          return NextResponse.json({ error: "Can only nudge an active campaign" }, { status: 400 });
        }
        // Pure visual refresh: the scene-director reuses a fitting past backdrop
        // or paints a fresh one. No story turn, so pending choices are untouched.
        const campaign = await repaintBackdrop(campaignId, { force: true });
        return NextResponse.json({ campaign });
      }

      if (action === "resolveRound") {
        // Force-resolve the FOCUSED location's exploration round with whoever
        // locked in. Triggered by the party leader ("go now") or the host as a
        // deadline backstop. `auto` = deadline-driven only, to avoid racing.
        const campaign = await getCampaign(campaignId);
        ensureLocations(campaign);
        const loc = getFocusedLocation(campaign);
        if (campaign.status !== "active" || turnMode(loc) !== "exploration") {
          return NextResponse.json({ campaign });
        }
        const pendingCount = Object.keys(loc.pendingActions || {}).length;
        if (!pendingCount) return NextResponse.json({ campaign });
        if (body.auto && !deadlinePassed(loc)) return NextResponse.json({ campaign });
        serverLog("API party", `Resolving exploration round for ${campaignId}/${loc.id} (${pendingCount} locked in, auto=${!!body.auto})`);
        const resolved = await resolveExplorationRound(campaignId, loc.id);
        return NextResponse.json({ campaign: resolved });
      }

      if (action === "skipTurn") {
        // Advance the FOCUSED location's combat past an idle/absent active player.
        const campaign = await getCampaign(campaignId);
        ensureLocations(campaign);
        const loc = getFocusedLocation(campaign);
        if (campaign.status !== "active" || turnMode(loc) !== "combat") {
          return NextResponse.json({ campaign });
        }
        if (body.auto && !deadlinePassed(loc)) return NextResponse.json({ campaign });
        const activeId = loc.turnState?.activeId;
        const actor = campaign.players.find((p) => p.id === activeId);
        if (actor) {
          safePushDisplayEvent(campaign, {
            type: "system",
            speaker: "SYSTEM",
            content: `${actor.characterName || actor.name} hesitates — the moment slips past.`
          });
          await saveCampaign(campaign);
        }
        serverLog("API party", `Skipping combat turn for ${campaignId}/${loc.id} (active=${activeId}, auto=${!!body.auto})`);
        const fresh = await advanceCombatAndRunEnemies(campaignId, loc.id);
        return NextResponse.json({ campaign: fresh });
      }

      if (action === "leave") {
        const campaign = await getCampaign(campaignId);
        ensureLocations(campaign);
        const pid = String(body.playerId || "");
        const player = campaign.players.find((p) => p.id === pid);
        if (!player) return NextResponse.json({ campaign });
        player.away = true;
        safePushDisplayEvent(campaign, {
          type: "system",
          speaker: "SYSTEM",
          content: `${player.characterName || player.name} steps away from the table.`
        });
        const loc = getPlayerLocation(campaign, pid);
        // Clear any pending lock-in so they don't hold up their location's round.
        if (loc.pendingActions) delete loc.pendingActions[pid];
        syncFocusedMirror(campaign);
        await saveCampaign(campaign);
        // If it was their combat turn, pass initiative on in that location.
        if (turnMode(loc) === "combat" && loc.turnState?.activeId === pid) {
          const fresh = await advanceCombatAndRunEnemies(campaignId, loc.id);
          return NextResponse.json({ campaign: fresh });
        }
        return NextResponse.json({ campaign });
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

      if (action === "resetTurn") {
        // Host-triggered recovery for a stuck turn (item #1): force-clear
        // dmStatus/dmPhase and restore whatever choices were on the table
        // before the stuck turn, without waiting for the stale-status timeout.
        // Use when a DM call is abandoned mid-retry (server restart, crashed
        // process) and the table is frozen with a permanent "weaving" lock.
        const campaign = await getCampaign(campaignId);
        if (!campaign.dmStatus) return NextResponse.json({ campaign });
        serverLog("API party", `Host force-reset a stuck turn for campaign: ${campaignId}`);
        campaign.dmStatus = undefined;
        campaign.dmPhase = undefined;
        safePushDisplayEvent(campaign, {
          type: "system",
          speaker: "SYSTEM",
          content: "The host reset a stalled turn — the table is unstuck."
        });
        await saveCampaign(campaign);
        return NextResponse.json({ campaign });
      }

      if (action === "sweepPresence") {
        // TV-driven presence backstop. Presence normally reconciles only when
        // someone acts, so a quiet table never notices a vanished phone. The
        // host sweeps every few seconds: flip timed-out players away, note the
        // transitions in the chronicle, and — one hero per sweep, never while
        // another turn runs — weave a departure out of (or a woven-out
        // returner back into) the story as a background DM turn. The pause
        // spinner on the TV keys off the dmStatus these turns set.
        const campaign = await getCampaign(campaignId);
        if (campaign.status !== "active") return NextResponse.json({ campaign });
        const storyStarted = campaign.displayEvents.some((e) => e.type === "narration" || e.type === "dialogue");
        const presence = reconcilePresence(campaign);
        for (const id of presence.wentAway) {
          const p = campaign.players.find((x) => x.id === id);
          if (p) safePushDisplayEvent(campaign, { type: "system", speaker: "SYSTEM", content: `${p.characterName || p.name} slips from the weave — disconnected.` });
        }
        for (const id of presence.returned) {
          const p = campaign.players.find((x) => x.id === id);
          if (p) safePushDisplayEvent(campaign, { type: "system", speaker: "SYSTEM", content: `${p.characterName || p.name} returns to the table.` });
        }

        const canWeave = storyStarted && !campaign.dmStatus;
        // A return weave needs a LIVE heartbeat, not presence's never-seen
        // grace — after a server restart every phone reads "present" for one
        // beat, and weaving a still-absent hero back in would be a lie.
        const beating = (playerId: string) => {
          const seen = playerLastSeen(campaignId, playerId);
          return seen !== undefined && Date.now() - seen < 15000;
        };
        const returning = canWeave ? campaign.players.find((p) => !p.away && p.wovenOut && beating(p.id)) : undefined;
        const departed = !returning && canWeave ? campaign.players.find((p) => p.away && !p.wovenOut) : undefined;
        if (returning) returning.wovenOut = false;
        if (departed) departed.wovenOut = true;
        if (presence.wentAway.length || presence.returned.length || returning || departed) {
          await saveCampaign(campaign);
        }

        const weaveMessage = returning
          ? [
              `Player ${returning.characterName || returning.name} has rejoined the game after being disconnected!`,
              "Do these steps in order:",
              "1. Briefly weave their return into the current scene.",
              "2. Set their status to Active or Ready.",
              "3. Provide fresh playerActions for them and other active players.",
              "4. Reuse the current background unless a new image is clearly needed."
            ].join("\n")
          : departed
            ? [
                `Player ${departed.name} has disconnected from the game and timed out.`,
                `Their character${departed.characterName ? `, ${departed.characterName},` : ""} must gracefully exit the story for now.`,
                "Do these steps in order:",
                "1. Briefly weave their departure into the current scene (one or two in-world beats — no meta talk about phones or connections).",
                "2. Park the character somewhere safe and recoverable. Do NOT kill them or strip their items; they may return.",
                "3. Keep playerActions fresh for the remaining active players; give none to the departed hero.",
                "4. Reuse the current background image."
              ].join("\n")
            : null;

        if (weaveMessage) {
          const hero = (returning || departed)!;
          const isReturn = !!returning;
          safeRelease();
          (async () => {
            const bgRelease = await getCampaignLock(campaignId).acquire();
            try {
              // The world may have moved while we waited on the lock: the
              // hero may be back (or gone again), or another turn may be
              // running. Re-check and, when skipping, revert the flag so a
              // later sweep retries instead of losing the weave forever.
              const fresh = await getCampaign(campaignId);
              const live = fresh.players.find((p) => p.id === hero.id);
              if (!live) return;
              const stateFlipped = isReturn ? !!live.away : !live.away;
              if (stateFlipped || fresh.dmStatus) {
                live.wovenOut = isReturn;
                await saveCampaign(fresh);
                return;
              }
              serverLog("API party background", `Weaving ${isReturn ? "return" : "departure"} for ${hero.name} in campaign: ${campaignId}`);
              await runDungeonMaster(campaignId, "SYSTEM", weaveMessage, { hiddenUserMessage: true });
            } catch (err) {
              serverError("API party background", `Failed to weave ${isReturn ? "return" : "departure"} for ${hero.name}`, err);
            } finally {
              bgRelease();
            }
          })();
        }
        return NextResponse.json({ campaign });
      }

      if (action === "presenting") {
        // Lightweight playback-progress broadcast from the TV: no DM turn, no
        // saveCampaign lock contention beyond the usual mutex. Lets controllers
        // stay locked until the TV actually finishes typing/holding this turn's
        // beats (not just until the server finished generating them).
        const campaign = await getCampaign(campaignId);
        campaign.presenting = { active: !!body.active, updatedAt: Date.now() };
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
