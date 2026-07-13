import { getCampaign, readCampaignTextFile, saveCampaign, writeCampaignTextFile, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, pushStageEffect, endCampaign } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { generateImage } from "@/lib/aqua/images";
import { getCurrentDate } from "./date";
import { rollD20Mode, rollDice, judgeD20Outcome, difficultyDcBias } from "./dice";
import type { AquaToolDefinition } from "@/lib/aqua/client";
import { AmbienceMood, PlayerStat, StageEffectKind, StoryCharacter } from "@/lib/campaign/types";
import { MUSIC_THEMES, MusicTheme } from "@/lib/campaign/musicTheme";
import { startCombat, endCombat } from "@/lib/campaign/turns";

export const toolDefinitions: AquaToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description: "Roll dice on the server (true random — you never pick or predict the number; only this tool's result counts). For checks, omit notation and pass dc + d20Mode. Difficulty lives in the DC, shifted by ability fit AND campaign difficulty. Outcome spectrum: critical-success / strong-success / success / partial-success / failure / hard-failure / critical-failure. For ENEMY/NPC rolls set isNpc true and pass playerName as the NPC name so the TV dice theater shows them. Chain multiple rolls in one turn when combat or contested actions need it.",
      parameters: {
        type: "object",
        properties: {
          notation: { type: "string", description: "Optional dice notation like 1d20, 2d6+3, or 4d8-1. Leave empty for a d20 check and use d20Mode + dc instead." },
          d20Mode: { type: "string", enum: ["normal", "advantage", "disadvantage"], description: "Default 'normal'. 'advantage'/'disadvantage' only for rare overwhelming situational edges/impairments — never merely because an ability applies." },
          dc: { type: "number", description: "Base difficulty class for d20 checks BEFORE campaign difficulty bias (Easy 10, Medium 15, Hard 20, Very Hard 25), after ability fit. Server adds campaign difficulty bias (easy -2 / medium 0 / hard +2 / insane +4). Use for attacks-to-hit, escape, stealth, persuasion, saves — not only skill checks." },
          reason: { type: "string", description: "Short TV-visible reason, e.g. 'Persuasion check', 'Stealth', 'Sword strike', 'Guard attack'." },
          playerId: { type: "string", description: "Optional player id this roll is for, so the TV can show whose dice are tumbling." },
          playerName: { type: "string", description: "Character or NPC name for the roll, displayed on the TV." },
          isNpc: { type: "boolean", description: "True when this roll is for an NPC/enemy (not a player). Shows full dice theater for enemies too." }
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
      description: "Update the TV scene, display events, per-player controller actions, player inventory, abilities, portraits, notes, stats, or long-term memory.",
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
                status: { type: "string", description: "Free-text flavor line (e.g. 'Bleeding', 'Ready')." },
                conditions: { type: "array", items: { type: "string" }, description: "Structured conditions, e.g. ['stunned'] or ['dead']. Drives who can act." },
                canAct: { type: "boolean", description: "Set false when the player is stunned/incapacitated/dead and cannot act; true to restore. Their controller is hard-locked while false." },
                portraitUrl: { type: "string" },
                portraitPrompt: { type: "string" },
                color: { type: "string", description: "Color name or hex code (e.g. 'orange', '#00ffcc') for dialogue and cards." },
                stats: {
                  type: "array",
                  description: "Update HP and other tracked stats. ALWAYS apply damage/healing here after combat or harm. maxValue optional (kept if omitted).",
                  items: {
                    type: "object",
                    required: ["name", "value"],
                    properties: {
                      name: { type: "string" },
                      value: { type: "number" },
                      maxValue: { type: "number", description: "Optional — omit to keep the existing max." },
                      color: { type: "string" }
                    }
                  }
                }
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
                renameFrom: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                portraitUrl: { type: "string" },
                status: { type: "string" },
                conditions: { type: "array", items: { type: "string" }, description: "Structured conditions, e.g. ['stunned']." },
                canAct: { type: "boolean", description: "False when this enemy/NPC cannot act (stunned/downed/dead)." },
                isGroup: { type: "boolean", description: "TRUE only for faceless rank-and-file pooled into one card (e.g. 'Gang Members', 'Guards'). NEVER for a named/role NPC (leader, lieutenant) — those are their own card." },
                count: { type: "number", description: "For a group: how many are still standing. Decrement as they fall." },
                maxCount: { type: "number", description: "For a group: the size at first encounter (for the 'N left / M' display)." },
                color: { type: "string", description: "Color name or hex code (e.g. 'red', '#ff4444') for dialogue and cards." },
                inventory: { type: "array", items: { type: "string" } },
                abilities: { type: "array", items: { type: "string" } },
                stats: {
                  type: "array",
                  description: "Enemy/NPC HP and stats. Seed HP the moment a foe appears so hits have something to subtract. maxValue optional (kept if omitted).",
                  items: {
                    type: "object",
                    required: ["name", "value"],
                    properties: {
                      name: { type: "string" },
                      value: { type: "number" },
                      maxValue: { type: "number", description: "Optional — omit to keep the existing max." },
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
          mood: { type: "string", enum: ["calm", "tense", "adrenaline", "battle", "boss", "mystery", "dread", "triumph", "wonder", "somber", "outro"], description: "Emotional register of the current scene. 'battle' = ordinary combat encounters; 'boss' = climactic showdowns against a major villain or endgame threat; 'adrenaline' = high-energy excitement that is NOT combat (chases, escapes, heists, races against time). Use 'outro' only when ending the campaign (end_campaign also sets it)." },
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
      description: "Choose the campaign's musical score shelf (fantasy/scifi/horror/noir/modern/western/postapoc). Call EXACTLY ONCE on the opening turn when offered; never mid-campaign.",
      parameters: {
        type: "object",
        required: ["theme"],
        properties: {
          theme: { type: "string", enum: ["fantasy", "scifi", "horror", "noir", "modern", "western", "postapoc"] }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "trigger_effect",
      description: "Fire a cinematic effect on the TV for a dramatic beat: an explosion (shake+flash), a spell discharge (flash/embers), creeping dread (darkness/heartbeat), weather (rain/snow/fog). Use for punctuation on big moments. Can repeat for multi-hit impacts.",
      parameters: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"] },
          strength: { type: "number", description: "0.0 to 1.0 impact strength. Default 0.6." },
          repeat: { type: "number", description: "How many times to fire (1-8). Default 1. Use 2-3 for multi-hit impacts." },
          delayMs: { type: "number", description: "Delay in ms between repeats (0-5000). Default 0." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "end_campaign",
      description: "End the campaign NOW with a decisive result. Call when the story reaches a close — party dead, villain defeated, escape, stalemate, bittersweet resolution, or a deliberate cliffhanger. Can end EARLY (TPK, total failure, sudden victory). Sets status to completed, plays the cinematic outro on the TV, and clears controller actions. After calling this, write a short final story[] epilogue then stop offering player choices.",
      parameters: {
        type: "object",
        required: ["kind", "title", "summary"],
        properties: {
          kind: { type: "string", enum: ["victory", "defeat", "bittersweet", "escape", "draw", "cliffhanger"], description: "victory = party won; defeat = party lost/dead/failed; bittersweet = mixed; escape = survived by fleeing; draw = stalemate, neither side prevailed; cliffhanger = the story cuts off mid-breath, deliberately unresolved (use for season-finale style stops)." },
          title: { type: "string", description: "Short credits title, e.g. 'The Fat Man Falls' or 'Veridia Burns'." },
          summary: { type: "string", description: "1-3 sentence epilogue shown on the outro. For cliffhangers, end it on the unresolved question." },
          highlights: { type: "array", items: { type: "string" }, description: "Optional bullet lines for credits (key moments, final fates)." },
          stats: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "value"],
              properties: {
                label: { type: "string", description: "Stat name, e.g. 'Dragons Slain', 'Lies Told', 'Gold Squandered'." },
                value: { type: "string", description: "Stat value, e.g. '3', 'All of it', 'One too many'." }
              }
            },
            description: "Optional 3-6 campaign statistics for the outro's stats board. Mix real tallies (battles won, NPCs met) with flavorful ones (curses ignored, taverns wrecked). Values can be numbers or short witty phrases."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_combat",
      description: "Enter SEQUENTIAL COMBAT: players act one at a time in initiative order, then the enemies act, then the round repeats. Call this when a fight begins. Outside combat the table is in free 'exploration' where everyone acts at once. Only the active player's controller is unlocked during combat.",
      parameters: {
        type: "object",
        properties: {
          order: {
            type: "array",
            items: { type: "string" },
            description: "Optional initiative order as player names or ids. Omit to use the current party order. Enemies act automatically after the last player each round."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "end_combat",
      description: "Leave combat and return to free exploration (everyone acts simultaneously again). Call when the fight is over — enemies dead, fled, or the party disengaged.",
      parameters: { type: "object", properties: {} }
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
          kind: { type: "string", enum: ["scene", "portrait"], description: "scene = TV backdrop; portrait = character face." },
          playerId: { type: "string", description: "For portraits of a player character." },
          npcName: { type: "string", description: "For portraits of an NPC/monster — attaches to that story character." }
        }
      }
    }
  }
];

export async function runTool(campaignId: string, name: string, args: Record<string, unknown>) {
  try {
    if (name === "roll_dice") {
      const mode = args.d20Mode as "normal" | "advantage" | "disadvantage" | undefined;
      const roll = mode && !args.notation ? rollD20Mode(mode) : rollDice(String(args.notation || "1d20"));
      const campaign = await getCampaign(campaignId);
      const reason = String(args.reason || "Dice roll");
      const playerId = typeof args.playerId === "string" ? args.playerId : undefined;
      const isNpc = args.isNpc === true || args.isNpc === "true";

      const dcRaw = Number(args.dc);
      let dc = Number.isFinite(dcRaw) && dcRaw > 0 ? Math.round(dcRaw) : undefined;
      // Server-side campaign difficulty bias so combat/escape/skill DCs always scale.
      if (dc !== undefined) {
        dc = Math.max(1, dc + difficultyDcBias(campaign.difficulty));
      }
      const isD20Check = roll.notation.toLowerCase().startsWith("1d20") || !!mode;
      const natural = isD20Check ? roll.total - roll.modifier : undefined;
      const judged = isD20Check
        ? judgeD20Outcome({ total: roll.total, natural, dc, difficulty: campaign.difficulty })
        : {};
      const outcome = judged.outcome;
      const margin = judged.margin;

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
        speaker: speaker || (isNpc ? "Enemy" : "Dice"),
        playerId: isNpc ? undefined : playerId,
        content: reason,
        dice: { ...roll, reason, d20Mode: mode, dc, outcome, margin, isNpc }
      });
      await saveCampaign(campaign);
      return { ...roll, reason, dc, outcome, margin, isNpc };
    }

    if (name === "get_date") return getCurrentDate();

    if (name === "start_combat") {
      const campaign = await getCampaign(campaignId);
      const rawOrder = Array.isArray(args.order) ? (args.order as unknown[]).map(String) : undefined;
      const ids = rawOrder
        ?.map((tok) => {
          const p = campaign.players.find(
            (pl) => pl.id === tok || (pl.characterName || pl.name).toLowerCase() === tok.toLowerCase()
          );
          return p?.id;
        })
        .filter((x): x is string => !!x);
      startCombat(campaign, ids && ids.length ? ids : undefined);
      await saveCampaign(campaign);
      return { ok: true, mode: "combat", order: campaign.turnState?.order, activeId: campaign.turnState?.activeId };
    }

    if (name === "end_combat") {
      const campaign = await getCampaign(campaignId);
      endCombat(campaign);
      await saveCampaign(campaign);
      return { ok: true, mode: "exploration" };
    }

    if (name === "set_ambience") {
      const moods: AmbienceMood[] = ["calm", "tense", "adrenaline", "battle", "boss", "mystery", "dread", "triumph", "wonder", "somber", "outro"];
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
      const rawRepeat = Number(args.repeat ?? 1);
      const rawDelay = Number(args.delayMs ?? 0);
      const campaign = await getCampaign(campaignId);
      pushStageEffect(campaign, kind, Number.isFinite(rawStrength) ? rawStrength : 0.6, {
        repeat: Number.isFinite(rawRepeat) ? rawRepeat : 1,
        delayMs: Number.isFinite(rawDelay) ? rawDelay : 0
      });
      await saveCampaign(campaign);
      return { ok: true, kind, repeat: Math.max(1, Math.round(rawRepeat) || 1) };
    }

    if (name === "end_campaign") {
      const campaign = await getCampaign(campaignId);
      if (campaign.status === "completed") {
        return { ok: true, alreadyEnded: true, ending: campaign.ending };
      }
      endCampaign(campaign, {
        kind: String(args.kind || "bittersweet"),
        title: String(args.title || "The End"),
        summary: String(args.summary || "The saga closes."),
        highlights: Array.isArray(args.highlights) ? (args.highlights as unknown[]).map(String) : undefined,
        stats: Array.isArray(args.stats)
          ? (args.stats as Array<Record<string, unknown>>).map((stat) => ({
              label: String(stat?.label || ""),
              value: String(stat?.value ?? "")
            }))
          : undefined
      });
      await saveCampaign(campaign);
      return { ok: true, ending: campaign.ending };
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
          const type = ["narration", "dialogue", "playerAction", "scene", "system"].includes(String(event.type))
            ? String(event.type)
            : "narration";
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
          const player =
            campaign.players.find((item) => item.id === String(update.playerId || "")) ||
            campaign.players.find((item) => item.name.toLowerCase() === String(update.playerName || "").toLowerCase());
          if (!player) continue;
          if (Array.isArray(update.inventory)) player.inventory = update.inventory.map(String);
          if (Array.isArray(update.abilities)) player.abilities = update.abilities.map(String);
          if (typeof update.notes === "string") player.notes = update.notes;
          if (typeof update.characterName === "string") player.characterName = update.characterName;
          if (typeof update.status === "string") player.status = update.status;
          if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) player.portraitUrl = update.portraitUrl;
          if (typeof update.portraitPrompt === "string") player.portraitPrompt = update.portraitPrompt;
          if (typeof update.color === "string") player.color = update.color;
          applyConditionFields(player, update);
          if (Array.isArray(update.stats)) {
            player.stats = mergeStats(player.stats, update.stats);
          }
        }
      }
      if (Array.isArray(args.npcUpdates)) {
        for (const update of args.npcUpdates as Array<Record<string, any>>) {
          let char =
            campaign.storyCharacters.find((c) => c.id === String(update.id || "")) ||
            (update.renameFrom &&
              campaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.renameFrom).toLowerCase())) ||
            campaign.storyCharacters.find((c) => c.name.toLowerCase() === String(update.name || "").toLowerCase());
          if (char) {
            if (typeof update.name === "string") char.name = update.name;
            if (typeof update.description === "string") char.description = update.description;
            if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) char.portraitUrl = update.portraitUrl;
            if (typeof update.status === "string") char.status = update.status;
            if (typeof update.color === "string") char.color = update.color;
            if (Array.isArray(update.inventory)) char.inventory = update.inventory.map(String);
            if (Array.isArray(update.abilities)) char.abilities = update.abilities.map(String);
            applyNpcGroupFields(char, update);
            applyConditionFields(char, update);
            if (Array.isArray(update.stats)) {
              char.stats = mergeStats(char.stats, update.stats);
            }
          } else {
            const npc: StoryCharacter = {
              id: String(update.id || createId("character")),
              name: String(update.name || "NPC"),
              description: String(update.description || ""),
              portraitUrl: isValidImageUrl(update.portraitUrl) ? update.portraitUrl : undefined,
              status: update.status,
              color: update.color,
              inventory: Array.isArray(update.inventory) ? update.inventory.map(String) : [],
              abilities: Array.isArray(update.abilities) ? update.abilities.map(String) : [],
              stats: Array.isArray(update.stats) ? mergeStats([], update.stats) : []
            };
            applyNpcGroupFields(npc, update);
            applyConditionFields(npc, update);
            campaign.storyCharacters.push(npc);
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
        const player =
          campaign.players.find((item) => item.id === playerIdArg) ||
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
  return actions
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      title: String(item.title || "Act").slice(0, 48),
      prompt: String(item.prompt || item.title || "I act.")
    }))
    .filter((item) => item.title && item.prompt);
}

