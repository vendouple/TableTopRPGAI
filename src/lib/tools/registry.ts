import { getCampaign, readCampaignTextFile, saveCampaign, writeCampaignTextFile, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, pushStageEffect } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { generateImage } from "@/lib/aqua/images";
import { getCurrentDate } from "./date";
import { rollD20Mode, rollDice } from "./dice";
import type { AquaToolDefinition } from "@/lib/aqua/client";
import { AmbienceMood, PlayerStat, StageEffectKind } from "@/lib/campaign/types";
import { MUSIC_THEMES, MusicTheme } from "@/lib/campaign/musicTheme";

export const toolDefinitions: AquaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description: "Roll dice on the server (true random — you never pick or predict the number; only this tool's result counts). For checks, omit notation and pass dc + d20Mode. Difficulty lives in the DC, shifted by ability fit: a character whose special ability directly covers the task gets an easier DC (-2 to -3, they 'do it well'); a specialist task attempted WITHOUT any fitting ability/tool gets a harder DC (+2 to +5). d20Mode is almost always 'normal'. 'advantage' is RARE — reserve it for overwhelming situational dominance (target stunned/restrained/helpless, attacking a completely unaware enemy point-blank, a flawlessly prepared setup). 'disadvantage' mirrors that for severe impairment (blinded, injured, acting in chaos). Never use flat +N modifiers as a stand-in for ability fit; modifiers in notation (2d6+3) are for real damage math only.",
      parameters: {
        type: "object",
        properties: {
          notation: { type: "string", description: "Optional dice notation like 1d20, 2d6+3, or 4d8-1. Leave empty for a d20 check and use d20Mode + dc instead." },
          d20Mode: { type: "string", enum: ["normal", "advantage", "disadvantage"], description: "Default 'normal'. 'advantage'/'disadvantage' only for rare overwhelming situational edges/impairments — never merely because an ability applies." },
          dc: { type: "number", description: "Difficulty class for d20 checks: Easy 10, Medium 15, Hard 20, Very Hard 25 — after shifting for ability fit. The tool reports success/failure against it." },
          reason: { type: "string", description: "Short TV-visible reason, e.g. 'Persuasion check', 'Stealth', 'Sword strike'." },
          playerId: { type: "string", description: "Optional player id this roll is for, so the TV can show whose dice are tumbling." },
          playerName: { type: "string", description: "Optional character name for the roll, displayed on the TV." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_date",
      description: "Get the current real-world date and time.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "read_campaign_file",
      description: "Read a text file from this campaign's safe storage folder.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string", description: "Relative path like notes.md or memory/npcs.md." } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_campaign_file",
        description: "Write notes or memory to a text file in this campaign's safe storage folder. For quest_log.md, write only current active player-facing objectives; never include hidden win/loss conditions, future twists, or full story arcs.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_campaign_state",
      description: "Update the TV scene, display events, per-player controller actions, player inventory, abilities, portraits, notes, or long-term memory.",
      parameters: {
        type: "object",
        properties: {
          currentScene: { type: "string" },
          overview: { type: "string", description: "Brief TV overview of the current situation. Do not include controller choices here." },
          memory: { type: "string" },
          currentImageUrl: { type: "string", description: "Set the current TV background scene by specifying its URL. Use this to cycle back to a previously generated background URL from the context instead of calling generate_image." },
          displayEvents: {
            type: "array",
            description: "AVOID for story: narration and dialogue belong ONLY in your final JSON story[] — anything sent here AND in story[] plays twice on the TV. Use only for rare mid-turn system notices.",
            items: {
              type: "object",
              required: ["type", "content"],
              properties: {
                type: { type: "string", enum: ["narration", "dialogue", "playerAction", "scene", "system"] },
                speaker: { type: "string", description: "Narrator, NPC name, or player character name." },
                playerId: { type: "string" },
                content: { type: "string", description: "TV-visible content. Never include Suggested Actions lists or dice results (the TV already animates rolls)." }
              }
            }
          },
          suggestedActions: {
            type: "array",
            description: "Legacy shared actions. Prefer playerActions for phone controllers.",
            items: {
              type: "object",
              required: ["title", "prompt"],
              properties: {
                title: { type: "string", description: "Short visible label shown on the player's phone." },
                prompt: { type: "string", description: "Detailed action prompt sent to the DM if the player taps this choice." }
              }
            }
          },
          partyActions: {
            type: "array",
            description: "Optional shared actions shown on every phone.",
            items: {
              type: "object",
              required: ["title", "prompt"],
              properties: {
                title: { type: "string" },
                prompt: { type: "string" }
              }
            }
          },
          playerActions: {
            type: "array",
            description: "Per-player phone controller buttons. Use playerId from context.",
            items: {
              type: "object",
              required: ["playerId", "actions"],
              properties: {
                playerId: { type: "string" },
                actions: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["title", "prompt"],
                    properties: {
                      title: { type: "string", description: "Short button label shown only on that player's phone." },
                      prompt: { type: "string", description: "Detailed hidden prompt sent if the player taps this choice." }
                    }
                  }
                }
              }
            }
          },
          playerUpdates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                playerId: { type: "string" },
                playerName: { type: "string" },
                inventory: { type: "array", items: { type: "string" } },
                abilities: { type: "array", items: { type: "string" } },
                notes: { type: "string" },
                characterName: { type: "string" },
                status: { type: "string" },
                portraitUrl: { type: "string" },
                portraitPrompt: { type: "string" },
                color: { type: "string", description: "Color name or hex code (e.g. 'orange', '#00ffcc') for dialogue and cards." }
              }
            }
          },
          npcUpdates: {
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                portraitUrl: { type: "string" },
                status: { type: "string" },
                color: { type: "string", description: "Color name or hex code (e.g. 'red', '#ff4444') for dialogue and cards." },
                inventory: { type: "array", items: { type: "string" } },
                abilities: { type: "array", items: { type: "string" } },
                stats: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["name", "value", "maxValue"],
                    properties: {
                      name: { type: "string" },
                      value: { type: "number" },
                      maxValue: { type: "number" },
                      color: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_ambience",
      description: "Set the TV's living atmosphere: particle weather, color grade, fog, and music bias. Call this when the emotional register of the scene changes (entering combat, uncovering a mystery, victory, grief, safety). Use sparingly - once per meaningful shift, not every turn.",
      parameters: {
        type: "object",
        required: ["mood"],
        properties: {
          mood: { type: "string", enum: ["calm", "tense", "battle", "mystery", "dread", "triumph", "wonder", "somber"], description: "Emotional register of the current scene." },
          intensity: { type: "number", description: "0.0 to 1.0 - how hard the TV leans into the mood. Default 0.6." },
          note: { type: "string", description: "Optional short sensory flavor, e.g. 'rain hammers the tin roof'. May be shown faintly on the TV." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_theme",
      description: "Choose the campaign's musical score flavor. Call this EXACTLY ONCE, on the opening turn (the 'Start the couch campaign now.' beat), right after you know the world's genre. It fixes which background-music shelf plays for the whole saga — the atmosphere moods you set later (calm/tense/battle…) all draw from this shelf. Pick the theme that best fits the premise's genre and era. Do not call it again on later turns unless the genre fundamentally transforms.",
      parameters: {
        type: "object",
        required: ["theme"],
        properties: {
          theme: { type: "string", enum: [...MUSIC_THEMES], description: "The score flavor. fantasy = swords/magic/medieval; scifi = space/cyberpunk/futuristic; horror = dread/undead/eldritch; noir = detective/1930s-40s/hardboiled; modern = spy/thriller/heist/present-day; western = frontier/cowboys/wild west. Choose the closest fit for the campaign's genre." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "trigger_effect",
      description: "Fire a one-shot cinematic effect on the TV for a dramatic beat: an explosion (shake+flash), a spell discharge (flash/embers), creeping dread (darkness/heartbeat), weather (rain/snow/fog). Use for punctuation on big moments only.",
      parameters: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"] },
          strength: { type: "number", description: "0.0 to 1.0 impact strength. Default 0.6." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate a cinematic scene background, a player portrait, or an NPC portrait. Scene images become the TV backdrop; portraits attach to the player (playerId) or NPC (npcName) they belong to.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description: "The detailed prompt for the image generator. IMPORTANT: The image generator is a text-to-image model and has NO knowledge of character names, specific campaigns, or in-game lore. Do NOT just pass a character's name like 'Agent Bravo' or 'Steve'. Instead, you MUST write a highly descriptive prompt describing their physical appearance, face features, gender, age, clothing, posture, and environmental style in detail (e.g. 'A close-up portrait of a rugged 35-year-old male secret agent, short dark hair, wearing a black trench coat, dark dramatic alleyway background, cinematic lighting, 8k resolution')."
          },
          kind: { type: "string", enum: ["scene", "portrait"] },
          playerId: { type: "string", description: "For a PLAYER portrait: the player's id." },
          npcName: { type: "string", description: "For an NPC/monster portrait: the NPC's exact name. The portrait is attached to that NPC automatically (the NPC is created if it doesn't exist yet)." }
        }
      }
    }
  }
];

export async function runTool(campaignId: string, name: string, rawArgs: string) {
  try {
    const args = parseArgs(rawArgs);

  if (name === "roll_dice") {
    const mode = args.d20Mode as "normal" | "advantage" | "disadvantage" | undefined;
    const roll = mode && !args.notation ? rollD20Mode(mode) : rollDice(String(args.notation || "1d20"));
    const campaign = await getCampaign(campaignId);
    const reason = String(args.reason || "Dice roll");
    const playerId = typeof args.playerId === "string" ? args.playerId : undefined;

    // Judge the check server-side so the narrator can't fudge the outcome.
    const dcRaw = Number(args.dc);
    const dc = Number.isFinite(dcRaw) && dcRaw > 0 ? Math.round(dcRaw) : undefined;
    const isD20Check = roll.notation.toLowerCase().startsWith("1d20") || !!mode;
    const natural = isD20Check ? roll.total - roll.modifier : undefined;
    let outcome: "critical-success" | "success" | "failure" | "critical-failure" | undefined;
    if (isD20Check) {
      if (natural === 20) outcome = "critical-success";
      else if (natural === 1) outcome = "critical-failure";
      else if (dc !== undefined) outcome = roll.total >= dc ? "success" : "failure";
    }

    const rawSpeaker = typeof args.playerName === "string" && args.playerName.trim()
      ? args.playerName.trim()
      : undefined;
    let speaker = rawSpeaker;
    if (playerId && !speaker) {
      const p = campaign.players.find((pl) => pl.id === playerId);
      if (p) speaker = p.characterName || p.name;
    }
    safePushDisplayEvent(campaign, {
      type: "dice",
      speaker: speaker || "Dice",
      playerId,
      content: reason,
      dice: { ...roll, reason, d20Mode: mode, dc, outcome }
    });
    await saveCampaign(campaign);
    return { ...roll, reason, dc, outcome };
  }

  if (name === "get_date") return getCurrentDate();

  if (name === "set_ambience") {
    const moods: AmbienceMood[] = ["calm", "tense", "battle", "mystery", "dread", "triumph", "wonder", "somber"];
    const mood = moods.includes(args.mood as AmbienceMood) ? (args.mood as AmbienceMood) : "calm";
    const rawIntensity = Number(args.intensity ?? 0.6);
    const campaign = await getCampaign(campaignId);
    campaign.ambience = {
      mood,
      intensity: Number.isFinite(rawIntensity) ? Math.max(0, Math.min(1, rawIntensity)) : 0.6,
      note: typeof args.note === "string" && args.note.trim() ? args.note.trim() : undefined,
      updatedAt: new Date().toISOString()
    };
    await saveCampaign(campaign);
    return { ok: true, mood, intensity: campaign.ambience.intensity };
  }

  if (name === "set_theme") {
    const theme = MUSIC_THEMES.includes(args.theme as MusicTheme) ? (args.theme as MusicTheme) : null;
    if (!theme) return { error: `Unknown theme '${String(args.theme)}'. Pick one of: ${MUSIC_THEMES.join(", ")}.` };
    const campaign = await getCampaign(campaignId);
    campaign.musicTheme = theme;
    await saveCampaign(campaign);
    return { ok: true, theme };
  }

  if (name === "trigger_effect") {
    const kinds: StageEffectKind[] = ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"];
    const kind = kinds.includes(args.kind as StageEffectKind) ? (args.kind as StageEffectKind) : "embers";
    const rawStrength = Number(args.strength ?? 0.6);
    const campaign = await getCampaign(campaignId);
    pushStageEffect(campaign, kind, Number.isFinite(rawStrength) ? rawStrength : 0.6);
    await saveCampaign(campaign);
    return { ok: true, kind };
  }

  if (name === "read_campaign_file") {
    return { content: await readCampaignTextFile(campaignId, String(args.path)) };
  }

  if (name === "write_campaign_file") {
    await writeCampaignTextFile(campaignId, String(args.path), String(args.content || ""));
    return { ok: true };
  }

  if (name === "update_campaign_state") {
    const campaign = await getCampaign(campaignId);
    if (typeof args.currentScene === "string") campaign.currentScene = args.currentScene;
    if (typeof args.overview === "string") campaign.overview = stripSuggestedActions(args.overview);
    if (typeof args.memory === "string") campaign.memory = args.memory;
    if (typeof args.currentImageUrl === "string" && args.currentImageUrl.trim()) {
      campaign.currentImageUrl = args.currentImageUrl.trim();
      safePushDisplayEvent(campaign, { type: "scene", speaker: "Scene", content: "The TV scene background shifts." });
    }
    if (Array.isArray(args.displayEvents)) {
      for (const event of args.displayEvents as Array<Record<string, unknown>>) {
        const type = ["narration", "dialogue", "playerAction", "scene", "system"].includes(String(event.type)) ? String(event.type) : "narration";
        safePushDisplayEvent(campaign, {
          type: type as "narration" | "dialogue" | "playerAction" | "scene" | "system",
          speaker: typeof event.speaker === "string" ? event.speaker : undefined,
          playerId: typeof event.playerId === "string" ? event.playerId : undefined,
          content: stripSuggestedActions(String(event.content || ""))
        });
      }
    }
    if (Array.isArray(args.suggestedActions)) {
      campaign.suggestedActions = normalizeActions(args.suggestedActions).slice(0, 6);
    }
    if (Array.isArray(args.partyActions)) {
      campaign.partyActions = normalizeActions(args.partyActions).slice(0, 4);
    }
    if (Array.isArray(args.playerActions)) {
      for (const update of args.playerActions as Array<Record<string, unknown>>) {
        const playerId = String(update.playerId || "");
        if (!playerId || !campaign.players.some((player) => player.id === playerId)) continue;
        campaign.playerActions[playerId] = normalizeActions(update.actions).slice(0, 6);
      }
    }
    if (Array.isArray(args.playerUpdates)) {
      for (const update of args.playerUpdates as Array<Record<string, unknown>>) {
        const player = campaign.players.find((item) => item.id === String(update.playerId || "")) || campaign.players.find((item) => item.name.toLowerCase() === String(update.playerName || "").toLowerCase());
        if (!player) continue;
        if (Array.isArray(update.inventory)) player.inventory = update.inventory.map(String);
        if (Array.isArray(update.abilities)) player.abilities = update.abilities.map(String);
        if (typeof update.notes === "string") player.notes = update.notes;
        if (typeof update.characterName === "string") player.characterName = update.characterName;
        if (typeof update.status === "string") player.status = update.status;
        if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) player.portraitUrl = update.portraitUrl;
        if (typeof update.portraitPrompt === "string") player.portraitPrompt = update.portraitPrompt;
        if (typeof update.color === "string") player.color = update.color;
        if (Array.isArray(update.stats)) {
          player.stats = mergeStats(player.stats, update.stats);
        }
      }
    }
    if (Array.isArray(args.npcUpdates)) {
      for (const update of args.npcUpdates as Array<Record<string, any>>) {
        let char = campaign.storyCharacters.find((c) => c.id === String(update.id || "")) ||
                   (update.renameFrom && campaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.renameFrom).toLowerCase())) ||
                   campaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.name || "").toLowerCase());
        if (char) {
          if (typeof update.name === "string") char.name = update.name;
          if (typeof update.description === "string") char.description = update.description;
          if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) char.portraitUrl = update.portraitUrl;
          if (typeof update.status === "string") char.status = update.status;
          if (typeof update.color === "string") char.color = update.color;
          if (Array.isArray(update.inventory)) char.inventory = update.inventory.map(String);
          if (Array.isArray(update.abilities)) char.abilities = update.abilities.map(String);
          if (Array.isArray(update.stats)) {
            char.stats = mergeStats(char.stats, update.stats);
          }
        } else {
          campaign.storyCharacters.push({
            id: String(update.id || createId("character")),
            name: String(update.name || "NPC"),
            description: String(update.description || ""),
            portraitUrl: isValidImageUrl(update.portraitUrl) ? update.portraitUrl : undefined,
            status: update.status,
            color: update.color,
            inventory: Array.isArray(update.inventory) ? update.inventory.map(String) : [],
            abilities: Array.isArray(update.abilities) ? update.abilities.map(String) : [],
            stats: Array.isArray(update.stats) ? mergeStats([], update.stats) : []
          });
        }
      }
    }
    await saveCampaign(campaign);
    return { ok: true };
  }

  if (name === "generate_image") {
    const image = await generateImage(String(args.prompt));
    const campaign = await getCampaign(campaignId);
    if (args.kind === "portrait") {
      const playerIdArg = String(args.playerId || "");
      const player = campaign.players.find((item) => item.id === playerIdArg) ||
                     campaign.players.find((item) => (item.characterName || item.name).toLowerCase() === playerIdArg.toLowerCase());
      const npcName = typeof args.npcName === "string" ? args.npcName.trim() : "";

      if (player) {
        const localUrl = await downloadAndSaveImage(campaignId, image.url, "players", player.id);
        player.portraitUrl = localUrl;
        player.portraitPrompt = image.prompt;

        if (!campaign.portraits) campaign.portraits = [];
        campaign.portraits.push({
          id: createId("portrait"),
          url: localUrl,
          prompt: image.prompt,
          characterName: player.characterName || player.name,
          createdAt: new Date().toISOString()
        });

        await saveCampaign(campaign);
        return { playerId: player.id, url: localUrl, prompt: image.prompt };
      }

      if (npcName) {
        let npc = campaign.storyCharacters.find((c) => c.name.toLowerCase() === npcName.toLowerCase());
        if (!npc) {
          npc = {
            id: createId("character"),
            name: npcName,
            description: "",
            inventory: [],
            abilities: [],
            stats: []
          };
          campaign.storyCharacters.push(npc);
        }
        const localUrl = await downloadAndSaveImage(campaignId, image.url, "npcs", npc.id);
        npc.portraitUrl = localUrl;

        if (!campaign.portraits) campaign.portraits = [];
        campaign.portraits.push({
          id: createId("portrait"),
          url: localUrl,
          prompt: image.prompt,
          characterName: npc.name,
          createdAt: new Date().toISOString()
        });

        await saveCampaign(campaign);
        return { npcId: npc.id, npcName: npc.name, url: localUrl, prompt: image.prompt };
      }

      throw new Error("Portraits need a target: pass playerId for a player, or npcName for an NPC/monster.");
    }
    
    const localUrl = await downloadAndSaveImage(campaignId, image.url, "backgrounds");
    const entry = { id: createId("image"), url: localUrl, prompt: image.prompt, createdAt: new Date().toISOString() };
    campaign.images.push(entry);
    campaign.currentImageUrl = entry.url;
    safePushDisplayEvent(campaign, { type: "scene", speaker: "Scene", content: "The TV scene background shifts." });
    await saveCampaign(campaign);
    return entry;
  }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err: any) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Tool Error] Tool ${name} failed:`, err);
    await logCampaignDebug(campaignId, `[Tool Error] Tool ${name} failed: ${errorMsg}`);
    return { error: `Tool ${name} failed: ${errorMsg}` };
  }
}

function normalizeActions(actions: unknown): Array<{ title: string; prompt: string }> {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => {
    if (typeof action === "string") return { title: action, prompt: action };
    const item = action as Record<string, unknown>;
    return { title: String(item.title || item.prompt || "Act"), prompt: String(item.prompt || item.title || "Act") };
  });
}

function stripSuggestedActions(content: string) {
  return content.replace(/\n?\*\*Suggested Actions:\*\*[\s\S]*$/i, "").trim();
}

function parseArgs(rawArgs: any) {
  if (!rawArgs) return {} as Record<string, unknown>;
  if (typeof rawArgs === "object") return rawArgs;
  try {
    return JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    return { value: rawArgs };
  }
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
