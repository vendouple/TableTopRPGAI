import { buildCampaignContext } from "@/lib/campaign/context";
import { getCampaign, saveCampaign, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, startCampaignDraft, finishCampaignDraft } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { aquaConfig, aquaFetch, AquaMessage, AquaToolCall } from "./client";
import { runTool, toolDefinitions } from "@/lib/tools/registry";
import { PlayerStat } from "@/lib/campaign/types";

export function serverLog(category: string, message: string, data?: any) {
  const timestamp = new Date().toLocaleTimeString();
  const dataStr = data ? ` | ${typeof data === "object" ? JSON.stringify(data) : data}` : "";
  console.log(`\x1b[35m[DND SERVER]\x1b[0m [${timestamp}] \x1b[36m[${category}]\x1b[0m ${message}${dataStr}`);
}

export function serverError(category: string, message: string, error?: any) {
  const timestamp = new Date().toLocaleTimeString();
  const errorMsg = error instanceof Error ? error.stack : String(error || "");
  console.error(`\x1b[31m[DND ERROR]\x1b[0m [${timestamp}] \x1b[36m[${category}]\x1b[0m ${message}${errorMsg ? `\n${errorMsg}` : ""}`);
}

const systemPrompt = `You are the Dungeon Master for a couch RPG. TV shows cinematic story; phones are player controllers.

Prevent context collapse:
- Treat the current user/task message as the highest priority.
- Use campaign state as facts, not as text to imitate.
- Do not re-summarize old transcript unless it matters now.
- Keep each turn focused: resolve action, update state, offer choices.

Core rules:
- Never control player characters: do not choose their actions, speech, thoughts, or feelings.
- Narrate external consequences only. Player names/characters are protected canon.
- Use roll_dice for meaningful risk: attacks, persuasion, spell use, stealth, search, etc.

Dice rules:
- A d20 roll is the core check. Compare result to difficulty class (DC): Easy 10, Medium 15, Hard 20, Very Hard 25.
- When player's ability/class/item helps, use roll_dice with d20Mode "advantage". Advantage replaces flat bonuses.
- When hindered, use d20Mode "disadvantage".
- Otherwise, use d20Mode "normal".
- Only use +N/-N modifiers for genuine, explicit sheet stats/magical items. No arbitrary bonuses.

Continuity & assets:
- Track stats, inventory, abilities, NPCs, locations, quests.
- For new NPCs/monsters, call generate_image first, then save returned URL in portraitUrl.
- Maintain quest_log.md with ONLY the current active objective and immediate tasks.

Cinematic direction (you are also the stage director):
- Call set_ambience when the emotional register shifts (combat begins, a mystery deepens, the party reaches safety, a tragedy lands). One call per shift, not per turn.
- Call trigger_effect to punctuate big single beats: explosions (shake+flash), spellbursts (embers), horror stings (darkness/heartbeat), storms (rain/fog).
- Prefer atmosphere over words: a mood change plus one tight paragraph beats three paragraphs.

Speaker rules:
- story[].speaker is "NARRATOR", "SYSTEM", or an NPC name.
- Do not put NPC dialogue inside NARRATOR. Use the NPC's name as speaker.

CRITICAL: Return ONLY a single, valid JSON object. No markdown code blocks (fences like \`\`\`json). No prose outside JSON. Run any tool calls first, then output the final JSON when you are ready to end your turn.`;

const turnChecklistPrompt = `Before responding:
1. Read current task.
2. Check active players, scene, quest, and recent transcript.
3. Call required tools before final JSON.
4. Return compact JSON with updates.

Required JSON shape:
{"story":[{"speaker":"NARRATOR|SYSTEM|NPC name","content":"narration/dialogue","itemUsed":"optional","abilityUsed":"optional"}],"title":"optional","currentScene":"optional","overview":"optional","playerActions":{"<playerId>":[{"title":"Look around","prompt":"I look around."}]},"partyActions":[{"title":"Shared Action","prompt":"We act together."}],"playerUpdates":[{"playerId":"...","characterName":"optional","background":"optional","portraitUrl":"optional","portraitPrompt":"optional","status":"Ready/Active/Stunned/etc.","inventory":["item"],"abilities":["ability"],"notes":"private notes","color":"cyan","stats":[{"name":"HP","value":15,"maxValue":20,"color":"red"}]}],"npcUpdates":[{"id":"existing id","renameFrom":"old name","name":"NPC name","description":"desc","portraitUrl":"url","status":"Ready","color":"orange","inventory":["item"],"abilities":["ability"],"stats":[{"name":"HP","value":15,"maxValue":15,"color":"red"}]}]}

Always provide playerActions (2-4 choices) for every active player unless incapacitated.`;

