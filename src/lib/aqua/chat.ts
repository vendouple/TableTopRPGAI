import { buildCampaignContext } from "@/lib/campaign/context";
import { getCampaign, saveCampaign, downloadAndSaveImage, logCampaignDebug, safePushDisplayEvent, isValidImageUrl, startCampaignDraft, finishCampaignDraft, reconcilePresence } from "@/lib/campaign/store";
import { createId } from "@/lib/utils/ids";
import { aquaConfig, aquaFetch, AquaFetchOptions, AquaMessage, AquaToolCall, AquaToolDefinition } from "./client";
import { runTool, toolDefinitions, applyNpcGroupFields, applyConditionFields } from "@/lib/tools/registry";
import { generateImage } from "@/lib/aqua/images";
import { Campaign, PlayerStat, StoryCharacter } from "@/lib/campaign/types";
import { classifyMusicTheme, MUSIC_THEMES, MusicTheme } from "@/lib/campaign/musicTheme";
import { advanceCombat, buildExplorationResolution, ENEMY_SLOT } from "@/lib/campaign/turns";

// Verbose per-step/per-request server logs flood the console during play
// (AI steps, tool calls, poll-adjacent chatter). Off by default; set
// DEBUG_VERBOSE=1 to see them. Errors always print (see serverError).
const VERBOSE = process.env.DEBUG_VERBOSE === "1" || process.env.DEBUG_VERBOSE === "true";

export function serverLog(category: string, message: string, data?: any) {
  if (!VERBOSE) return;
  const timestamp = new Date().toLocaleTimeString();
  const dataStr = data ? ` | ${typeof data === "object" ? JSON.stringify(data) : data}` : "";
  console.log(`\x1b[35m[DND SERVER]\x1b[0m [${timestamp}] \x1b[36m[${category}]\x1b[0m ${message}${dataStr}`);
}

export function serverError(category: string, message: string, error?: any) {
  const timestamp = new Date().toLocaleTimeString();
  const errorMsg = error instanceof Error ? error.stack : String(error || "");
  console.error(`\x1b[31m[DND ERROR]\x1b[0m [${timestamp}] \x1b[36m[${category}]\x1b[0m ${message}${errorMsg ? `\n${errorMsg}` : ""}`);
}

/**
 * Fire-and-forget update of the live DM status line the TV/controllers show.
 * Used to surface slow-request retries mid-turn. Non-fatal on failure. During
 * a DM turn getCampaign returns the draft, so this reaches pollers.
 */
async function writeDmStatus(campaignId: string, status: string) {
  try {
    const campaign = await getCampaign(campaignId);
    campaign.dmStatus = status;
    await saveCampaign(campaign);
  } catch {
    /* non-fatal — status is cosmetic */
  }
}

// Max tool-calling steps per DM turn. Combat turns chain many rolls + state
// updates, so 8 was too tight (turns hit the cap mid-fight). Env-overridable.
const MAX_DM_STEPS = Math.max(4, Number(process.env.AQUA_MAX_TOOL_STEPS) || 16);

// Interactive DM turns fail fast: a dead endpoint should surface in seconds,
// not after 6×60s of silence. Non-interactive generation keeps the defaults.
const INTERACTIVE_FETCH: Pick<AquaFetchOptions, "retries" | "timeoutMs"> = {
  retries: Math.max(1, Number(process.env.AQUA_INTERACTIVE_RETRIES) || 3),
  timeoutMs: Math.max(5000, Number(process.env.AQUA_INTERACTIVE_TIMEOUT_MS) || 45000)
};

