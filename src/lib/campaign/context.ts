import { Campaign } from "./types";
import { trimToBudget } from "@/lib/utils/inputBudget";

const RECENT_TRANSCRIPT_CHARS = 120_000;
const RECENT_MESSAGE_COUNT = 24;
const MAX_MESSAGE_CHARS = 3_000;

export function buildCampaignContext(campaign: Campaign) {
  const playerState = campaign.players.map((player) => ({
    id: player.id,
    name: player.name,
    characterName: player.characterName,
    background: player.background,
    status: player.status,
    canAct: player.canAct,
    conditions: player.conditions,
    away: player.away,
    portraitUrl: player.portraitUrl,
    isPartyLeader: campaign.partyLeaderId === player.id,
    inventory: player.inventory,
    abilities: player.abilities,
    notes: player.notes,
    stats: player.stats
  }));

  const recentMessages = campaign.messages.slice(-RECENT_MESSAGE_COUNT);
  const messageParts = recentMessages.map((message) => {
    const label = `${message.role.toUpperCase()}${message.name ? ` ${message.name}` : ""}`;
    return `${label}: ${summarizeMessage(message.content)}`;
  });
  const recent = trimToBudget(messageParts, RECENT_TRANSCRIPT_CHARS).join("\n\n");

  // What's actually on the TV right now, in plain words — so the DM can judge
  // whether the backdrop or the music needs to change, instead of firing tools
  // blind. Resolve the current image URL back to the prompt that painted it.
  const currentBackground = describeCurrentBackground(campaign);
  const currentAmbience = describeCurrentAmbience(campaign);

  return [
    `Campaign: ${campaign.title}`,
    `Status: ${campaign.status}`,
    `Campaign Type: ${campaign.campaignType === "dnd" ? "Dungeons & Dragons campaign" : "Standard tabletop RPG campaign (not D&D unless the setup explicitly says so)"}`,
    `Campaign Mode: ${campaign.isRandomized ? "Surprise / Randomized Campaign" : "Normal Campaign"}`,
    `Rules Mode: ${campaign.campaignType === "dnd" ? (campaign.rulesMode === "full" ? "Full D&D 5e" : "D&D-inspired rules-light") : "Rules-light tabletop"}`,
    `Difficulty: ${campaign.difficulty || "medium"} (easy -2 DC / medium 0 / hard +2 / insane +4). Applies to attacks-to-hit, escape/flee, stealth, persuasion, and all contested checks. Enemy competence, HP, and damage scale with difficulty. Partials only on easy/medium.`,
    `Roll Mode: ${campaign.rollMode || "standard"} (light = rare checks; standard = meaningful risk; heavy = frequent; all = nearly every uncertain action)`,
    `Campaign Length Setting: ${campaign.campaignLength || "auto"}`,
    campaign.ending
      ? `ENDING (campaign completed): kind=${campaign.ending.kind}; title="${campaign.ending.title}"; summary="${campaign.ending.summary}"`
      : `Ending: not yet — call end_campaign when the saga reaches a decisive win/loss/bittersweet/escape/draw/cliffhanger (early endings allowed).`,
    `Starting background story: ${campaign.startingStory || "None provided"}`,
    `Story characters from setup: ${JSON.stringify(campaign.storyCharacters)}`,
    `Player-controlled characters that you must not speak or decide for: ${JSON.stringify(playerState.map((player) => player.characterName || player.name))}`,
    `Players (include stats/HP): ${JSON.stringify(playerState)}`,
    `Current scene: ${campaign.currentScene}`,
    `Current TV overview: ${campaign.overview}`,
    `Turn mode: ${describeTurnState(campaign)}`,
    `Current per-player controller actions: ${JSON.stringify(campaign.playerActions)}`,
    `Current shared party actions: ${JSON.stringify(campaign.partyActions)}`,
    `Long-term memory: ${campaign.memory || "None yet"}`,
    `Current TV background (what the party sees right now): ${currentBackground}`,
    `Current ambience/music playing on the TV: ${currentAmbience}`,
    `Current image URL: ${campaign.currentImageUrl || "None"}`,
    `Previously generated backgrounds (cycle/reuse these instead of generating new ones if appropriate): ${JSON.stringify((campaign.images || []).map(img => ({ id: img.id, url: img.url, prompt: img.prompt })))}`,
    `Previously generated character portraits (cycle/reuse these to change a character's expression/action): ${JSON.stringify((campaign.portraits || []).map(p => ({ id: p.id, url: p.url, prompt: p.prompt, characterName: p.characterName })))}`,
    `Recent TV display events: ${JSON.stringify(campaign.displayEvents.slice(-12))}`,
    `Recent transcript:\n${recent}`
  ].join("\n\n");
}

/**
 * Plain-language description of the image currently on the TV. Matches the
 * live URL against the generated-image gallery so the DM sees the prompt that
 * painted it ("rain-slick storefront at dusk") rather than an opaque asset
 * URL it would otherwise skip over.
 */
