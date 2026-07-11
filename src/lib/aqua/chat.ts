import { buildCampaignContext } from "@/lib/campaign/context";
import { getCampaign, saveCampaign, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, startCampaignDraft, finishCampaignDraft } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { aquaConfig, aquaFetch, AquaMessage, AquaToolCall } from "./client";
import { runTool, toolDefinitions } from "@/lib/tools/registry";
import { Campaign, PlayerStat } from "@/lib/campaign/types";
import { classifyMusicTheme, MUSIC_THEMES, MusicTheme } from "@/lib/campaign/musicTheme";

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

Dice rules (the server rolls — you NEVER pick, predict, or invent numbers; narrate only from the tool result):
- A d20 check: call roll_dice with d20Mode "normal" and a dc. Base DC: Easy 10, Medium 15, Hard 20, Very Hard 25.
- Ability fit shifts the DC, never the die. A character whose listed special ability directly covers the task: DC -2 or -3 (they do it well). Anyone can attempt ordinary tasks at base DC. A specialist task with NO fitting ability, tool, or training: DC +2 to +5 (harder for them).
- d20Mode "advantage" is RARE. Grant it only for overwhelming situational dominance: the target is stunned, restrained, or helpless; striking a completely unaware enemy point-blank; a flawlessly prepared setup. Having a relevant ability is NOT advantage — that's a DC shift.
- d20Mode "disadvantage" mirrors it: only for severe impairment (blinded, badly wounded, acting in chaos).
- Only use +N/-N modifiers in notation for real damage math or explicit sheet stats. Never as a stand-in for ability fit.
- The tool returns dc + outcome (success/failure/critical). Honor it exactly; do not soften failures or invent extra rolls.
- Do NOT restate the roll as a SYSTEM story beat — the TV already animates every roll with its result.

Continuity & assets:
- Track stats, inventory, abilities, NPCs, locations, quests.
- Every player ability should be distinctive to that character and matter mechanically (it defines their easy DCs). When granting new abilities, keep them specific ("Fieldcraft: improvised gadgets from spare parts"), not generic.
- New NPC/monster on stage: call generate_image with kind "portrait" and npcName BEFORE introducing them; the portrait attaches to the NPC automatically.
- When the party moves somewhere visually new, update the TV backdrop: reuse a previously generated background via update_campaign_state currentImageUrl if one fits, otherwise call generate_image (kind "scene"). Do not leave a stale backdrop after a location change.
- Maintain quest_log.md with ONLY the current active objective and immediate tasks.

Cinematic direction (you are also the stage director):
- If (and only if) the set_theme tool is offered to you, no score has been chosen yet (a sealed-envelope campaign) — on the opening turn, once you know the world's genre, call set_theme EXACTLY ONCE to choose the campaign's musical score (fantasy/scifi/horror/noir/modern/western). This fixes the background music for the whole saga. When the tool is absent, the score is already set — leave it alone.
- Call set_ambience when the emotional register shifts (combat begins, a mystery deepens, the party reaches safety, a tragedy lands). One call per shift, not per turn.
- Call trigger_effect to punctuate big single beats: explosions (shake+flash), spellbursts (embers), horror stings (darkness/heartbeat), storms (rain/fog).
- Prefer atmosphere over words: a mood change plus one tight paragraph beats three paragraphs.

Story delivery (one channel only):
- Your final JSON story[] is the ONLY place narration and dialogue go. NEVER send narration/dialogue through update_campaign_state displayEvents — the TV would play the same beat twice.
- update_campaign_state is for state: scene, overview, actions, player/NPC updates, backdrop.

Narration style (the TV performs each story beat one at a time, like film subtitles — write for that rhythm):
- Keep each story[] entry SHORT: 1-3 sentences. Never pack a whole scene into one entry; split it into several beats (narration → NPC line → narration → reaction…). Many short beats play far better than one long one.
- Use inline markdown for delivery, like a director marking a script: *italics* for whispers, inner dread, sensory detail, and soft emphasis; **bold** for names spoken with weight, sudden dangers, and dramatic reveals; ***both*** only for the rarest thunderclap moments. A few marks per scene — not every line.
- Give NPCs real voices: put their spoken lines in their own story entries with the NPC's name as speaker, mostly made of the words they say. Do not bury NPC dialogue inside NARRATOR text.
- Dramatize player actions: when a player declares an action, you may open with a beat whose speaker is that character's EXACT character name, rendering their declared action as 1-2 sentences of third-person cinema ("*Kara slips between the stalls, blade low.*"). Only dramatize what they already declared or its direct physical execution — never invent decisions, words, thoughts, or feelings for them.
- Speaker values: "NARRATOR", "SYSTEM", an NPC name, or a player character's exact name (only for the action-dramatization above).