const tabletopRulesPrompt = `CAMPAIGN TYPE: STANDARD TABLETOP RPG (NOT D&D)
This is a broad tabletop roleplaying campaign. Preserve the genre, era, and tone from the setup.
- Do NOT turn modern, sci-fi, mystery, horror, spy, superhero, or slice-of-life premises into fantasy.
- Do NOT introduce D&D races, classes, spells, spell slots, rests, armor classes, alignments, or standard attributes unless the setup or player explicitly asks for them.
- Character sheets should use story-first gear, specialties, conditions, and simple custom traits that match the premise.
- Use simple d20 checks only when risk matters, and narrate outcomes without D&D mechanical jargon.
- Keep the experience cinematic, rules-light, and setting-faithful.`;

const dndCasualRulesPrompt = `CAMPAIGN TYPE: DUNGEONS & DRAGONS, RULES-LIGHT (IMPORTANT)
This is a D&D campaign with approachable, rules-light handling.
- Use fantasy adventure conventions, monsters, magic, quests, treasure, and heroic party play.
- Avoid heavy mechanical bookkeeping unless the player asks for it.
- Do NOT use standard D&D mechanical stats (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma) or modifiers in casual mode. The only required stat is HP.
- Mention classes, ancestry, spells, and iconic D&D ideas when they fit, but keep choices simple and narrative-focused.
- Do NOT mention short/long rests, spell slots, initiative rolls, or complex checks unless the scene truly needs them.`;

const fullRulesPrompt = `CAMPAIGN RULES MODE: FULL D&D 5E IMMERSION (IMPORTANT)
This campaign uses full, authentic Dungeons & Dragons rules.
- Fully embrace classic D&D mechanics: standard stats (Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma), standard classes, spells, spell slots, short/long rests, player races, and DC checks.
- Incorporate attributes, class features, and rules checks into story narration and options.`;

function campaignRulesPrompt(campaign: { campaignType?: string; rulesMode?: string }) {
  if (campaign.campaignType !== "dnd") return tabletopRulesPrompt;
  return campaign.rulesMode === "full" ? fullRulesPrompt : dndCasualRulesPrompt;
}

type ChatCompletionResponse = {
  choices?: Array<{
    message?: AquaMessage;
  }>;
  message?: AquaMessage;
};