function describeCurrentBackground(campaign: Campaign): string {
  const url = campaign.currentImageUrl;
  if (!url) return "None yet (no backdrop painted — consider generate_image for the opening scene).";
  const match = (campaign.images || []).find((img) => img.url === url);
  if (match?.prompt) {
    const prompt = match.prompt.length > 260 ? `${match.prompt.slice(0, 260)}…` : match.prompt;
    // If the backdrop was locked to an earlier scene and the party has clearly
    // moved on, say so loudly — a stale backdrop is the #1 immersion complaint.
    const depicts = (campaign.backdropScene || "").trim();
    const nowScene = (campaign.currentScene || "").trim();
    const stale = depicts && nowScene && depicts !== nowScene;
    const staleNote = stale
      ? ` ⚠️ This backdrop was painted for an EARLIER scene ("${depicts.slice(0, 120)}${depicts.length > 120 ? "…" : ""}"). If the party has moved somewhere it no longer depicts, CHANGE it this turn: reuse a listed background URL via update_campaign_state currentImageUrl, or generate_image (kind "scene").`
      : "";
    return `"${prompt}" — change it (reuse a previous background URL or generate a new one) only if the scene has visibly moved somewhere this no longer depicts.${staleNote}`;
  }
  return "A previously painted scene (prompt not found in the gallery).";
}

/**
 * Plain-language description of the current ambience/music, so the DM can tell
 * whether a set_ambience call is actually a *shift* or a redundant repeat of
 * the mood already playing.
 */
function describeCurrentAmbience(campaign: Campaign): string {
  const ambience = campaign.ambience;
  if (!ambience) return "None set yet (default calm). Call set_ambience when the scene establishes an emotional register.";
  const parts = [`mood=${ambience.mood}`, `intensity=${ambience.intensity}`];
  if (ambience.note) parts.push(`note="${ambience.note}"`);
  return `${parts.join(", ")}. This is ALREADY playing — only call set_ambience if the emotional register genuinely changes to a different mood; do not re-send the same mood.`;
}

/**
 * Tell the DM whether the table is in free exploration (resolve everyone at
 * once) or sequential combat (resolve only the active actor / the enemy phase).
 */
function describeTurnState(campaign: Campaign): string {
  const ts = campaign.turnState;
  const nameOf = (id?: string) => {
    const p = campaign.players.find((x) => x.id === id);
    return p ? p.characterName || p.name : id;
  };
  if (!ts || ts.mode !== "combat") {
    return "EXPLORATION (free). All able players lock in actions and you receive them together — resolve them in ONE narration. Call start_combat when a fight begins.";
  }
  const order = (ts.order || []).map(nameOf).filter(Boolean).join(" → ");
  if (ts.activeId === "enemies") {
    return `COMBAT (sequential), round ${ts.round || 1}. It is the ENEMIES' turn — resolve all hostile actions now (attack rolls, damage, moves). Initiative: ${order}.`;
  }
  return `COMBAT (sequential), round ${ts.round || 1}. Active actor: ${nameOf(ts.activeId)} — resolve ONLY their action this turn; do not act for the other players. Initiative: ${order}. Call end_combat when the fight ends.`;
}

function summarizeMessage(content: string) {
  let text = content.trim();
  const parsed = tryParseJsonObject(text);
  if (parsed) {
    const summary = compactAssistantJson(parsed);
    if (summary) text = summary;
  }

  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}... [truncated]` : text;
}

function tryParseJsonObject(content: string) {
  const startIdx = content.indexOf("{");
  const endIdx = content.lastIndexOf("}");
  if (startIdx === -1 || endIdx <= startIdx) return null;
  try {
    return JSON.parse(content.slice(startIdx, endIdx + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function compactAssistantJson(data: Record<string, unknown>) {
  const parts: string[] = [];
  if (typeof data.title === "string") parts.push(`title=${data.title}`);
  if (typeof data.currentScene === "string") parts.push(`scene=${data.currentScene}`);
  if (typeof data.overview === "string") parts.push(`overview=${data.overview}`);

  if (Array.isArray(data.story)) {
    const story = data.story
      .slice(-4)
      .map((item) => {
        const entry = item as Record<string, unknown>;
        return `${String(entry.speaker || "NARRATOR")}: ${String(entry.content || "")}`;
      })
      .join(" | ");
    if (story) parts.push(`story=${story}`);
  }

  if (Array.isArray(data.playerUpdates) && data.playerUpdates.length) {
    parts.push(`playerUpdates=${data.playerUpdates.length}`);
  }
  if (Array.isArray(data.npcUpdates) && data.npcUpdates.length) {
    parts.push(`npcUpdates=${data.npcUpdates.length}`);
  }

  return parts.join("\n");
}