CRITICAL: Return ONLY a single, valid JSON object. No markdown code blocks (fences like \`\`\`json). No prose outside JSON. Run any tool calls first, then output the final JSON when you are ready to end your turn.`;

const turnChecklistPrompt = `Before responding:
1. Read current task.
2. Check active players, scene, quest, and recent transcript.
3. Call required tools before final JSON.
4. Return compact JSON with updates.

Required JSON shape:
{"story":[{"speaker":"NARRATOR|SYSTEM|NPC name|player character name","content":"short beat (1-3 sentences, may use *italic*/**bold** inline markdown)","itemUsed":"optional","abilityUsed":"optional"}],"title":"optional","currentScene":"optional","overview":"optional","playerActions":{"<playerId>":[{"title":"Look around","prompt":"I look around."}]},"partyActions":[{"title":"Shared Action","prompt":"We act together."}],"playerUpdates":[{"playerId":"...","characterName":"optional","background":"optional","portraitUrl":"optional","portraitPrompt":"optional","status":"Ready/Active/Stunned/etc.","inventory":["item"],"abilities":["ability"],"notes":"private notes","color":"cyan","stats":[{"name":"HP","value":15,"maxValue":20,"color":"red"}]}],"npcUpdates":[{"id":"existing id","renameFrom":"old name","name":"NPC name","description":"desc","portraitUrl":"url","status":"Ready","color":"orange","inventory":["item"],"abilities":["ability"],"stats":[{"name":"HP","value":15,"maxValue":15,"color":"red"}]}]}

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
    // Once the score is chosen (now or on a past turn), drop set_theme from
    // the offered tools so it can't be picked again mid-turn.
    let themeChosen = !!campaign.musicTheme;

    for (let step = 0; step < 8; step += 1) {
      await logCampaignDebug(campaignId, `[AI Step ${step + 1}] Requesting completion...`);
      serverLog("DM AI Step", `Step ${step + 1}/8: Requesting completion...`);
      const response = await complete(messages, "auto", toolsForTurn({ musicTheme: themeChosen ? "set" : undefined }));
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
        } else if (call.function.name === "set_theme") {
          toolStatus = "Choosing the campaign's score...";
        } else if (call.function.name === "set_ambience") {
          toolStatus = "Tuning the table's atmosphere...";
        } else if (call.function.name === "trigger_effect") {
          toolStatus = "Conjuring stage effects...";
        } else if (call.function.name === "generate_image") {
          let isPortrait = false;
          try {
            const a = JSON.parse(call.function.arguments || "{}");
            isPortrait = a && (a.kind === "portrait" || !!a.playerId || !!a.npcName);
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
        if (call.function.name === "set_theme" && result && !(result as any).error) themeChosen = true;
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

        // Defense-in-depth: smaller models sometimes send the same beats via
        // update_campaign_state displayEvents AND the final story[] — drop
        // any beat whose text already sits in the recent TV timeline.
        const recentContents = new Set(
          latestCampaign.displayEvents.slice(-20).map((event) => (event.content || "").trim())
        );
        for (const item of mergedStory) {
          const speaker = item.speaker;
          const contentText = item.content;
          const itemUsed = item.itemUsed;
          const abilityUsed = item.abilityUsed;

          if ((contentText || "").trim() && recentContents.has(contentText.trim())) continue;
          if (latestCampaign.status !== "lobby") {
            safePushDisplayEvent(latestCampaign, {
              ...classifyStoryBeat(latestCampaign, speaker),
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
            ...classifyStoryBeat(latestCampaign, speaker),
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

    // Backfill the music theme once the world has content (covers sealed-
    // envelope campaigns, whose premise was empty at creation). Set once,
    // then left alone so the score stays consistent for the whole saga.
    if (!latestCampaign.musicTheme) {
      const theme = classifyMusicTheme(latestCampaign);
      if (theme) latestCampaign.musicTheme = theme;
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

/**
 * Map a story beat's speaker to a display-event type: NARRATOR stays pure
 * narration, SYSTEM is table talk, a player's character name means the DM is
 * dramatizing that player's declared action, anything else is NPC dialogue.
 */
function classifyStoryBeat(
  campaign: { players: Array<{ id: string; name: string; characterName?: string }> },
  speaker: string
): { type: import("@/lib/campaign/types").DisplayEvent["type"]; speaker: string; playerId?: string } {
  const upper = speaker.toUpperCase();
  if (upper === "SYSTEM") return { type: "system", speaker };
  if (upper === "NARRATOR") return { type: "narration", speaker };
  const player = campaign.players.find(
    (p) => (p.characterName || p.name).toLowerCase() === speaker.toLowerCase()
  );
  if (player) return { type: "playerAction", speaker, playerId: player.id };
  return { type: "dialogue", speaker };
}

function stripSuggestedActions(content: string) {
  return content.replace(/\n?\*\*Suggested Actions:\*\*[\s\S]*$/i, "").trim();
}

async function complete(
  messages: AquaMessage[],
  toolChoice: "auto" | "none" = "auto",
  tools: typeof toolDefinitions = toolDefinitions
) {
  const config = aquaConfig();
  return (await aquaFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: config.chatModel,
      messages,
      tools,
      tool_choice: toolChoice
    })
  })) as ChatCompletionResponse;
}

/**
 * The tools the DM may use this turn. We prune tools whose job is already
 * done so the model isn't tempted to re-run them: once the score is chosen,
 * set_theme vanishes (a mid-saga music swap just confuses the table).
 */
function toolsForTurn(campaign: { musicTheme?: string }): typeof toolDefinitions {
  return toolDefinitions.filter((tool) => {
    if (tool.function.name === "set_theme") return !campaign.musicTheme;
    return true;
  });
}

/**
 * Ask the AI to choose the campaign's musical score by forcing the set_theme
 * tool call. Returns the chosen theme, or null if the premise is too thin or
 * the model answers with something off-list. This is a standalone judgement
 * call — it does NOT run the tool (no DM turn, no side effects); the caller
 * decides what to do with the answer.
 */
async function pickMusicThemeViaTool(campaign: Campaign): Promise<MusicTheme | null> {
  const setThemeTool = toolDefinitions.find((tool) => tool.function.name === "set_theme");
  if (!setThemeTool) return null;

  const cast = (campaign.storyCharacters || [])
    .map((npc) => `${npc.name}: ${npc.description}`)
    .filter((line) => line.trim() && line.trim() !== ":")
    .join("\n");
  const premise = [
    campaign.title ? `Title: ${campaign.title}` : "",
    campaign.startingStory ? `Premise: ${campaign.startingStory}` : "",
    cast ? `Cast:\n${cast}` : ""
  ].filter(Boolean).join("\n\n");
  if (!premise.trim()) return null;

  const config = aquaConfig();
  const response = (await aquaFetch("/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: config.chatModel,
      messages: [
        {
          role: "system",
          content: "You are the score supervisor for a couch RPG. Read the campaign premise and call set_theme EXACTLY ONCE with the single best-fitting musical theme for its genre and era. Always pick the closest match, even if the fit is imperfect."
        },
        { role: "user", content: premise }
      ],
      tools: [setThemeTool],
      tool_choice: { type: "function", function: { name: "set_theme" } }
    })
  })) as ChatCompletionResponse;

  const message = response.choices?.[0]?.message || response.message;
  const call = Array.isArray(message?.tool_calls) ? message?.tool_calls?.[0] : null;
  if (!call?.function?.arguments) return null;
  try {
    const args = JSON.parse(call.function.arguments) as { theme?: string };
    return MUSIC_THEMES.includes(args.theme as MusicTheme) ? (args.theme as MusicTheme) : null;
  } catch {
    return null;
  }
}

/**
 * Choose and persist a campaign's music theme at CREATION time, before the
 * lobby opens, so the lobby's own music already plays on the right shelf. The
 * AI picks via set_theme; on any failure we keep whatever the keyword
 * classifier already seeded. Sealed-envelope campaigns have no premise yet, so
 * they stay unthemed here and get scored on the DM's opening turn instead.
 * Returns the latest campaign (with the theme applied when one was chosen).
 */
export async function chooseCampaignTheme(campaignId: string): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  try {
    if (campaign.isRandomized) return campaign;
    const theme = await pickMusicThemeViaTool(campaign);
    if (theme && theme !== campaign.musicTheme) {
      campaign.musicTheme = theme;
      await saveCampaign(campaign);
      serverLog("Theme", `AI chose music theme "${theme}" for campaign ${campaignId}`);
    }
  } catch (err) {
    serverError("Theme", "AI theme selection failed; keeping keyword-classified theme", err);
  }
  return campaign;
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