export async function runDungeonMaster(campaignId: string, playerName: string, action: string, options: { hiddenUserMessage?: boolean; playerId?: string; displayAction?: string; actionId?: string } = {}) {
  await logCampaignDebug(campaignId, `[runDungeonMaster] Called by: ${playerName}. Action: "${action}". Options: ${JSON.stringify(options)}`);
  serverLog("DM START", `Running DM for campaign: ${campaignId} | Player: ${playerName} | Action: "${action}"`);
  const campaign = await getCampaign(campaignId);
  const isJoin = action.startsWith("A new player has joined") || action.startsWith("A new player joined");
  const isRejoin = action.startsWith("Player ") && action.includes("rejoined");
  const isInitialStart = action.startsWith("Start the couch campaign now.");
  campaign.dmStatus = isInitialStart
    ? "Preparing the initial scenario..."
    : (isJoin
       ? "Integrating new player profile..."
       : (isRejoin ? "Reintegrating player..." : "The Dungeon Master is scheming..."));
  campaign.dmPhase = "signal";

  if (!options.hiddenUserMessage) {
    campaign.messages.push({ id: options.actionId || createId("msg"), role: "user", name: playerName, content: action, createdAt: new Date().toISOString() });
    safePushDisplayEvent(campaign, {
      type: "playerAction",
      speaker: playerName,
      playerId: options.playerId,
      content: options.displayAction || action
    });
  }
  await saveCampaign(campaign);

  // Start campaign draft caching for background AI run
  startCampaignDraft(campaignId, campaign);

  try {
    const messages: AquaMessage[] = [
      { role: "system", content: systemPrompt + "\n\n" + campaignRulesPrompt(campaign) },
      { role: "system", content: buildCampaignContext(campaign) },
      { role: "system", content: turnChecklistPrompt },
      { role: "user", name: playerName, content: action }
    ];

    let finalMessage: AquaMessage | null = null;
    const toolEvents: string[] = [];

    for (let step = 0; step < 8; step += 1) {
      await logCampaignDebug(campaignId, `[AI Step ${step + 1}] Requesting completion...`);
      serverLog("DM AI Step", `Step ${step + 1}/8: Requesting completion...`);
      const response = await complete(messages);
      const message = response.choices?.[0]?.message || response.message;
      if (!message) throw new Error("Aqua chat response did not include a message");
      await logCampaignDebug(campaignId, `[AI Step ${step + 1}] Received response: ${JSON.stringify(message)}`);
      
      const toolCalls = normalizeToolCalls(message);
      serverLog("DM AI Step", `Step ${step + 1}/8: Received response. Tool calls found: ${toolCalls.length}`);
      if (!toolCalls.length) {
        finalMessage = message;
        break;
      }

      messages.push({ ...message, content: message.content || "" });
      for (const call of toolCalls) {
        // Update dmStatus before executing tool
        const current = await getCampaign(campaignId);
        const originalStatus = current.dmStatus || "";
        const isJoinOrSetup = originalStatus.includes("Integrating") || originalStatus.includes("Preparing") || originalStatus.includes("Reintegrating");
        
        let toolStatus = "";
        let toolPhase: import("@/lib/campaign/types").DmPhase | undefined;
        
        const isPlayerSyncFlow = originalStatus.toLowerCase().includes("integrating") || originalStatus.toLowerCase().includes("reintegrating");

        if (call.function.name === "roll_dice") {
          toolStatus = "Rolling the 20-sided die...";
        } else if (call.function.name === "set_ambience") {
          toolStatus = "Tuning the table's atmosphere...";
        } else if (call.function.name === "trigger_effect") {
          toolStatus = "Conjuring stage effects...";
        } else if (call.function.name === "generate_image") {
          let isPortrait = false;
          try {
            const a = JSON.parse(call.function.arguments || "{}");
            isPortrait = a && (a.kind === "portrait" || !!a.playerId);
          } catch { /* ignore */ }
          toolStatus = isPortrait ? "Painting a character portrait..." : "Painting a cinematic scene...";
          toolPhase = "image";
        } else if (call.function.name === "write_campaign_file") {
          let pathArg = "";
          try {
            const a = JSON.parse(call.function.arguments || "{}");
            pathArg = String(a.path || "").toLowerCase();
          } catch { /* ignore */ }
          const isWorldFile = pathArg.includes("world") || pathArg.includes("lore") || pathArg.includes("history") || pathArg.includes("npc");
          
          if (isWorldFile && !isPlayerSyncFlow) {
            toolStatus = "Writing campaign lore and world history...";
            toolPhase = "world";
          } else {
            toolStatus = "Updating character notes and scrolls...";
            toolPhase = "sheet";
          }
        } else if (call.function.name === "read_campaign_file") {
          let pathArg = "";
          try {
            const a = JSON.parse(call.function.arguments || "{}");
            pathArg = String(a.path || "").toLowerCase();
          } catch { /* ignore */ }
          const isWorldFile = pathArg.includes("world") || pathArg.includes("lore") || pathArg.includes("history") || pathArg.includes("npc");
          
          toolStatus = isWorldFile ? "Reading world history files..." : "Reading character sheet data...";
          toolPhase = (isWorldFile && !isPlayerSyncFlow) ? "world" : "sheet";
        } else if (call.function.name === "update_campaign_state") {
          let hasPlayerUpdates = false;
          let hasNpcUpdates = false;
          let hasSceneUpdates = false;
          try {
            const a = JSON.parse(call.function.arguments || "{}");
            hasPlayerUpdates = a && Array.isArray(a.playerUpdates) && a.playerUpdates.length > 0;
            hasNpcUpdates = a && Array.isArray(a.npcUpdates) && a.npcUpdates.length > 0;
            hasSceneUpdates = a && (typeof a.currentScene === "string" || Array.isArray(a.displayEvents));
          } catch { /* ignore */ }

          if (hasPlayerUpdates) {
            toolStatus = "Forging character sheet details...";
            toolPhase = "sheet";
          } else if (hasNpcUpdates) {
            toolStatus = "Designing NPC profiles...";
            toolPhase = isPlayerSyncFlow ? "sheet" : "world";
          } else if (hasSceneUpdates) {
            toolStatus = isPlayerSyncFlow ? "Splicing player into the live timeline..." : "Drafting the opening scene and narrative beats...";
            toolPhase = isPlayerSyncFlow ? "integrate" : "scene";
          } else {
            toolStatus = "Aligning campaign state...";
            toolPhase = isPlayerSyncFlow ? "integrate" : "scene";
          }
        }

        if (toolStatus) {
          if (isJoinOrSetup) {
            const baseStatus = originalStatus.replace(/\s*\(.*?\)/g, "").replace(/\.\.\./g, "").trim();
            current.dmStatus = `${baseStatus}... (${toolStatus.toLowerCase().replace(/\.\.\./g, "")})`;
          } else {
            current.dmStatus = toolStatus;
          }
        }
        if (toolPhase) current.dmPhase = toolPhase;
        await saveCampaign(current);

        await logCampaignDebug(campaignId, `[Tool Call] Executing ${call.function.name} with args: ${call.function.arguments}`);
        serverLog("DM Tool Call", `Executing '${call.function.name}' with arguments: ${call.function.arguments}`);
        const result = await runTool(campaignId, call.function.name, call.function.arguments);
        const resultText = JSON.stringify(result);
        await logCampaignDebug(campaignId, `[Tool Result] ${call.function.name} returned: ${resultText}`);
        serverLog("DM Tool Result", `Tool '${call.function.name}' returned: ${resultText.slice(0, 160)}${resultText.length > 160 ? "..." : ""}`);
        toolEvents.push(`${call.function.name}: ${resultText}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
    }

    if (!finalMessage) {
      serverError("DM Loop", "Tool loop exceeded maximum steps (8).");
      throw new Error("Tool loop exceeded maximum steps");
    }

    let content = finalMessage.content || "";
    await logCampaignDebug(campaignId, `[AI Finish] Final response content: ${content}`);
    let parsedJson = await parseFinalJson(campaignId, content);

    if (!parsedJson) {
      await logCampaignDebug(campaignId, `[AI Retry] Retrying final response because JSON parsing failed.`);
      serverLog("DM Parser", "Retrying final response because JSON parsing failed.");
      const retryResponse = await complete([
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content: "Your previous response was not valid JSON and could not be applied to the campaign. Return the same narrative result again as ONLY strict JSON matching the required schema. Do not call tools. Do not include prose or markdown fences."
        }
      ], "none");
      const retryMessage = retryResponse.choices?.[0]?.message || retryResponse.message;
      const retryContent = retryMessage?.content || "";
      await logCampaignDebug(campaignId, `[AI Retry] Final response content: ${retryContent}`);
      const retryParsedJson = await parseFinalJson(campaignId, retryContent);
      if (retryParsedJson) {
        finalMessage = retryMessage || finalMessage;
        content = retryContent;
        parsedJson = retryParsedJson;
      } else {
        serverError("DM Parser", "Retry response still failed JSON parsing. Falling back to plain text.");
        await logCampaignDebug(campaignId, `[AI Retry] Retry failed JSON parsing. Falling back to plain text.`);
      }
    }

    const latestCampaign = await getCampaign(campaignId);
    latestCampaign.messages.push({
      id: createId("msg"),
      role: "assistant",
      content: content,
      createdAt: new Date().toISOString()
    });

    if (parsedJson) {
      if (Array.isArray(parsedJson.story)) {
        const mergedStory: any[] = [];
        for (const item of parsedJson.story) {
          if (!item || typeof item !== "object") continue;
          const speaker = item.speaker || "NARRATOR";
          const contentText = item.content || "";
          const itemUsed = typeof item.itemUsed === "string" ? item.itemUsed : undefined;
          const abilityUsed = typeof item.abilityUsed === "string" ? item.abilityUsed : undefined;

          const prev = mergedStory[mergedStory.length - 1];
          if (prev && 
              prev.speaker.toLowerCase() === speaker.toLowerCase() && 
              prev.itemUsed === itemUsed && 
              prev.abilityUsed === abilityUsed) {
            prev.content = `${prev.content}\n\n${contentText}`;
          } else {
            mergedStory.push({ speaker, content: contentText, itemUsed, abilityUsed });
          }
        }

        for (const item of mergedStory) {
          const speaker = item.speaker;
          const contentText = item.content;
          const itemUsed = item.itemUsed;
          const abilityUsed = item.abilityUsed;

          if (latestCampaign.status !== "lobby") {
            safePushDisplayEvent(latestCampaign, {
              type: speaker === "SYSTEM" ? "system" : "narration",
              speaker: speaker,
              content: contentText,
              itemUsed: itemUsed,
              abilityUsed: abilityUsed
            });
          }
        }
      } else {
        // Fallback
        const speaker = parsedJson.speaker || "NARRATOR";
        const narratorText = parsedJson.narrator || "";
        const itemUsed = typeof parsedJson.itemUsed === "string" ? parsedJson.itemUsed : undefined;
        const abilityUsed = typeof parsedJson.abilityUsed === "string" ? parsedJson.abilityUsed : undefined;
        
        if (latestCampaign.status !== "lobby") {
          safePushDisplayEvent(latestCampaign, {
            type: speaker === "SYSTEM" ? "system" : "narration",
            speaker: speaker,
            content: narratorText,
            itemUsed: itemUsed,
            abilityUsed: abilityUsed
          });
        }
      }

      if (typeof parsedJson.currentScene === "string") {
        latestCampaign.currentScene = parsedJson.currentScene;
      }
      if (typeof parsedJson.overview === "string") {
        latestCampaign.overview = parsedJson.overview;
      }
      if (typeof parsedJson.title === "string" && parsedJson.title.trim()) {
        latestCampaign.title = parsedJson.title.trim();
      }

      if (latestCampaign.status === "active") {
        // Clear player actions at start of turn so they don't linger
        for (const p of latestCampaign.players) {
          latestCampaign.playerActions[p.id] = [];
        }
        if (parsedJson.playerActions) {
          if (Array.isArray(parsedJson.playerActions)) {
            for (const item of parsedJson.playerActions) {
              if (item && typeof item === "object") {
                const pId = String(item.playerId || item.playerName || "");
                const actions = item.actions;
                const player = latestCampaign.players.find((p) => p.id === pId) ||
                               latestCampaign.players.find((p) => (p.characterName || p.name).toLowerCase() === pId.toLowerCase());
                if (player && Array.isArray(actions)) {
                  latestCampaign.playerActions[player.id] = normalizeActions(actions).slice(0, 6);
                }
              }
            }
          } else if (typeof parsedJson.playerActions === "object") {
            for (const [pId, actions] of Object.entries(parsedJson.playerActions)) {
              const player = latestCampaign.players.find((p) => p.id === pId) ||
                             latestCampaign.players.find((p) => (p.characterName || p.name).toLowerCase() === pId.toLowerCase());
              if (player && Array.isArray(actions)) {
                latestCampaign.playerActions[player.id] = normalizeActions(actions).slice(0, 6);
              }
            }
          }
        }
      }

      if (Array.isArray(parsedJson.partyActions)) {
        latestCampaign.partyActions = normalizeActions(parsedJson.partyActions).slice(0, 4);
      }

      if (Array.isArray(parsedJson.playerUpdates)) {
        for (const update of parsedJson.playerUpdates) {
          const player = latestCampaign.players.find((item) => item.id === String(update.playerId || "")) ||
                         latestCampaign.players.find((item) => (item.characterName || item.name).toLowerCase() === String(update.playerName || update.playerId || "").toLowerCase());
          if (!player) continue;
          if (Array.isArray(update.inventory)) player.inventory = update.inventory.map(String);
          if (Array.isArray(update.abilities)) player.abilities = update.abilities.map(String);
          if (typeof update.notes === "string") player.notes = update.notes;
          if (typeof update.characterName === "string" && (latestCampaign.isRandomized || !player.characterName)) {
            player.characterName = update.characterName;
          }
          if (typeof update.background === "string") player.background = update.background;
          if (typeof update.status === "string") player.status = update.status;
          if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) {
            const localUrl = await downloadAndSaveImage(campaignId, update.portraitUrl, "players", player.id);
            player.portraitUrl = localUrl;
            if (localUrl && localUrl.trim()) {
              if (!latestCampaign.portraits) latestCampaign.portraits = [];
              const exists = latestCampaign.portraits.some((p) => p.url === localUrl);
              if (!exists) {
                latestCampaign.portraits.push({
                  id: createId("portrait"),
                  url: localUrl,
                  prompt: update.portraitPrompt || player.portraitPrompt || "Portrait of " + (player.characterName || player.name),
                  characterName: player.characterName || player.name,
                  createdAt: new Date().toISOString()
                });
              }
            }
          }
          if (typeof update.portraitPrompt === "string") player.portraitPrompt = update.portraitPrompt;
          if (typeof update.color === "string") player.color = update.color;
          if (Array.isArray(update.stats)) {
            player.stats = mergeStats(player.stats, update.stats);
          }
        }
      }

      if (Array.isArray(parsedJson.npcUpdates)) {
        for (const update of parsedJson.npcUpdates) {
          let char = latestCampaign.storyCharacters.find((c) => c.id === String(update.id || "")) ||
                     (update.renameFrom && latestCampaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.renameFrom).toLowerCase())) ||
                     latestCampaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.name || "").toLowerCase());
          if (char) {
            if (typeof update.name === "string") char.name = update.name;
            if (typeof update.description === "string") char.description = update.description;
            if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) {
              const localUrl = await downloadAndSaveImage(campaignId, update.portraitUrl, "npcs", char.id);
              char.portraitUrl = localUrl;
              if (localUrl && localUrl.trim()) {
                if (!latestCampaign.portraits) latestCampaign.portraits = [];
                const exists = latestCampaign.portraits.some((p) => p.url === localUrl);
                if (!exists) {
                  latestCampaign.portraits.push({
                    id: createId("portrait"),
                    url: localUrl,
                    prompt: update.description || char.description || "Portrait of NPC " + char.name,
                    characterName: char.name,
                    createdAt: new Date().toISOString()
                  });
                }
              }
            }
            if (typeof update.status === "string") char.status = update.status;
            if (typeof update.color === "string") char.color = update.color;
            if (Array.isArray(update.inventory)) char.inventory = update.inventory.map(String);
            if (Array.isArray(update.abilities)) char.abilities = update.abilities.map(String);
            if (Array.isArray(update.stats)) {
              char.stats = mergeStats(char.stats, update.stats);
            }
          } else {
            const newCharId = String(update.id || createId("character"));
            let localUrl = undefined;
            if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) {
              localUrl = await downloadAndSaveImage(campaignId, update.portraitUrl, "npcs", newCharId);
            }
            const npc = {
              id: newCharId,
              name: String(update.name || "NPC"),
              description: String(update.description || ""),
              portraitUrl: localUrl,
              status: update.status,
              color: update.color,
              inventory: Array.isArray(update.inventory) ? update.inventory.map(String) : [],
              abilities: Array.isArray(update.abilities) ? update.abilities.map(String) : [],
              stats: Array.isArray(update.stats) ? mergeStats([], update.stats) : []
            };
            if (localUrl) {
              if (!latestCampaign.portraits) latestCampaign.portraits = [];
              const exists = latestCampaign.portraits.some((p) => p.url === localUrl);
              if (!exists) {
                latestCampaign.portraits.push({
                  id: createId("portrait"),
                  url: localUrl,
                  prompt: npc.description || "Portrait of NPC " + npc.name,
                  characterName: npc.name,
                  createdAt: new Date().toISOString()
                });
              }
            }
            latestCampaign.storyCharacters.push(npc);
          }
        }
      }
    } else {
      // Fallback if no JSON found
      const textContent = stripSuggestedActions(content || "The Dungeon Master pauses, considering what happens next.");
      if (latestCampaign.status !== "lobby") {
        safePushDisplayEvent(latestCampaign, {
          type: "narration",
          speaker: "NARRATOR",
          content: textContent
        });
      }
    }

    latestCampaign.dmStatus = undefined; // Clear DM status
    latestCampaign.dmPhase = undefined;
    
    finishCampaignDraft(campaignId);
    await saveCampaign(latestCampaign);

    serverLog("DM END", `DM finished successfully for campaign: ${campaignId}`);
    return { campaign: latestCampaign, toolEvents };
  } catch (error) {
    serverError("Dungeon Master", `DM failed with error for campaign: ${campaignId}`, error);
    const errorMsg = error instanceof Error ? error.stack : String(error);
    await logCampaignDebug(campaignId, `[ERROR] Dungeon Master error: ${errorMsg}`);
    try {
      finishCampaignDraft(campaignId);
      const currentCampaign = await getCampaign(campaignId);
      currentCampaign.dmStatus = undefined;
      currentCampaign.dmPhase = undefined;
      await saveCampaign(currentCampaign);
    } catch (dbErr) {
      serverError("Dungeon Master", "Failed to clear dmStatus on error", dbErr);
    }
    throw error;
  }
}

function stripSuggestedActions(content: string) {
  return content.replace(/\n?\*\*Suggested Actions:\*\*[\s\S]*$/i, "").trim();
}

async function complete(messages: AquaMessage[], toolChoice: "auto" | "none" = "auto") {
  const config = aquaConfig();
  return (await aquaFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: config.chatModel,
      messages,
      tools: toolDefinitions,
      tool_choice: toolChoice
    })
  })) as ChatCompletionResponse;
}

async function parseFinalJson(campaignId: string, content: string) {
  const startIdx = content.indexOf("{");
  const endIdx = content.lastIndexOf("}");
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    serverLog("DM Parser", "AI response did not contain a JSON block. Falling back to plain text.");
    await logCampaignDebug(campaignId, `[AI Finish] Response did not contain a JSON block.`);
    return null;
  }

  const jsonStr = content.substring(startIdx, endIdx + 1);
  try {
    const parsedJson = JSON.parse(jsonStr);
    await logCampaignDebug(campaignId, `[AI Finish] Parsed JSON successfully.`);
    serverLog("DM Parser", "Successfully parsed story JSON response.", {
      title: parsedJson.title || undefined,
      currentScene: parsedJson.currentScene || undefined,
      storyCount: Array.isArray(parsedJson.story) ? parsedJson.story.length : 0,
      playerUpdatesCount: Array.isArray(parsedJson.playerUpdates) ? parsedJson.playerUpdates.length : 0,
      npcUpdatesCount: Array.isArray(parsedJson.npcUpdates) ? parsedJson.npcUpdates.length : 0,
    });
    return parsedJson;
  } catch (err) {
    serverError("DM Parser", "Failed to parse JSON content from AI message. Error: " + String(err));
    await logCampaignDebug(campaignId, `[AI Finish] Failed to parse JSON content. Error: ${err}`);
    return null;
  }
}

function normalizeToolCalls(message: AquaMessage): AquaToolCall[] {
  if (Array.isArray(message.tool_calls)) return message.tool_calls;
  return [];
}

function normalizeActions(actions: unknown): Array<{ title: string; prompt: string }> {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => {
    if (typeof action === "string") return { title: action, prompt: action };
    const item = action as Record<string, unknown>;
    return { title: String(item.title || item.prompt || "Act"), prompt: String(item.prompt || item.title || "Act") };
  });
}

function mergeStats(currentStats: PlayerStat[] | undefined, incomingStats: any[]): PlayerStat[] {
  const merged = Array.isArray(currentStats) ? [...currentStats] : [];
  for (const s of incomingStats) {
    const nameStr = String(s.name || "Stat");
    const existingIdx = merged.findIndex((item) => item.name.toLowerCase() === nameStr.toLowerCase());
    if (existingIdx !== -1) {
      merged[existingIdx] = {
        name: merged[existingIdx].name,
        value: Number(s.value ?? 0),
        maxValue: Number(s.maxValue ?? 10),
        color: s.color ? String(s.color) : merged[existingIdx].color
      };
    } else {
      merged.push({
        name: nameStr,
        value: Number(s.value ?? 0),
        maxValue: Number(s.maxValue ?? 10),
        color: s.color ? String(s.color) : undefined
      });
    }
  }
  return merged;
}

export async function runProfileGeneration(campaignId: string, playerId: string) {
  await logCampaignDebug(campaignId, `[runProfileGeneration] Player ID: ${playerId}`);
  serverLog("PROFILE START", `Running profile generation for player: ${playerId} in campaign: ${campaignId}`);
  
  const campaign = await getCampaign(campaignId);
  const player = campaign.players.find(p => p.id === playerId);
  if (!player) {
    throw new Error(`Player not found: ${playerId}`);
  }

  const isSurprise = campaign.isRandomized;
  const isDndCampaign = campaign.campaignType === "dnd";
  const isFullRules = isDndCampaign && campaign.rulesMode === "full";
  const submittedCharacterName = (player.characterName || player.name || "").trim();
  const modeBrief = isDndCampaign
    ? (isFullRules ? "full Dungeons & Dragons 5e" : "rules-light Dungeons & Dragons")
    : "standard tabletop RPG";
  const genreGuard = isDndCampaign
    ? "Create a D&D-appropriate fantasy adventurer."
    : "Preserve the campaign's actual genre, era, and tone. Do not add D&D fantasy races, classes, magic, medieval gear, or standard attributes unless the setup or player explicitly included them.";
  const inventoryInstruction = isDndCampaign
    ? "starting adventuring items that fit their class/archetype and the campaign"
    : "starting gear, clues, contacts, tools, or resources that fit the campaign premise and the player's concept";
  const abilitiesInstruction = isDndCampaign
    ? "starting abilities, talents, class features, or spells"
    : "simple story-first specialties, edges, training, or useful traits";
  const statsInstruction = isFullRules
    ? "- Include standard D&D stats: Strength, Dexterity, Constitution, Intelligence, Wisdom, Charisma (value: 8 to 18, maxValue: 20)."
    : isDndCampaign
      ? "- Do NOT include standard D&D attribute stats or modifiers in rules-light mode. Include HP and up to 2-3 simple fantasy-themed traits if useful."
      : "- Do NOT include D&D stats, attribute modifiers, classes, spell slots, or fantasy-only mechanics. Include HP and 2-3 simple custom traits matching this campaign's genre.";

  const systemInstruction = `You are a character generation assistant for a ${modeBrief} campaign.
Your only job is to forge a detailed character profile (backstory, stats, inventory, abilities, notes, color, status) and generate a matching character portrait.
${genreGuard}

1. Call generate_image to create a close-up portrait of the character.
2. Return a JSON object with a single key 'playerUpdates' containing the completed player profile details:
   - characterName: ${isSurprise ? "generate a creative name" : `MUST be exactly "${submittedCharacterName}". Do not rename, improve, translate, or decorate it.`}
   - background: ${isSurprise ? "generate a detailed background backstory" : "polished/expanded backstory matching their background input"}
   - personality: ${isSurprise ? "generate a thematic personality" : "polished/expanded personality matching their personality input"}
   - portraitUrl: the URL returned by the generate_image tool
   - portraitPrompt: the prompt used for image generation
   - status: "Ready"
   - inventory: ${inventoryInstruction}
   - abilities: ${abilitiesInstruction}
   - notes: private character sheet notes (e.g., character description, traits, quirks ${isFullRules ? ", class description" : ""})
   - color: a thematic CSS color name (e.g. green, orange, cyan, gold)
   - stats: starting stats. 
     - HP: value 20, maxValue 20, color "red".
     ${statsInstruction}

Return ONLY valid JSON matching this schema. Do not include markdown code fences (like \`\`\`json). Do not write prose outside JSON. Run generate_image first, then return the JSON.`;

  const userPrompt = isSurprise
    ? `Generate a random ${modeBrief} character sheet for campaign "${campaign.title}".\nCampaign setup: ${campaign.startingStory || campaign.currentScene || "No setup provided."}`
    : `Campaign Title: "${campaign.title}"\nCampaign Type: "${modeBrief}"\nCampaign Setup: "${campaign.startingStory || campaign.currentScene || ""}"\nPlayer Name: "${player.name}"\nCharacter Name Draft: "${submittedCharacterName}"\nBackground Draft: "${player.background || ""}"\nPersonality Draft: "${player.personality || ""}"`;

  const messages: AquaMessage[] = [
    { role: "system", content: systemInstruction },
    { role: "user", content: userPrompt }
  ];

  // Simple tool loop (up to 4 steps)
  let finalMessage: AquaMessage | null = null;
  for (let step = 0; step < 4; step += 1) {
    const response = await complete(messages);
    const message = response.choices?.[0]?.message || response.message;
    if (!message) throw new Error("Aqua chat response did not include a message");
    
    const toolCalls = normalizeToolCalls(message);
    if (!toolCalls.length) {
      finalMessage = message;
      break;
    }

    messages.push({ ...message, content: message.content || "" });
    for (const call of toolCalls) {
      if (call.function.name === "generate_image") {
        await logCampaignDebug(campaignId, `[Profile Gen Image] Executing generate_image with args: ${call.function.arguments}`);
        
        let toolArgs: Record<string, any> = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
        } catch {
          toolArgs = { prompt: call.function.arguments };
        }
        toolArgs.kind = "portrait";
        toolArgs.playerId = playerId;
        const modifiedArguments = JSON.stringify(toolArgs);

        const result = await runTool(campaignId, call.function.name, modifiedArguments);
        const resultText = JSON.stringify(result);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      } else {
        // Disallow other tools to prevent story/file changes during profile generation
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Only generate_image is allowed during profile generation" }) });
      }
    }
  }

  if (!finalMessage) throw new Error("Profile generation loop exceeded maximum steps");

  const content = finalMessage.content || "";
  let parsedJson = await parseFinalJson(campaignId, content);

  // If JSON parsing failed, try once more with strict constraint
  if (!parsedJson) {
    const retryResponse = await complete([
      ...messages,
      { role: "assistant", content },
      { role: "user", content: "Your previous response was not valid JSON. Return the playerUpdates JSON again. No markdown fences, no extra text." }
    ], "none");
    const retryMessage = retryResponse.choices?.[0]?.message || retryResponse.message;
    const retryContent = retryMessage?.content || "";
    parsedJson = await parseFinalJson(campaignId, retryContent);
  }

  if (!parsedJson || !Array.isArray(parsedJson.playerUpdates) || parsedJson.playerUpdates.length === 0) {
    throw new Error("Failed to generate player profile details");
  }

  // Apply updates only to the target player
  const latestCampaign = await getCampaign(campaignId);
  const targetPlayer = latestCampaign.players.find(p => p.id === playerId);
  if (!targetPlayer) throw new Error("Target player disappeared from campaign during generation");

  const update = parsedJson.playerUpdates[0];
  if (isSurprise && typeof update.characterName === "string") {
    targetPlayer.characterName = update.characterName;
  } else if (submittedCharacterName) {
    targetPlayer.characterName = submittedCharacterName;
  }
  if (typeof update.background === "string") targetPlayer.background = update.background;
  if (typeof update.personality === "string") targetPlayer.personality = update.personality;
  if (Array.isArray(update.inventory)) targetPlayer.inventory = update.inventory.map(String);
  if (Array.isArray(update.abilities)) targetPlayer.abilities = update.abilities.map(String);
  if (typeof update.notes === "string") targetPlayer.notes = update.notes;
  if (typeof update.status === "string") targetPlayer.status = update.status;
  if (typeof update.color === "string") targetPlayer.color = update.color;
  
  if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) {
    const localUrl = await downloadAndSaveImage(campaignId, update.portraitUrl, "players", targetPlayer.id);
    targetPlayer.portraitUrl = localUrl;
    if (localUrl && localUrl.trim()) {
      if (!latestCampaign.portraits) latestCampaign.portraits = [];
      const exists = latestCampaign.portraits.some((p) => p.url === localUrl);
      if (!exists) {
        latestCampaign.portraits.push({
          id: createId("portrait"),
          url: localUrl,
          prompt: update.portraitPrompt || targetPlayer.portraitPrompt || "Portrait of " + (targetPlayer.characterName || targetPlayer.name),
          characterName: targetPlayer.characterName || targetPlayer.name,
          createdAt: new Date().toISOString()
        });
      }
    }
  }
  if (typeof update.portraitPrompt === "string") targetPlayer.portraitPrompt = update.portraitPrompt;
  if (Array.isArray(update.stats)) {
    targetPlayer.stats = mergeStats(targetPlayer.stats, update.stats);
  }

  // Clear DM status
  latestCampaign.dmStatus = undefined;
  latestCampaign.dmPhase = undefined;

  await saveCampaign(latestCampaign);
  serverLog("PROFILE END", `Successfully finished profile generation for player: ${playerId}`);
}
