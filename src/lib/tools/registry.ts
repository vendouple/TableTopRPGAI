import { getCampaign, readCampaignTextFile, saveCampaign, writeCampaignTextFile, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, pushStageEffect, endCampaign, ensureLocations, getFocusedLocation, applyFocus } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { generateImage } from "@/lib/aqua/images";
import { getCurrentDate } from "./date";
import { rollD20Mode, rollDice, judgeD20Outcome, difficultyDcBias, clampD20Dc } from "./dice";
import type { AquaToolDefinition } from "@/lib/aqua/client";
import { AmbienceMood, PlayerStat, StageEffectKind, StoryCharacter } from "@/lib/campaign/types";
import type { Location as CampaignLocation } from "@/lib/campaign/types";
import { MUSIC_THEMES, MusicTheme } from "@/lib/campaign/musicTheme";
import { startCombat, endCombat, syncFocusedMirror } from "@/lib/campaign/turns";

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
                zoneId: { type: "string", description: "Move this player to a narrative zone within their current location (e.g. 'rooftop', 'street'). Use when they physically relocate within the scene." },
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
                locationId: { type: "string", description: "Move this NPC/enemy to a different tracked location (id from the locations list). New NPCs default to the party's current location automatically — only set this to introduce one elsewhere, or to move an existing one when it follows/relocates." },
                zoneId: { type: "string", description: "Move this NPC/enemy to a narrative zone within their current location." },
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
      description: "Choose the campaign's musical score shelf (fantasy/scifi/horror/noir/modern/western/postapoc). Call EXACTLY ONCE on the opening turn when offered; never mid-campaign. Match the theme to the campaign's GENRE, not to surface props: horror = haunted houses, ghosts, dread, gothic, supernatural, terror, curses; noir = detectives, 1920s-40s, mobsters, speakeasies, murder mysteries; scifi = spaceships, aliens, cyberpunk, future tech; modern = spies, hackers, contemporary thrillers; western = cowboys, frontier, saloons; postapoc = wasteland, fallout, raiders; fantasy = magic, dragons, wizards, medieval kingdoms. A Victorian haunted house is HORROR, not fantasy, even though it is set in the past. When in doubt, pick the genre that matches the THREAT and TONE, not the era.",
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
      description: "Fire a cinematic effect on the TV IMMEDIATELY (at the start of the turn), for a dramatic beat: an explosion (shake+flash), a spell discharge (flash/embers), creeping dread (darkness/heartbeat), weather (rain/snow/fog). Use for punctuation on big moments; repeat for multi-hit impacts. To instead make an effect land ON a specific line as it plays, don't use this — attach an `effect` to that story beat in narrate_turn.",
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
      description: "End the campaign NOW with a decisive result. Call when the story reaches a close — party dead, villain defeated, escape, stalemate, bittersweet resolution, or a deliberate cliffhanger. Can end EARLY (TPK, total failure, sudden victory). The MOMENT the whole party is down (every player at 0 HP / dead / dying / unconscious / incapacitated), you MUST call this the same turn — a downed party with no one able to act is a finished saga; do not keep narrating or wait for a prompt. Sets status to completed, plays the cinematic outro on the TV, and clears controller actions. After calling this, write a short final story[] epilogue then stop offering player choices.",
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
          },
          cast: {
            type: "array",
            description: "Per-player credit lines for the outro's cast reel — ONE entry per player so the ending reads like film end credits. Invent flavorful deeds from the story when exact numbers are unknown.",
            items: {
              type: "object",
              properties: {
                playerId: { type: "string", description: "The player's id (preferred) so it matches their live sheet/portrait." },
                name: { type: "string", description: "Character or player name — a fallback when you don't have the id." },
                title: { type: "string", description: "Epithet/title they earned, e.g. 'The Salt-Blind Prophet' or 'Slayer of the Fat Man'." },
                fate: { type: "string", description: "1-2 sentences: what they did across the saga and how they ended." },
                stats: {
                  type: "array",
                  description: "Optional 1-3 personal tallies for their card (kills, lies told, wounds taken).",
                  items: {
                    type: "object",
                    required: ["label", "value"],
                    properties: {
                      label: { type: "string" },
                      value: { type: "string" }
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
      name: "start_combat",
      description: "Enter SEQUENTIAL COMBAT: players act one at a time in initiative order, then the enemies act, then the round repeats. Call this when a fight begins. Outside combat the table is in free 'exploration' where everyone acts at once. Only the active player's controller is unlocked during combat.",
      parameters: {
        type: "object",
        properties: {
          order: {
            type: "array",
            items: { type: "string" },
            description: "Optional initiative order as player names or ids. Omit to use the current party order. Enemies act automatically after the last player each round."
          },
          enemyIds: {
            type: "array",
            items: { type: "string" },
            description: "Optional names or ids of the hostile NPCs fighting in THIS encounter. They're relocated to this location if they weren't already tracked here, so the TV and party roster show them correctly for the fight."
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
      name: "update_location",
      description: "Define or update a LOCATION — the authoritative contents of a place. Seed objects (items/props physically present), cover (terrain usable in combat), exits, and hazards BEFORE the players interact, so nobody can invent items or cover that isn't here. This is the ground truth: if it's not in objects/cover, it isn't in the room. Omit id to edit the current (focused) location; pass a NEW id/name to create another place (e.g. when the party splits up).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing location id to edit, or a new id to create. Omit to edit the focused location." },
          name: { type: "string", description: "Short place name, e.g. 'Relay Station Antechamber'." },
          description: { type: "string", description: "What the place looks/feels like." },
          objects: {
            type: "array",
            description: "Everything physically here — loot, interactables, props. The ONLY items that exist in this scene.",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                note: { type: "string", description: "Optional detail, e.g. 'locked', 'flickering'." },
                takeable: { type: "boolean", description: "True if a player can pick it up into inventory." },
                kind: { type: "string", enum: ["item", "container", "interactable", "obstacle", "clue", "furniture", "other"], description: "Use other for anything unusual; traits/state carry its mechanics." },
                zoneId: { type: "string", description: "Narrative zone containing this object." },
                traits: { type: "array", items: { type: "string" }, description: "Capabilities/states such as locked, readable, flammable, blocks-sight." },
                state: { type: "object", description: "Persistent small facts such as locked=true, charges=2, or contents='medkit'." }
              }
            }
          },
          zones: {
            type: "array",
            description: "Named narrative positions. Same zone = close/melee; adjacent zone = one normal move; farther zones require multiple moves or suitable range.",
            items: { type: "object", required: ["id", "name"], properties: {
              id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
              adjacentZoneIds: { type: "array", items: { type: "string" } }
            } }
          },
          connections: {
            type: "array",
            description: "Links to other tracked locations, including reinforcement time and whether voices carry.",
            items: { type: "object", required: ["destinationId"], properties: {
              destinationId: { type: "string" }, label: { type: "string" }, travelTime: { type: "string" },
              communication: { type: "string", enum: ["open", "shouting", "blocked"] }
            } }
          },
          cover: { type: "array", items: { type: "string" }, description: "Named cover / terrain features usable in combat, e.g. 'overturned server rack', 'conduit bank'." },
          exits: { type: "array", items: { type: "string" }, description: "Ways out, e.g. 'blast doors (north)', 'service duct'." },
          hazards: { type: "array", items: { type: "string" }, description: "Environmental dangers, e.g. 'live wiring', 'static field'." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "move_player",
      description: "Move one or more players to a location — use when the party splits up or someone travels somewhere else. Players in different locations act in SEPARATE turn groups and the TV intercuts between them. Create the destination first with update_location if it's new.",
      parameters: {
        type: "object",
        required: ["playerIds", "locationId"],
        properties: {
          playerIds: { type: "array", items: { type: "string" }, description: "Player names or ids to move." },
          locationId: { type: "string", description: "Destination location id (or an existing location's name)." },
          locationName: { type: "string", description: "If creating a brand-new destination, its name." }
          ,zoneId: { type: "string", description: "Optional zone in the destination where the players arrive." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "move_zone",
      description: "Move a player or NPC to a different narrative zone WITHIN their current location (no location change). Use when someone closes distance, retreats to cover, climbs to a vantage, or repositions in combat. Same zone = melee range; adjacent zone = one move; farther = multiple moves or range.",
      parameters: {
        type: "object",
        required: ["zoneId"],
        properties: {
          playerId: { type: "string", description: "Player name or id to reposition." },
          npcName: { type: "string", description: "NPC/enemy name to reposition (use this OR playerId, not both)." },
          zoneId: { type: "string", description: "Destination zone id within the combatant's current location." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "set_focus",
      description: "Cut the TV to a location — show that group's backdrop, ambience, and combatants. Use when you switch which separated group you're narrating (intercut). The backdrop and mood for that place are restored automatically.",
      parameters: {
        type: "object",
        required: ["locationId"],
        properties: { locationId: { type: "string", description: "Location id (or name) to focus the TV on." } }
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
      // A d20 tops out at 20, so a DC in the 20s is only beatable by the nat-20
      // auto-crit — effectively impossible. Pull the effective DC back into the
      // winnable range (scaled by difficulty) so every roll has a real chance.
      if (dc !== undefined && isD20Check) {
        dc = clampD20Dc(dc, campaign.difficulty, roll.modifier);
      }
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
      ensureLocations(campaign);
      const loc = getFocusedLocation(campaign);
      const rawOrder = Array.isArray(args.order) ? (args.order as unknown[]).map(String) : undefined;
      const ids = rawOrder
        ?.map((tok) => {
          const p = campaign.players.find(
            (pl) => pl.id === tok || (pl.characterName || pl.name).toLowerCase() === tok.toLowerCase()
          );
          return p?.id;
        })
        .filter((x): x is string => !!x);
      startCombat(campaign, loc, ids && ids.length ? ids : undefined);
      // Pull the declared foes into this fight's location so they show up on
      // the TV rail and party roster where the fight is actually happening,
      // instead of wherever they were last tracked.
      const rawEnemyIds = Array.isArray(args.enemyIds) ? (args.enemyIds as unknown[]).map(String) : undefined;
      const relocatedEnemies: string[] = [];
      for (const tok of rawEnemyIds || []) {
        const npc = campaign.storyCharacters.find(
          (c) => c.id === tok || c.name.toLowerCase() === tok.toLowerCase()
        );
        if (npc && npc.locationId !== loc.id) {
          npc.locationId = loc.id;
          relocatedEnemies.push(npc.name);
        }
      }
      syncFocusedMirror(campaign);
      await saveCampaign(campaign);
      return { ok: true, mode: "combat", locationId: loc.id, order: loc.turnState?.order, activeId: loc.turnState?.activeId, relocatedEnemies };
    }

    if (name === "end_combat") {
      const campaign = await getCampaign(campaignId);
      ensureLocations(campaign);
      const loc = getFocusedLocation(campaign);
      endCombat(loc);
      syncFocusedMirror(campaign);
      await saveCampaign(campaign);
      return { ok: true, mode: "exploration", locationId: loc.id };
    }

    if (name === "update_location") {
      const campaign = await getCampaign(campaignId);
      ensureLocations(campaign);
      const id = String(args.id || "").trim();
      let loc = id ? campaign.locations!.find((l) => l.id === id) : getFocusedLocation(campaign);
      if (!loc) {
        loc = {
          id: id || createId("loc"),
          name: String(args.name || "A place"),
          objects: [],
          cover: [],
          exits: [],
          createdAt: new Date().toISOString()
        };
        campaign.locations!.push(loc);
      }
      if (typeof args.name === "string" && args.name.trim()) loc.name = args.name.trim();
      if (typeof args.description === "string") loc.description = args.description;
      if (Array.isArray(args.objects)) {
        loc.objects = (args.objects as any[])
          .map((o) => {
            if (typeof o === "string") return { name: o.trim() };
            if (!o || typeof o !== "object") return null;
            const nm = String(o.name || "").trim();
            if (!nm) return null;
            return {
              name: nm,
              note: typeof o.note === "string" ? o.note : undefined,
              takeable: typeof o.takeable === "boolean" ? o.takeable : undefined,
              kind: ["item", "container", "interactable", "obstacle", "clue", "furniture", "other"].includes(o.kind) ? o.kind : undefined,
              zoneId: typeof o.zoneId === "string" ? o.zoneId : undefined,
              traits: Array.isArray(o.traits) ? o.traits.map(String).filter(Boolean).slice(0, 12) : undefined,
              state: o.state && typeof o.state === "object" && !Array.isArray(o.state) ? o.state : undefined
            };
          })
          .filter((o): o is NonNullable<typeof o> => !!o)
          .slice(0, 30);
      }
      if (Array.isArray(args.cover)) loc.cover = (args.cover as unknown[]).map(String).filter(Boolean).slice(0, 20);
      if (Array.isArray(args.exits)) loc.exits = (args.exits as unknown[]).map(String).filter(Boolean).slice(0, 20);
      if (Array.isArray(args.hazards)) loc.hazards = (args.hazards as unknown[]).map(String).filter(Boolean).slice(0, 20);
      if (Array.isArray(args.zones)) loc.zones = (args.zones as any[]).map((z) => ({ id: String(z.id || "").trim(), name: String(z.name || "").trim(), description: typeof z.description === "string" ? z.description : undefined, adjacentZoneIds: Array.isArray(z.adjacentZoneIds) ? z.adjacentZoneIds.map(String).filter(Boolean) : [] })).filter((z) => z.id && z.name).slice(0, 20);
      if (Array.isArray(args.connections)) loc.connections = (args.connections as any[]).map((c) => ({ destinationId: String(c.destinationId || "").trim(), label: typeof c.label === "string" ? c.label : undefined, travelTime: typeof c.travelTime === "string" ? c.travelTime : undefined, communication: ["open", "shouting", "blocked"].includes(c.communication) ? c.communication : undefined })).filter((c) => c.destinationId).slice(0, 20);
      await saveCampaign(campaign);
      return { ok: true, id: loc.id, name: loc.name };
    }

    if (name === "move_player") {
      const campaign = await getCampaign(campaignId);
      ensureLocations(campaign);
      const ids = Array.isArray(args.playerIds) ? (args.playerIds as unknown[]).map(String) : [];
      const locKey = String(args.locationId || "").trim();
      let loc =
        campaign.locations!.find((l) => l.id === locKey) ||
        campaign.locations!.find((l) => l.name.toLowerCase() === locKey.toLowerCase());
      if (!loc) {
        loc = {
          id: locKey || createId("loc"),
          name: String(args.locationName || locKey || "A place"),
          objects: [],
          cover: [],
          exits: [],
          createdAt: new Date().toISOString()
        };
        campaign.locations!.push(loc);
      }
      const moved: string[] = [];
      for (const tok of ids) {
        const p = campaign.players.find(
          (pl) => pl.id === tok || (pl.characterName || pl.name).toLowerCase() === tok.toLowerCase()
        );
        if (!p) continue;
        // Drop any stale lock-in from their previous location before moving.
        for (const other of campaign.locations!) {
          if (other.id !== loc.id && other.pendingActions) delete other.pendingActions[p.id];
        }
        p.locationId = loc.id;
        p.zoneId = typeof args.zoneId === "string" && args.zoneId.trim() ? args.zoneId.trim() : undefined;
        moved.push(p.characterName || p.name);
      }
      syncFocusedMirror(campaign);
      await saveCampaign(campaign);
      return { ok: true, locationId: loc.id, name: loc.name, moved };
    }

    if (name === "move_zone") {
      const campaign = await getCampaign(campaignId);
      ensureLocations(campaign);
      const zoneId = String(args.zoneId || "").trim();
      if (!zoneId) return { error: "zoneId is required." };
      const playerTok = typeof args.playerId === "string" ? String(args.playerId).trim() : "";
      const npcTok = typeof args.npcName === "string" ? String(args.npcName).trim() : "";
      if (!playerTok && !npcTok) return { error: "Provide playerId or npcName." };

      let targetLoc: CampaignLocation | undefined;
      let movedName: string | undefined;
      if (playerTok) {
        const p = campaign.players.find((pl) => pl.id === playerTok || (pl.characterName || pl.name).toLowerCase() === playerTok.toLowerCase());
        if (!p) return { error: `No player '${playerTok}'.` };
        targetLoc = campaign.locations!.find((l) => l.id === p.locationId);
        p.zoneId = zoneId;
        movedName = p.characterName || p.name;
      } else {
        const c = campaign.storyCharacters.find((ch) => ch.name.toLowerCase() === npcTok!.toLowerCase());
        if (!c) return { error: `No NPC '${npcTok}'.` };
        targetLoc = campaign.locations!.find((l) => l.id === c.locationId);
        c.zoneId = zoneId;
        movedName = c.name;
      }
      const zoneExists = targetLoc?.zones?.some((z) => z.id === zoneId);
      if (targetLoc && !zoneExists) {
        // Not a hard error — the DM may reference a zone it forgot to define.
        // Auto-create a minimal zone so the position is still tracked.
        targetLoc.zones = targetLoc.zones || [];
        targetLoc.zones.push({ id: zoneId, name: zoneId, adjacentZoneIds: [] });
      }
      await saveCampaign(campaign);
      return { ok: true, zoneId, locationId: targetLoc?.id, moved: movedName };
    }

    if (name === "set_focus") {
      const campaign = await getCampaign(campaignId);
      ensureLocations(campaign);
      const locKey = String(args.locationId || "").trim();
      const loc =
        campaign.locations!.find((l) => l.id === locKey) ||
        campaign.locations!.find((l) => l.name.toLowerCase() === locKey.toLowerCase());
      if (!loc) return { error: `No location '${locKey}'. Create it with update_location first.` };
      applyFocus(campaign, loc);
      await saveCampaign(campaign);
      return { ok: true, focusedLocationId: loc.id, name: loc.name };
    }

    if (name === "set_ambience") {
      const moods: AmbienceMood[] = ["calm", "tense", "adrenaline", "battle", "boss", "mystery", "dread", "triumph", "wonder", "somber", "outro"];
      // An invalid mood used to silently become "calm" — the DM believed it
      // had set "battle" while the TV played tavern music. Tell it instead.
      const rawMood = String(args.mood || "").trim().toLowerCase();
      if (!moods.includes(rawMood as AmbienceMood)) {
        return { error: `Unknown mood '${String(args.mood)}'. Pick one of: ${moods.join(", ")}.` };
      }
      const mood = rawMood as AmbienceMood;
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
      // Same honesty as set_ambience: an unknown kind used to silently fire
      // "embers" — surface it so the model can correct itself.
      const rawKind = String(args.kind || "").trim().toLowerCase();
      if (!kinds.includes(rawKind as StageEffectKind)) {
        return { error: `Unknown effect kind '${String(args.kind)}'. Pick one of: ${kinds.join(", ")}.` };
      }
      const kind = rawKind as StageEffectKind;
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
          : undefined,
        // cast is validated/normalized inside endCampaign (per-player credits).
        cast: args.cast
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
      ensureLocations(campaign);
      const focusedLocation = getFocusedLocation(campaign);
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
          // Models routinely send the character/player NAME where the opaque
          // id belongs (especially on the setup turn) — accept both, else the
          // actions silently vanish and the controller shows empty cards.
          const token = String(update.playerId || "");
          const player =
            campaign.players.find((p) => p.id === token) ||
            campaign.players.find((p) => (p.characterName || p.name).toLowerCase() === token.toLowerCase());
          if (!player) continue;
          campaign.playerActions[player.id] = normalizeActions(update.actions).slice(0, 4);
        }
      }
      if (Array.isArray(args.playerUpdates)) {
        for (const update of args.playerUpdates as Array<Record<string, unknown>>) {
          const nameToken = String(update.playerName || update.playerId || "").toLowerCase();
          const player =
            campaign.players.find((item) => item.id === String(update.playerId || "")) ||
            campaign.players.find((item) => (item.characterName || item.name).toLowerCase() === nameToken);
          if (!player) continue;
          if (Array.isArray(update.inventory)) player.inventory = update.inventory.map(String);
          if (Array.isArray(update.abilities)) player.abilities = update.abilities.map(String);
          if (typeof update.notes === "string") player.notes = update.notes;
          if (typeof update.characterName === "string") player.characterName = update.characterName;
          if (typeof update.status === "string") player.status = update.status;
          if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) player.portraitUrl = update.portraitUrl;
          if (typeof update.portraitPrompt === "string") player.portraitPrompt = update.portraitPrompt;
          if (typeof update.color === "string") player.color = update.color;
          if (typeof update.zoneId === "string" && update.zoneId.trim()) player.zoneId = update.zoneId.trim();
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
              campaign.storyCharacters.find((c) => c.name.trim().toLowerCase() === String(update.renameFrom).trim().toLowerCase())) ||
            campaign.storyCharacters.find((c) => c.name.trim().toLowerCase() === String(update.name || "").trim().toLowerCase());
          if (char) {
            if (typeof update.name === "string") char.name = update.name;
            if (typeof update.description === "string") char.description = update.description;
            if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) char.portraitUrl = update.portraitUrl;
            if (typeof update.status === "string") char.status = update.status;
            if (typeof update.color === "string") char.color = update.color;
            if (typeof update.locationId === "string" && update.locationId.trim()) char.locationId = update.locationId.trim();
            if (typeof update.zoneId === "string" && update.zoneId.trim()) char.zoneId = update.zoneId.trim();
            if (Array.isArray(update.inventory)) char.inventory = update.inventory.map(String);
            if (Array.isArray(update.abilities)) char.abilities = update.abilities.map(String);
            applyNpcGroupFields(char, update);
            applyConditionFields(char, update);
            if (Array.isArray(update.stats)) {
              char.stats = mergeStats(char.stats, update.stats);
            }
          } else {
            // A brand-new NPC/enemy defaults to wherever the party currently is
            // (the focused location) so it shows up in the same right-side rail
            // and combat as the players it just appeared in front of, instead of
            // silently landing on the campaign's very first location.
            const npc: StoryCharacter = {
              id: String(update.id || createId("character")),
              name: String(update.name || "NPC"),
              description: String(update.description || ""),
              portraitUrl: isValidImageUrl(update.portraitUrl) ? update.portraitUrl : undefined,
              status: update.status,
              color: update.color,
              locationId: typeof update.locationId === "string" && update.locationId.trim() ? update.locationId.trim() : focusedLocation.id,
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
            // Portraits are painted BEFORE the NPC is introduced (per the DM
            // rules), so this is often the character's very first record —
            // anchor it to the party's location like every other new NPC.
            ensureLocations(campaign);
            npc = {
              id: createId("character"),
              name: npcName,
              description: "",
              locationId: getFocusedLocation(campaign).id,
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