const systemPrompt = `You are the Dungeon Master for a couch RPG. TV shows cinematic story; phones are player controllers.

Prevent context collapse:
- Treat the current user/task message as the highest priority.
- Use campaign state as facts, not as text to imitate.
- Do not re-summarize old transcript unless it matters now.
- Keep each turn focused: resolve action, update state, offer choices.

Core rules:
- Never control player characters: do not choose their actions, speech, thoughts, or feelings.
- Narrate external consequences only. Player names/characters are protected canon.
- Use roll_dice for meaningful risk according to the campaign's Roll Mode (see below).

Dice rules (the server rolls — you NEVER pick, predict, or invent numbers; narrate only from the tool result):
- A d20 check: call roll_dice with d20Mode "normal" and a dc. Base DC: Easy 10, Medium 15, Hard 20, Very Hard 25.
- Campaign Difficulty shifts base DCs: easy −2, medium 0, hard +2, insane +4. Apply this BEFORE ability fit.
- Ability fit shifts the DC further: a character whose listed special ability directly covers the task: DC −2 or −3. Specialist task with NO fitting ability/tool: DC +2 to +5.
- d20Mode "advantage"/"disadvantage" is the DM's discretionary call for a REAL situational swing (high ground, flanking, ambush → advantage; blinded, prone, restrained, terrible footing → disadvantage). Use it sparingly. Having a relevant ability is NOT advantage — that's a DC shift.
- Only use +N/−N modifiers in notation for real damage math or explicit sheet stats.
- Outcome spectrum (honor EXACTLY): critical-success (nat 20), strong-success (beat DC by 5+), success, partial-success (miss by 1–4 with a cost — only on easy/medium), failure, hard-failure (miss by 5+), critical-failure (nat 1). On hard/insane, near-misses are full failures (no partials).
- ENEMY/NPC rolls: call roll_dice with isNpc true and playerName set to the NPC name so the TV dice theater shows them. Chain multiple rolls in one turn for combat (attack → damage, contested checks, multi-enemy).
- Do NOT restate the roll as a SYSTEM story beat — the TV already animates every roll.

Roll Mode (how often to call for dice):
- light: only climactic or life-or-death moments
- standard: meaningful risk (attacks, persuasion, stealth, search under pressure)
- heavy: most contested or uncertain actions
- all: nearly every uncertain action gets a check

Difficulty (tone of challenge — applies to EVERY contested action):
Campaign difficulty shifts ALL DCs (attacks to hit, damage thresholds when used, escape/flee, stealth, persuasion, locks, saves). Server also applies the bias if you pass a base DC.
Base ladder BEFORE difficulty bias: Easy 10, Medium 15, Hard 20, Very Hard 25.
Then apply campaign bias: easy -2, medium 0, hard +2, insane +4. Then ability fit.
- easy: forgiving DCs (typical hit/escape ~8-12), softer enemy competence, lower enemy HP, lighter damage, partial successes common, flee often succeeds
- medium: balanced (typical hit/escape ~12-16), fair enemy HP/damage
- hard: tougher DCs (typical hit/escape ~16-20), competent enemies, higher HP, harder damage, no partials, flee is risky
- insane: brutal DCs (typical hit/escape ~18-24), lethal enemies, high HP, heavy damage, no partials, flee is desperate
Combat & encounters MUST honor difficulty:
- Player attack to damage an enemy: set dc to that enemy's defense (base Medium 15 +/- difficulty bias +/- ability fit). Harder difficulty = harder to land hits.
- Enemy attack on a player: isNpc true; dc = player defense (same ladder). Harder difficulty = enemies hit more often (lower effective player defense or higher enemy attack competence).
- Escape / run away / disengage: always a d20 vs DC on the ladder above; hard/insane make escape costly or fail more often.
- Damage on a hit is MANDATORY: after any successful attack (player OR enemy), immediately roll_dice for the damage, then apply the HP change via playerUpdates/npcUpdates. Never narrate a wound without subtracting HP.
- Bonus/reduced damage is the DM's discretionary call: when the attacker has a clear edge (advantage, vulnerability, perfect setup) you MAY add to the damage; when the target resists or the blow is glancing you MAY reduce it. Scale base damage dice with difficulty (easy lighter; insane heavier, multi-enemy pressure).
- Contested social/stealth/skill checks use the same DC ladder + difficulty bias.

Continuity & assets:
- Track stats, inventory, abilities, NPCs, locations, quests. ALWAYS update player/NPC stats (HP) after damage or healing via playerUpdates/npcUpdates.
- Every player ability should be distinctive and matter mechanically (it defines their easy DCs).
- New NPC/monster on stage: call generate_image with kind "portrait" and npcName BEFORE introducing them.
- When the party moves somewhere visually new, update the TV backdrop (reuse currentImageUrl or generate_image kind "scene").
- Maintain quest_log.md with ONLY the current active objective and immediate tasks.
- Seed every foe with HP via npcUpdates the moment it enters the scene, so the TV shows an enemy HP bar and hits have something to subtract.
- Group handling: a NAMED or role foe (leader, lieutenant, champion — anyone who speaks or matters) is ALWAYS its own npcUpdates entry with its own HP. Only faceless rank-and-file (e.g. "Iron Warrens Thugs") are pooled into ONE entry with isGroup:true, count (how many stand), and maxCount. Decrement count as they drop; don't flood the UI with a card per mook.

Cinematic direction (you are also the stage director):
- If set_theme is offered and no score is chosen yet, call set_theme EXACTLY ONCE on the opening turn.
- Call set_ambience when the emotional register shifts. Moods: calm, tense, adrenaline (chases, escapes, heists, races against time — excitement without combat), battle (ordinary combat), boss (climactic showdowns against a major villain or endgame threat), mystery, dread, triumph, wonder, somber, outro.
- Call trigger_effect for big beats; use repeat/delayMs for multi-hit impacts.
- Prefer atmosphere over words.

Campaign endings (win/loss/draw/cliffhanger — can end EARLY):
- When the story reaches a decisive close — party dead (TPK), villain defeated, escape, total failure, stalemate, or bittersweet resolution — call end_campaign with kind (victory|defeat|bittersweet|escape|draw|cliffhanger), title, summary, optional highlights, optional stats.
- draw = a true stalemate (neither side prevailed, the conflict exhausted itself). cliffhanger = a deliberate season-finale stop mid-crisis — the reveal lands, the door bursts open, cut to black. Use either whenever it is the most dramatically honest close, not only on wins/losses.
- Include 3-6 stats for the outro's stats board: mix real tallies (battles survived, NPCs befriended, gold earned) with flavorful ones (lies told, curses ignored). Values may be numbers or short witty phrases.
- Early endings are valid and preferred over dragging a dead campaign. After end_campaign, write a short final story[] epilogue and stop offering player choices (empty playerActions).
- end_campaign sets status completed, plays the cinematic outro on the TV, and switches ambience to outro.

Story delivery (one channel only):
- Your final JSON story[] is the ONLY place narration and dialogue go. NEVER send narration/dialogue through update_campaign_state displayEvents.
- update_campaign_state is for state: scene, overview, actions, player/NPC updates, backdrop.

Narration style (the TV performs each story beat one at a time):
- Keep each story[] entry SHORT: 1-3 sentences. Split scenes into several beats.
- Use inline markdown: *italics* for whispers/dread; **bold** for weight/danger; ***both*** rarely.
- Give NPCs real voices in their own story entries with the NPC name as speaker.
- Dramatize player actions with the character's EXACT name as speaker (third-person cinema of what they declared only).
- Speaker values: "NARRATOR", "SYSTEM", an NPC name, or a player character's exact name.

Turns & combat flow (the table has two modes — honor the one in the context):
- EXPLORATION (default): all able players lock in simultaneously and you receive their actions together. Resolve them in ONE flowing narration where their choices interact.
- COMBAT (sequential): call start_combat when a fight begins. Then you resolve ONE actor per turn — only the active player's action (named in the context), never the others. After the last player, you get the enemies' turn: resolve every foe's action (attack roll → damage → apply HP). Call end_combat when the fight is over. Narrate initiative naturally ("Engu, you're up").
- Don't switch modes needlessly; stay in exploration for talk/travel/investigation, combat only for actual fights.

Conditions & lifecycle (ENFORCED — not just flavor):
- When a character is stunned, incapacitated, knocked out, or dead, set canAct:false on their playerUpdates/npcUpdates entry (and a matching conditions list, e.g. ["stunned"] or ["dead"], plus a status line). Their controller hard-locks — they truly cannot act that turn.
- Clear it by setting canAct:true (and removing the condition) the moment they recover — a stun that ends next turn, a revive, standing back up.
- A dead player stays canAct:false with empty playerActions for the rest of the saga; weave them out of the action.

Controller choices:
- Provide 1–4 playerActions per active player (not always 2–4). Fewer when the situation is constrained; more when open. Empty only when incapacitated (canAct:false) or campaign completed.

CRITICAL — how to end your turn:
- Run any other tools first (dice, images, ambience). THEN end your turn by calling the narrate_turn tool EXACTLY ONCE with your story beats and final state. This is the required, reliable way to finish.
- Do NOT also write prose or JSON in the message content — narrate_turn carries everything.
- (Only if you truly cannot call narrate_turn: return ONLY a single valid JSON object matching the shape below, no markdown fences, no prose.)`;