function stripSuggestedActions(text: string) {
  return text
    .replace(/\n?\s*Suggested Actions?:[\s\S]*$/i, "")
    .replace(/\n?\s*Controller choices?:[\s\S]*$/i, "")
    .trim();
}

/** Apply group/mob fields (count, maxCount, isGroup) to an NPC from an update. */
export function applyNpcGroupFields(char: StoryCharacter, update: Record<string, any>) {
  if (typeof update.isGroup === "boolean") char.isGroup = update.isGroup;
  const count = Number(update.count);
  if (Number.isFinite(count) && count >= 0) char.count = Math.round(count);
  const maxCount = Number(update.maxCount);
  if (Number.isFinite(maxCount) && maxCount >= 0) char.maxCount = Math.round(maxCount);
  // Seed maxCount from the first count we see so "N left / M" reads correctly.
  if (char.count !== undefined && char.maxCount === undefined) char.maxCount = char.count;
  // A count that isn't exactly 1 implies a group unless told otherwise.
  if (char.isGroup === undefined && char.count !== undefined && char.count !== 1) char.isGroup = true;
}

/** Apply structured combat conditions + the canAct gate to a player or NPC. */
export function applyConditionFields(entity: { conditions?: string[]; canAct?: boolean }, update: Record<string, any>) {
  if (Array.isArray(update.conditions)) entity.conditions = update.conditions.map(String);
  if (typeof update.canAct === "boolean") entity.canAct = update.canAct;
}

function mergeStats(currentStats: PlayerStat[] | undefined, incomingStats: any[]): PlayerStat[] {
  const merged = Array.isArray(currentStats) ? [...currentStats] : [];
  for (const s of incomingStats) {
    if (!s || typeof s !== "object") continue;
    const name = String(s.name || "").trim();
    if (!name) continue;
    const value = Number(s.value);
    if (!Number.isFinite(value)) continue; // value is the one field we truly need
    const incomingMax = Number(s.maxValue);
    const color = typeof s.color === "string" ? s.color : undefined;
    const idx = merged.findIndex((stat) => stat.name.toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      const prev = merged[idx];
      // maxValue omitted → keep the existing max rather than dropping the stat.
      const maxValue = Number.isFinite(incomingMax) && incomingMax > 0 ? incomingMax : prev.maxValue;
      merged[idx] = { name: prev.name, value, maxValue, color: color ?? prev.color };
    } else {
      const maxValue = Number.isFinite(incomingMax) && incomingMax > 0 ? incomingMax : (value > 0 ? value : 10);
      merged.push({ name, value, maxValue, color });
    }
  }
  return merged;
}