const turnChecklistPrompt = `Before responding:
1. Read current task, difficulty, roll mode, and whether the campaign is already completed.
2. Check active players (stats/HP), scene, quest, NPCs, and recent transcript.
3. Call required tools before ending (dice, images, ambience, effects, end_campaign if the saga closes).
4. Honor dice outcomes exactly (full spectrum). Update HP/stats after harm or healing.
5. END by calling narrate_turn (preferred) with story + updates. If the campaign ended, leave playerActions empty.

The narrate_turn tool takes the same fields as this shape (story, title, currentScene, overview, playerActions, partyActions, playerUpdates, npcUpdates). Only if you cannot call it, emit this JSON instead:
{"story":[{"speaker":"NARRATOR|SYSTEM|NPC name|player character name","content":"short beat (1-3 sentences, may use *italic*/**bold** inline markdown)","itemUsed":"optional","abilityUsed":"optional"}],"title":"optional","currentScene":"optional","overview":"optional","playerActions":{"<playerId>":[{"title":"Look around","prompt":"I look around."}]},"partyActions":[{"title":"Shared Action","prompt":"We act together."}],"playerUpdates":[{"playerId":"...","characterName":"optional","background":"optional","portraitUrl":"optional","portraitPrompt":"optional","status":"Ready/Active/Stunned/etc.","inventory":["item"],"abilities":["ability"],"notes":"private notes","color":"cyan","stats":[{"name":"HP","value":15,"maxValue":20,"color":"red"}]}],"npcUpdates":[{"id":"existing id","renameFrom":"old name","name":"NPC name","description":"desc","portraitUrl":"url","status":"Ready","color":"orange","inventory":["item"],"abilities":["ability"],"stats":[{"name":"HP","value":15,"maxValue":15,"color":"red"}]}]}

Always provide playerActions (1–4 choices) for every active player unless incapacitated or the campaign has ended.`;

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

// The preferred way for the model to END its turn: a single structured tool
// call instead of free-form final JSON. Small/RP models are far more reliable
// at emitting a validated tool call than at closing a big JSON object, so this
// is the primary path; the free-JSON parser remains as a cross-model fallback.
const actionItemSchema = {
  type: "object",
  required: ["title", "prompt"],
  properties: {
    title: { type: "string", description: "Short button label shown on the phone." },
    prompt: { type: "string", description: "Detailed hidden prompt sent if the player taps this choice." }
  }
} as const;

const statSchema = {
  type: "object",
  required: ["name", "value"],
  properties: {
    name: { type: "string" },
    value: { type: "number" },
    maxValue: { type: "number", description: "Optional — omit to keep the existing max." },
    color: { type: "string" }
  }
} as const;

const narrateTurnTool: AquaToolDefinition = {
  type: "function",
  function: {
    name: "narrate_turn",
    description: "END YOUR TURN by calling this EXACTLY ONCE after all other tools (dice, images, ambience). Deliver the story beats and the final state here. This REPLACES the final JSON — do not also emit prose. story[] is the ONLY place narration/dialogue goes.",
    parameters: {
      type: "object",
      required: ["story"],
      properties: {
        story: {
          type: "array",
          description: "Ordered cinematic beats, each SHORT (1-3 sentences). speaker = NARRATOR, SYSTEM, an NPC name, or a player character's exact name.",
          items: {
            type: "object",
            required: ["speaker", "content"],
            properties: {
              speaker: { type: "string" },
              content: { type: "string", description: "1-3 sentences; inline *italic*/**bold** allowed." },
              itemUsed: { type: "string" },
              abilityUsed: { type: "string" }
            }
          }
        },
        title: { type: "string" },
        currentScene: { type: "string" },
        overview: { type: "string", description: "Brief TV overview of the situation. No controller choices here." },
        playerActions: {
          type: "array",
          description: "Per-player controller buttons (1-4 each). Empty for a player who is incapacitated/dead or when the campaign ended.",
          items: {
            type: "object",
            required: ["playerId", "actions"],
            properties: {
              playerId: { type: "string" },
              actions: { type: "array", items: actionItemSchema }
            }
          }
        },
        partyActions: { type: "array", description: "Optional shared 'together' actions shown on every phone.", items: actionItemSchema },
        playerUpdates: {
          type: "array",
          description: "Apply HP/stat/inventory/status changes after harm or healing.",
          items: {
            type: "object",
            properties: {
              playerId: { type: "string" },
              playerName: { type: "string" },
              status: { type: "string", description: "Free-text flavor line." },
              conditions: { type: "array", items: { type: "string" }, description: "e.g. ['stunned'] or ['dead']." },
              canAct: { type: "boolean", description: "False when stunned/incapacitated/dead — locks their controller." },
              inventory: { type: "array", items: { type: "string" } },
              abilities: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
              color: { type: "string" },
              stats: { type: "array", items: statSchema }
            }
          }
        },
        npcUpdates: {
          type: "array",
          description: "Create/update NPCs & enemies. Seed HP when a foe appears. Pool ONLY faceless minions via isGroup+count; named/role NPCs stay individual.",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              id: { type: "string" },
              renameFrom: { type: "string" },
              name: { type: "string" },
              description: { type: "string" },
              status: { type: "string" },
              conditions: { type: "array", items: { type: "string" } },
              canAct: { type: "boolean" },
              isGroup: { type: "boolean", description: "TRUE only for pooled faceless rank-and-file (never a named leader/lieutenant)." },
              count: { type: "number", description: "Group: how many still standing." },
              maxCount: { type: "number", description: "Group: size at first encounter." },
              color: { type: "string" },
              inventory: { type: "array", items: { type: "string" } },
              abilities: { type: "array", items: { type: "string" } },
              stats: { type: "array", items: statSchema }
            }
          }
        }
      }
    }
  }
};

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
  // Backdrop the party sees BEFORE this turn's tools run, so afterward we can
  // tell whether the DM repainted it itself or left it stale.
  const preTurnImageUrl = campaign.currentImageUrl;
  // Snapshot the choices on the table BEFORE this turn. If the turn fails
  // (dead endpoint, unparseable output), we restore these so the party can
  // simply retry the same options instead of being stranded with empty cards.
  const preTurnPlayerActions = JSON.parse(JSON.stringify(campaign.playerActions || {}));
  const preTurnPartyActions = JSON.parse(JSON.stringify(campaign.partyActions || []));
  const preTurnSuggestedActions = JSON.parse(JSON.stringify(campaign.suggestedActions || []));
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
    // Populated when the model ends its turn via the narrate_turn tool (the
    // reliable path). When set, it IS the turn's final structured result.
    let structuredResult: Record<string, any> | null = null;
    const toolEvents: string[] = [];
    // Once the score is chosen (now or on a past turn), drop set_theme from
    // the offered tools so it can't be picked again mid-turn.
    let themeChosen = !!campaign.musicTheme;

    // Interactive fetch: fail fast, and surface each retry to the TV so a slow
    // request reads as "retrying (2/3)" instead of a silent multi-minute hang.
    const interactiveFetch: AquaFetchOptions = {
      ...INTERACTIVE_FETCH,
      onRetry: ({ attempt, retries }) => {
        void writeDmStatus(campaignId, `The connection wavers… retrying (${attempt}/${retries})`);
      }
    };

    for (let step = 0; step < MAX_DM_STEPS; step += 1) {
      await logCampaignDebug(campaignId, `[AI Step ${step + 1}] Requesting completion...`);
      serverLog("DM AI Step", `Step ${step + 1}/${MAX_DM_STEPS}: Requesting completion...`);
      const response = await complete(messages, "auto", [...toolsForTurn({ musicTheme: themeChosen ? "set" : undefined }), narrateTurnTool], interactiveFetch);
      const message = response.choices?.[0]?.message || response.message;
      if (!message) throw new Error("Aqua chat response did not include a message");
      await logCampaignDebug(campaignId, `[AI Step ${step + 1}] Received response: ${JSON.stringify(message)}`);
      
      const toolCalls = normalizeToolCalls(message);
      serverLog("DM AI Step", `Step ${step + 1}/${MAX_DM_STEPS}: Received response. Tool calls found: ${toolCalls.length}`);
      if (!toolCalls.length) {
        finalMessage = message;
        break;
      }

      messages.push({ ...message, content: message.content || "" });
      for (const call of toolCalls) {
        // narrate_turn is the turn terminator, not an executable tool: capture
        // its validated args as the final structured result and stop. Any other
        // tools in the same step are still executed above/below.
        if (call.function.name === "narrate_turn") {
          try {
            structuredResult = typeof call.function.arguments === "string"
              ? JSON.parse(call.function.arguments || "{}")
              : (call.function.arguments as Record<string, any>) || {};
          } catch (err) {
            await logCampaignDebug(campaignId, `[narrate_turn] argument parse failed: ${err}`);
            structuredResult = null;
          }
          await logCampaignDebug(campaignId, `[Tool Call] narrate_turn (turn terminator)`);
          continue;
        }
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
        } else if (call.function.name === "end_campaign") {
          toolStatus = "Sealing the final chapter...";
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
        let toolArgs: Record<string, unknown> = {};
        try {
          toolArgs = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments || "{}")
            : (call.function.arguments as Record<string, unknown>) || {};
        } catch {
          toolArgs = {};
        }
        const result = await runTool(campaignId, call.function.name, toolArgs);
        if (call.function.name === "set_theme" && result && !(result as any).error) themeChosen = true;
        const resultText = JSON.stringify(result);
        await logCampaignDebug(campaignId, `[Tool Result] ${call.function.name} returned: ${resultText}`);
        serverLog("DM Tool Result", `Tool '${call.function.name}' returned: ${resultText.slice(0, 160)}${resultText.length > 160 ? "..." : ""}`);
        toolEvents.push(`${call.function.name}: ${resultText}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
      }
      // The model ended its turn via narrate_turn — stop looping.
      if (structuredResult) break;
    }

    if (!finalMessage && !structuredResult) {
      serverError("DM Loop", `Tool loop exceeded maximum steps (${MAX_DM_STEPS}).`);
      throw new Error("Tool loop exceeded maximum steps");
    }

    let content = finalMessage?.content || "";
    let parsedJson: Record<string, any> | null = null;

    if (structuredResult) {
      // Reliable path: use the validated tool args directly — no JSON parsing.
      parsedJson = structuredResult;
      content = JSON.stringify(structuredResult);
      await logCampaignDebug(campaignId, `[AI Finish] Turn ended via narrate_turn (structured).`);
    } else {
      await logCampaignDebug(campaignId, `[AI Finish] Final response content: ${content}`);
      parsedJson = await parseFinalJson(campaignId, content);
    }

    if (!structuredResult && !parsedJson) {
      await logCampaignDebug(campaignId, `[AI Retry] Retrying final response because JSON parsing failed.`);
      serverLog("DM Parser", "Retrying final response because JSON parsing failed.");
      const retryResponse = await complete([
        ...messages,
        { role: "assistant", content },
        {
          role: "user",
          content: "Your previous response was not valid JSON and could not be applied to the campaign. Return the same narrative result again as ONLY strict JSON matching the required schema. Do not call tools. Do not include prose or markdown fences."
        }
      ], "none", toolDefinitions, INTERACTIVE_FETCH);
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
          applyConditionFields(player, update);
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
            applyNpcGroupFields(char, update);
            applyConditionFields(char, update);
            if (Array.isArray(update.stats)) {
              char.stats = mergeStats(char.stats, update.stats);
            }
          } else {
            const newCharId = String(update.id || createId("character"));
            let localUrl = undefined;
            if (typeof update.portraitUrl === "string" && isValidImageUrl(update.portraitUrl)) {
              localUrl = await downloadAndSaveImage(campaignId, update.portraitUrl, "npcs", newCharId);
            }
            const npc: StoryCharacter = {
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
            applyNpcGroupFields(npc, update);
            applyConditionFields(npc, update);
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

    // Backdrop guarantee: the small RP model paints the opening scene then
    // forgets the backdrop exists (in playtesting it changed ambience 27× but
    // the image 0× across 46 turns). So we reconcile server-side — if the scene
    // has moved materially and the DM didn't repaint this turn, reuse a fitting
    // past background or paint a fresh one. Non-fatal on failure.
    if (latestCampaign.status === "active") {
      try {
        const scene = (latestCampaign.currentScene || "").trim();
        const modelChangedBackdrop = latestCampaign.currentImageUrl !== preTurnImageUrl;
        if (scene) {
          if (modelChangedBackdrop) {
            latestCampaign.backdropScene = scene; // the DM handled it this turn
          } else if (
            !latestCampaign.backdropScene ||
            sceneSimilarity(scene, latestCampaign.backdropScene) < 0.75 ||
            // Also reconcile when the situation summary has clearly moved on,
            // even if the short scene label reads similar — keeps the backdrop
            // from going stale across a long beat in one location.
            sceneSimilarity(`${scene} ${latestCampaign.overview || ""}`, latestCampaign.backdropScene) < 0.6
          ) {
            const decision = await chooseBackdrop(latestCampaign, false);
            await applyBackdropDecision(latestCampaign, decision, scene, false);
          }
        }
      } catch (err) {
        serverError("Backdrop", "Scene-director reconcile failed (non-fatal)", err);
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
      // Fall back to the last option: restore the choices that were on the
      // table before this failed turn so the party can retry immediately
      // instead of being stranded with empty controllers.
      currentCampaign.playerActions = preTurnPlayerActions;
      currentCampaign.partyActions = preTurnPartyActions;
      currentCampaign.suggestedActions = preTurnSuggestedActions;
      await saveCampaign(currentCampaign);
    } catch (dbErr) {
      serverError("Dungeon Master", "Failed to clear dmStatus on error", dbErr);
    }
    throw error;
  }
}

/**
 * Resolve a full EXPLORATION round: fold every locked-in action into ONE DM
 * turn (honoring unanimous "together" actions), pushing each player's choice as
 * a user message + display beat first so the transcript and TV reflect it.
 */
export async function resolveExplorationRound(campaignId: string): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  reconcilePresence(campaign); // absent players don't count toward the round
  const { action, displays } = buildExplorationResolution(campaign);
  if (!displays.length) {
    // Nothing locked in (all away/incapacitated) — just clear and return.
    campaign.pendingActions = {};
    if (campaign.turnState?.mode === "exploration") campaign.turnState.deadlineAt = undefined;
    await saveCampaign(campaign);
    return campaign;
  }
  for (const d of displays) {
    campaign.messages.push({ id: createId("msg"), role: "user", name: d.name, content: d.action, createdAt: new Date().toISOString() });
    safePushDisplayEvent(campaign, { type: "playerAction", speaker: d.name, playerId: d.playerId, content: d.display });
  }
  campaign.pendingActions = {};
  if (campaign.turnState?.mode === "exploration") campaign.turnState.deadlineAt = undefined;
  await saveCampaign(campaign);
  const result = await runDungeonMaster(campaignId, "The Party", action, { hiddenUserMessage: true });
  return result.campaign;
}

/**
 * After a combat actor's turn resolves, advance the initiative pointer. Each
 * time it lands on the enemy slot, run ONE hidden DM turn for the enemies, then
 * advance again — looping until it's a player's turn (or combat ended).
 */
export async function advanceCombatAndRunEnemies(campaignId: string): Promise<Campaign> {
  let campaign = await getCampaign(campaignId);
  if (campaign.turnState?.mode !== "combat") return campaign;
  reconcilePresence(campaign); // drop disconnected players from initiative
  let active = advanceCombat(campaign);
  await saveCampaign(campaign);

  let guard = 0;
  while (active === ENEMY_SLOT && guard++ < 4) {
    await runDungeonMaster(
      campaignId,
      "Enemies",
      "It is the enemies' turn. Resolve every hostile NPC's action now — attacks (roll to hit, then damage), moves, taunts, retreats — and apply HP changes. If the fight is over (all foes down or fled), call end_campaign only if the whole saga closes, otherwise call end_combat. Then hand the turn back to the players.",
      { hiddenUserMessage: true }
    );
    campaign = await getCampaign(campaignId);
    if (campaign.turnState?.mode !== "combat") break;
    active = advanceCombat(campaign);
    await saveCampaign(campaign);
  }
  return campaign;
}

type BackdropDecision = { mode: "keep" | "reuse" | "new"; backgroundId?: string; prompt?: string };

/**
 * Word-overlap similarity (Jaccard on 4+ letter tokens) between two scene
 * descriptions. Used as a cheap gate: near-identical scenes (same location,
 * minor rewording) skip the scene-director AI call entirely.
 */
function sceneSimilarity(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Plain-language description of the backdrop currently on the TV. */
function describeBackdropPrompt(campaign: Campaign): string {
  const url = campaign.currentImageUrl;
  if (!url) return "nothing yet (no backdrop painted)";
  const match = (campaign.images || []).find((img) => img.url === url);
  return match?.prompt ? match.prompt : "a previously painted scene";
}

/**
 * The scene-director pass: a standalone forced-tool call (like the theme
 * picker) that decides the TV backdrop for the CURRENT scene — reuse a fitting
 * past background, paint a new one, or keep what's showing. It runs on the
 * small model but the DECISION is constrained to a strict tool schema, and the
 * server applies it — the RP model is never trusted to remember on its own.
 * When `force` is set (the host tapped Nudge), "keep" is not an option.
 */
async function chooseBackdrop(campaign: Campaign, force: boolean): Promise<BackdropDecision | null> {
  const backgrounds = (campaign.images || []).slice(-12).map((img) => ({ id: img.id, depicts: img.prompt }));
  const tool = {
    type: "function" as const,
    function: {
      name: "set_backdrop",
      description: "Choose the TV backdrop for the CURRENT scene. Prefer reuse when a listed background already depicts this place; choose new only when the party is somewhere none of them show; choose keep only if the current backdrop still fits.",
      parameters: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: force ? ["reuse", "new"] : ["keep", "reuse", "new"], description: force ? "reuse an existing background, or new to paint a fresh one." : "keep the current backdrop, reuse an existing one, or paint a new one." },
          backgroundId: { type: "string", description: "For reuse: the id of the existing background that best depicts the current place." },
          prompt: { type: "string", description: "For new: a vivid, self-contained text-to-image scene prompt. Describe place, time of day, weather, lighting, and mood in concrete visual detail. NO character or proper names — the image model does not know them." }
        }
      }
    }
  };

  const config = aquaConfig();
  const system = `You are the TV scene director for a couch RPG. Read the CURRENT scene and the backdrop now showing, then call set_backdrop EXACTLY ONCE.${force ? " The host has asked you to refresh the backdrop, so you MUST change it — reuse a fitting past background or paint a new one." : " Prefer reuse; only paint new when the location is genuinely new; keep only if the current backdrop still depicts this place."}`;
  const user = [
    `Current scene: ${campaign.currentScene}`,
    campaign.ambience ? `Atmosphere: ${campaign.ambience.mood}${campaign.ambience.note ? ` — ${campaign.ambience.note}` : ""}` : "",
    `Backdrop currently on the TV depicts: ${describeBackdropPrompt(campaign)}`,
    `Existing backgrounds you may reuse: ${JSON.stringify(backgrounds)}`
  ].filter(Boolean).join("\n");

  try {
    const response = (await aquaFetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        // Constrained forced-tool call → safe for the small/fast model.
        model: config.fastModel || config.chatModel,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        tools: [tool],
        tool_choice: { type: "function", function: { name: "set_backdrop" } }
      })
    })) as ChatCompletionResponse;
    const message = response.choices?.[0]?.message || response.message;
    const call = Array.isArray(message?.tool_calls) ? message?.tool_calls?.[0] : null;
    if (!call?.function?.arguments) return null;
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const rawMode = String(args.mode || "");
    const mode = (["keep", "reuse", "new"] as const).includes(rawMode as any) ? (rawMode as BackdropDecision["mode"]) : (force ? "new" : "keep");
    return {
      mode,
      backgroundId: typeof args.backgroundId === "string" ? args.backgroundId : undefined,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined
    };
  } catch (err) {
    serverError("Backdrop", "chooseBackdrop tool call failed", err);
    return null;
  }
}

/** Paint a fresh backdrop from a prompt and make it the live TV background. */
async function paintNewBackdrop(campaign: Campaign, prompt: string) {
  const image = await generateImage(prompt);
  const localUrl = await downloadAndSaveImage(campaign.id, image.url, "backgrounds");
  campaign.images.push({ id: createId("image"), url: localUrl, prompt: image.prompt, createdAt: new Date().toISOString() });
  campaign.currentImageUrl = localUrl;
  safePushDisplayEvent(campaign, { type: "scene", speaker: "Scene", content: "The TV scene background shifts." });
}

/** Apply a scene-director decision to the campaign, recording the scene it now depicts. */
async function applyBackdropDecision(campaign: Campaign, decision: BackdropDecision | null, scene: string, force: boolean) {
  const mode = decision?.mode || "keep";
  let changed = false;
  if (mode === "reuse" && decision?.backgroundId) {
    const img = (campaign.images || []).find((i) => i.id === decision.backgroundId);
    if (img && img.url !== campaign.currentImageUrl) {
      campaign.currentImageUrl = img.url;
      safePushDisplayEvent(campaign, { type: "scene", speaker: "Scene", content: "The TV scene background shifts." });
      changed = true;
    }
  } else if (mode === "new" && decision?.prompt) {
    await paintNewBackdrop(campaign, decision.prompt);
    changed = true;
  }
  // Host tapped Nudge (force) but nothing actually changed — the director chose
  // keep, gave no prompt, or named a background already showing. Repaint from
  // the scene text so the button always visibly does something.
  if (force && !changed) {
    await paintNewBackdrop(campaign, campaign.currentScene || scene);
  }
  campaign.backdropScene = scene;
}

/**
 * Repaint the TV backdrop to match the current scene, on demand (the Director's
 * "Nudge" button). This is a pure visual refresh — no story turn, no touched
 * choices. With force, the director must change the backdrop.
 */
export async function repaintBackdrop(campaignId: string, options: { force?: boolean } = {}): Promise<Campaign> {
  const campaign = await getCampaign(campaignId);
  if (campaign.status !== "active") return campaign;
  const scene = (campaign.currentScene || "").trim();
  if (!scene) return campaign;
  const force = options.force !== false;
  const decision = await chooseBackdrop(campaign, force);
  await applyBackdropDecision(campaign, decision, scene, force);
  await saveCampaign(campaign);
  serverLog("Backdrop", `Nudge repaint applied for campaign ${campaignId} (mode=${decision?.mode || "keep"})`);
  return campaign;
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
  tools: typeof toolDefinitions = toolDefinitions,
  fetchOptions: AquaFetchOptions = {}
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
  }, fetchOptions)) as ChatCompletionResponse;
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
      // Constrained forced-tool call → safe for the small/fast model.
      model: config.fastModel || config.chatModel,
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

/**
 * Best-effort repair of not-quite-valid JSON from weaker models: strips code
 * fences, drops trailing commas, and balances an unterminated tail of braces/
 * brackets (a common truncation). Returns candidate strings to try in order.
 */
function repairJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let s = raw.trim();
  // Strip ```json ... ``` fences if present.
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const startIdx = s.indexOf("{");
  const endIdx = s.lastIndexOf("}");
  if (startIdx === -1) return candidates;
  const sliced = endIdx > startIdx ? s.substring(startIdx, endIdx + 1) : s.substring(startIdx);
  candidates.push(sliced);
  // Remove trailing commas before } or ].
  const noTrailingCommas = sliced.replace(/,\s*([}\]])/g, "$1");
  if (noTrailingCommas !== sliced) candidates.push(noTrailingCommas);
  // Balance unterminated braces/brackets by appending closers (ignoring those
  // inside strings). Handles the frequent "cut off mid-object" truncation.
  const base = noTrailingCommas;
  let inStr = false, esc = false;
  const stack: string[] = [];
  for (const ch of base) {
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (stack.length || inStr) {
    const closed = (inStr ? base + '"' : base) + stack.reverse().join("");
    const closedClean = closed.replace(/,\s*([}\]])/g, "$1");
    candidates.push(closedClean);
  }
  return candidates;
}

async function parseFinalJson(campaignId: string, content: string) {
  const candidates = repairJsonCandidates(content);
  if (!candidates.length) {
    serverLog("DM Parser", "AI response did not contain a JSON block. Falling back to plain text.");
    await logCampaignDebug(campaignId, `[AI Finish] Response did not contain a JSON block.`);
    return null;
  }

  let lastErr: unknown = null;
  for (const candidate of candidates) {
    try {
      const parsedJson = JSON.parse(candidate);
      await logCampaignDebug(campaignId, `[AI Finish] Parsed JSON successfully${candidate === candidates[0] ? "" : " (after repair)"}.`);
      serverLog("DM Parser", "Successfully parsed story JSON response.", {
        title: parsedJson.title || undefined,
        currentScene: parsedJson.currentScene || undefined,
        storyCount: Array.isArray(parsedJson.story) ? parsedJson.story.length : 0,
        playerUpdatesCount: Array.isArray(parsedJson.playerUpdates) ? parsedJson.playerUpdates.length : 0,
        npcUpdatesCount: Array.isArray(parsedJson.npcUpdates) ? parsedJson.npcUpdates.length : 0,
      });
      return parsedJson;
    } catch (err) {
      lastErr = err;
    }
  }
  serverError("DM Parser", "Failed to parse JSON content from AI message. Error: " + String(lastErr));
  await logCampaignDebug(campaignId, `[AI Finish] Failed to parse JSON content (tried ${candidates.length} repairs). Error: ${lastErr}`);
  return null;
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
    if (!s || typeof s !== "object") continue;
    const nameStr = String(s.name || "").trim();
    if (!nameStr) continue;
    const value = Number(s.value ?? 0);
    if (!Number.isFinite(value)) continue;
    const existingIdx = merged.findIndex((item) => item.name.toLowerCase() === nameStr.toLowerCase());
    const incomingMax = Number(s.maxValue);
    if (existingIdx !== -1) {
      const prev = merged[existingIdx];
      // maxValue omitted/invalid → keep the existing max (don't reset to a
      // default — that would silently cap HP). narrate_turn makes maxValue
      // optional precisely so the model can send just {name, value}.
      const maxValue = Number.isFinite(incomingMax) && incomingMax > 0 ? incomingMax : prev.maxValue;
      merged[existingIdx] = {
        name: prev.name,
        value,
        maxValue,
        color: s.color ? String(s.color) : prev.color
      };
    } else {
      // New stat with no max → fall back to the value itself (so a full bar),
      // then 10 as a last resort.
      const maxValue = Number.isFinite(incomingMax) && incomingMax > 0 ? incomingMax : (value > 0 ? value : 10);
      merged.push({
        name: nameStr,
        value,
        maxValue,
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

        const result = await runTool(campaignId, call.function.name, toolArgs);
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
