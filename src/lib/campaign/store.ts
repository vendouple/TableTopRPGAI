import { mkdir, readFile, readdir, writeFile, appendFile, rm } from "fs/promises";
import path from "path";
import {
  Ambience,
  AmbienceMood,
  Campaign,
  CampaignEnding,
  CampaignSummary,
  CampaignType,
  ChatMessage,
  Difficulty,
  DisplayEvent,
  EndingCastMember,
  EndingKind,
  Location,
  PendingAction,
  Player,
  RollMode,
  SceneObject,
  StageEffect,
  StageEffectKind,
  StoryCharacter,
  SuggestedAction,
  TurnState
} from "./types";
import { createId, createJoinCode } from "@/lib/utils/ids";
import { MUSIC_THEMES, MusicTheme } from "./musicTheme";

const dataRoot = path.join(process.cwd(), "data", "campaigns");

const activeHosts: Map<string, number> = ((globalThis as any).activeHosts ??= new Map<string, number>());

export function recordHostHeartbeat(campaignId: string) {
  activeHosts.set(campaignId, Date.now());
}

export function isHostHeartbeatActive(campaignId: string): boolean {
  const lastActive = activeHosts.get(campaignId);
  return lastActive ? (Date.now() - lastActive < 15000) : false;
}

// Per-player presence, in-memory (globalThis) so a poll doesn't hit disk. A
// player is "away" only once we've SEEN them and then lost them past the
// window; no record at all is treated as present (grace for fresh joins / after
// a server restart), so we never falsely skip someone who simply hasn't polled.
const PLAYER_AWAY_MS = Math.max(8000, Number(process.env.PLAYER_AWAY_MS) || 20000);
// A DM turn that never reaches its finally/catch (server restart, crashed
// process mid-retry) can leave dmStatus stuck forever, freezing every
// controller on reload (they hard-lock on dmStatus being set). Past this age,
// getCampaign clears it so the table can recover without host intervention.
const DM_STATUS_STALE_MS = Math.max(60_000, Number(process.env.DM_STATUS_STALE_MS) || 5 * 60_000);
const activePlayers: Map<string, number> = ((globalThis as any).activePlayers ??= new Map<string, number>());

export function recordPlayerHeartbeat(campaignId: string, playerId: string) {
  if (!campaignId || !playerId) return;
  activePlayers.set(`${campaignId}:${playerId}`, Date.now());
}

export function playerLastSeen(campaignId: string, playerId: string): number | undefined {
  return activePlayers.get(`${campaignId}:${playerId}`);
}

export function isPlayerPresent(campaignId: string, playerId: string): boolean {
  const seen = activePlayers.get(`${campaignId}:${playerId}`);
  if (seen === undefined) return true; // never-seen = grace (present)
  return Date.now() - seen <= PLAYER_AWAY_MS;
}

/**
 * Reflect live presence into each player's `away` flag (used by the turn system
 * to skip disconnected players). Returns the ids that FLIPPED to away this pass
 * and those that flipped back, so callers can weave the transition into the story.
 */
export function reconcilePresence(campaign: Campaign): { wentAway: string[]; returned: string[] } {
  const wentAway: string[] = [];
  const returned: string[] = [];
  for (const player of campaign.players) {
    const present = isPlayerPresent(campaign.id, player.id);
    const wasAway = player.away === true;
    if (!present && !wasAway) {
      player.away = true;
      wentAway.push(player.id);
    } else if (present && wasAway) {
      player.away = false;
      returned.push(player.id);
    }
  }
  return { wentAway, returned };
}

class Mutex {
  private queue: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = this.queue;
    this.queue = next;
    await current;
    return release;
  }
}

const locks: Map<string, Mutex> = ((globalThis as any).locks ??= new Map<string, Mutex>());

const activeDrafts: Map<string, Campaign> = ((globalThis as any).activeDrafts ??= new Map<string, Campaign>());

export function startCampaignDraft(campaignId: string, campaign: Campaign) {
  activeDrafts.set(campaignId, JSON.parse(JSON.stringify(campaign)));
}

export function getCampaignDraft(campaignId: string): Campaign | undefined {
  return activeDrafts.get(campaignId);
}

export function finishCampaignDraft(campaignId: string) {
  activeDrafts.delete(campaignId);
}


export function getCampaignLock(campaignId: string): Mutex {
  let lock = locks.get(campaignId);
  if (!lock) {
    lock = new Mutex();
    locks.set(campaignId, lock);
  }
  return lock;
}

function campaignDir(id: string) {
  return path.join(dataRoot, safeSegment(id));
}

function campaignFile(id: string) {
  return path.join(campaignDir(id), "campaign.json");
}

function environmentFile(id: string) {
  return path.join(campaignDir(id), "environment.json");
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function safeCampaignRelativePath(filePath: string) {
  const clean = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("..") || path.isAbsolute(clean)) {
    throw new Error("Unsafe campaign file path");
  }
  return clean;
}

export async function ensureDataRoot() {
  await mkdir(dataRoot, { recursive: true });
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  await ensureDataRoot();
  const entries = await readdir(dataRoot, { withFileTypes: true });
  const campaigns = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<CampaignSummary | null> => {
        try {
          const campaign = await getCampaign(entry.name);
          return {
            id: campaign.id,
            title: campaign.title,
            joinCode: campaign.joinCode,
            status: campaign.status,
            updatedAt: campaign.updatedAt,
            playerCount: campaign.players.length,
            hostActiveAt: campaign.hostActiveAt,
            isHostActive: campaign.status === "active" && isHostHeartbeatActive(campaign.id),
            campaignType: campaign.campaignType,
            isRandomized: campaign.isRandomized,
            campaignLength: campaign.campaignLength,
            rulesMode: campaign.rulesMode,
            difficulty: campaign.difficulty,
            rollMode: campaign.rollMode,
            endingKind: campaign.ending?.kind
          };
        } catch {
          return null;
        }
      })
  );
  return campaigns
    .filter((campaign): campaign is CampaignSummary => campaign !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createCampaign(
  title: string,
  startingStory: string,
  storyCharacters: Array<{ name: string; description: string; status?: string }> | string[],
  isRandomized?: boolean,
  campaignLength?: string,
  rulesMode?: "casual" | "full",
  campaignType?: CampaignType,
  difficulty?: Difficulty | string,
  rollMode?: RollMode | string
) {
  await ensureDataRoot();
  const now = new Date().toISOString();
  const cleanStory = startingStory.trim();

  const normalizedStoryCharacters = (storyCharacters || []).map((char) => {
    if (typeof char === "string") {
      return { id: createId("character"), name: char.trim(), description: "", status: "Starting NPC" };
    }
    return {
      id: createId("character"),
      name: (char.name || "NPC").trim(),
      description: (char.description || "").trim(),
      status: char.status || "Starting NPC"
    };
  }).filter((c) => c.name);

  const validDifficulty: Difficulty[] = ["easy", "medium", "hard", "insane"];
  const validRollMode: RollMode[] = ["light", "standard", "heavy", "all"];
  const resolvedDifficulty: Difficulty = validDifficulty.includes(difficulty as Difficulty)
    ? (difficulty as Difficulty)
    : "medium";
  const resolvedRollMode: RollMode = validRollMode.includes(rollMode as RollMode)
    ? (rollMode as RollMode)
    : "standard";

  const campaign: Campaign = {
    id: createId("campaign"),
    title: title.trim() || "Untitled Adventure",
    joinCode: createJoinCode(),
    status: "lobby",
    hostStartedAt: now,
    players: [],
    startingStory: cleanStory,
    storyCharacters: normalizedStoryCharacters,
    rulesMode: rulesMode || "casual",
    difficulty: resolvedDifficulty,
    rollMode: resolvedRollMode,
    currentScene: cleanStory || "A quiet chamber where legends begin. The air is thick with anticipation.",
    overview: "Gathering players. Prepare for adventure...",
    displayEvents: [
      {
        id: createId("event"),
        type: "system",
        speaker: "Host",
        content: cleanStory || "A quiet chamber where legends begin. The air is thick with anticipation.",
        createdAt: now
      }
    ],
    suggestedActions: defaultSuggestedActions(),
    playerActions: {},
    partyActions: [],
    memory: cleanStory,
    images: [],
    portraits: [],
    messages: cleanStory
      ? [{ id: createId("msg"), role: "user", name: "Setup", content: cleanStory, createdAt: now }]
      : [],
    campaignType: campaignType === "dnd" ? "dnd" : "tabletop",
    isRandomized: !!isRandomized,
    campaignLength: (campaignLength as any) || "auto",
    showQuestOnTV: true,
    showQuestOnController: true,
    showPartyInventories: false,
    showPartyAbilities: false,
    showNpcInventories: false,
    showNpcAbilities: false,
    createdAt: now,
    updatedAt: now
  };

  // D&D is always fantasy. Non-D&D campaigns leave the theme unset here and
  // let the DM AI pick the score before the lobby opens (see chooseCampaignTheme).
  campaign.musicTheme = campaignType === "dnd" ? "fantasy" : undefined;

  await mkdir(campaignDir(campaign.id), { recursive: true });
  await saveCampaign(campaign);
  // notes.md is the DM's free-form worldbuilding scratchpad — durable lore, NPC
  // relationships, hidden threads and secrets that don't fit the short in-context
  // memory line. (storyline.md holds the structured arc; quest_log.md holds the
  // player-facing objectives.) Seed it with a header explaining its purpose so a
  // brand-new campaign folder isn't just a bare title.
  await writeCampaignTextFile(
    campaign.id,
    "notes.md",
    `# ${campaign.title} — DM world notes\n\n> Free-form scratchpad for lore, NPC ties, secrets, and foreshadowing.\n> The arc lives in storyline.md; player objectives live in quest_log.md.\n\n${campaign.memory}\n`
  );
  return campaign;
}

export async function getCampaign(id: string): Promise<Campaign> {
  const draft = activeDrafts.get(id);
  if (draft) {
    return JSON.parse(JSON.stringify(draft)) as Campaign;
  }
  const raw = await readFile(campaignFile(id), "utf8");
  let parsed: Partial<Campaign> & { suggestedActions?: unknown[]; playerActions?: unknown; partyActions?: unknown[]; displayEvents?: unknown[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Campaign ${id} save is corrupt (invalid JSON in campaign.json): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const environment = JSON.parse(await readFile(environmentFile(id), "utf8")) as Record<string, any>;
    parsed.locations = environment.locations;
    parsed.focusedLocationId = environment.focusedLocationId;
    for (const player of parsed.players || []) {
      const position = environment.playerPositions?.[player.id];
      if (position) Object.assign(player, position);
    }
    for (const npc of parsed.storyCharacters || []) {
      const position = environment.npcPositions?.[npc.id];
      if (position) Object.assign(npc, position);
    }
  } catch {
    // Legacy saves keep environment state in campaign.json and migrate on save.
  }
  const campaign = normalizeCampaign(parsed);
  if (campaign.dmStatus) {
    const updatedAt = Date.parse(campaign.updatedAt || "");
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > DM_STATUS_STALE_MS) {
      campaign.dmStatus = undefined;
      campaign.dmPhase = undefined;
    }
  }
  try {
    campaign.questLog = await readCampaignTextFile(id, "quest_log.md");
  } catch {
    // Ignore if quest_log.md does not exist yet
  }
  try {
    campaign.storyline = await readCampaignTextFile(id, "storyline.md");
  } catch {
    // Ignore if storyline.md does not exist yet (written on the opening turn)
  }
  return campaign;
}

export async function saveCampaign(campaign: Campaign) {
  campaign.updatedAt = new Date().toISOString();

  const draft = activeDrafts.get(campaign.id);
  if (draft) {
    activeDrafts.set(campaign.id, JSON.parse(JSON.stringify(campaign)));
    try {
      const raw = await readFile(campaignFile(campaign.id), "utf8");
      const diskCampaign = JSON.parse(raw) as Campaign;
      diskCampaign.dmStatus = campaign.dmStatus;
      diskCampaign.dmPhase = campaign.dmPhase;
      diskCampaign.updatedAt = campaign.updatedAt;
      await writeCampaignStateFiles(diskCampaign, false);
    } catch (err) {
      await mkdir(campaignDir(campaign.id), { recursive: true });
      await writeCampaignStateFiles(campaign, false);
    }
    return;
  }

  await mkdir(campaignDir(campaign.id), { recursive: true });
  await writeCampaignStateFiles(campaign, true);
}

async function writeCampaignStateFiles(campaign: Campaign, writeEnvironment: boolean) {
  const campaignState = JSON.parse(JSON.stringify(campaign)) as Campaign;
  delete campaignState.locations;
  delete campaignState.focusedLocationId;
  for (const player of campaignState.players) {
    delete player.locationId;
    delete player.zoneId;
  }
  for (const npc of campaignState.storyCharacters) {
    delete npc.locationId;
    delete npc.zoneId;
  }
  await writeFile(campaignFile(campaign.id), JSON.stringify(campaignState, null, 2), "utf8");
  if (!writeEnvironment) return;
  const environment = {
    version: 1,
    focusedLocationId: campaign.focusedLocationId,
    locations: campaign.locations || [],
    playerPositions: Object.fromEntries(campaign.players.map((p) => [p.id, { locationId: p.locationId, zoneId: p.zoneId }])),
    npcPositions: Object.fromEntries(campaign.storyCharacters.map((n) => [n.id, { locationId: n.locationId, zoneId: n.zoneId }]))
  };
  await writeFile(environmentFile(campaign.id), JSON.stringify(environment, null, 2), "utf8");
}

export function isValidImageUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const u = url.trim();
  return u.startsWith("http://") || u.startsWith("https://") || u.startsWith("/") || u.startsWith("data:");
}

export function safePushDisplayEvent(campaign: Campaign, event: Omit<DisplayEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }) {
  const contentTrimmed = String(event.content || "").trim();

  // Enforce deduplication for narration and dialogue events
  if (event.type === "narration" || event.type === "dialogue") {
    if (!contentTrimmed) return;
    const isDuplicate = campaign.displayEvents.slice(-15).some((e) => {
      return (e.type === "narration" || e.type === "dialogue") &&
             e.speaker === event.speaker &&
             String(e.content || "").trim() === contentTrimmed;
    });
    if (isDuplicate) {
      return; // Skip duplicate narration/dialogue
    }
  }

  campaign.displayEvents.push({
    id: event.id || createId("event"),
    type: event.type,
    speaker: event.speaker,
    playerId: event.playerId,
    content: event.content !== undefined ? contentTrimmed : undefined,
    dice: event.dice,
    itemUsed: event.itemUsed,
    abilityUsed: event.abilityUsed,
    effect: event.effect ? normalizeBeatEffect(event.effect) : undefined,
    createdAt: event.createdAt || new Date().toISOString()
  });

  campaign.displayEvents = campaign.displayEvents.slice(-80);
  return campaign.displayEvents[campaign.displayEvents.length - 1];
}

export async function appendMessage(campaign: Campaign, message: Omit<ChatMessage, "id" | "createdAt">) {
  campaign.messages.push({ ...message, id: createId("msg"), createdAt: new Date().toISOString() });
  await saveCampaign(campaign);
}

export function defaultSuggestedActions(): SuggestedAction[] {
  return [];
}

function normalizeCampaign(raw: Partial<Campaign> & { suggestedActions?: unknown[]; playerActions?: unknown; partyActions?: unknown[]; displayEvents?: unknown[] }): Campaign {
  const now = new Date().toISOString();
  const players = Array.isArray(raw.players) ? raw.players.map((player) => normalizePlayer(player as Partial<Player>, now)) : [];
  const currentScene = String(raw.currentScene || "The adventure has not begun.");
  const status: Campaign["status"] =

    raw.status === "active" ? "active" : raw.status === "completed" ? "completed" : "lobby";
  const isCampaignActive = status === "active";
  const suggestedActions = normalizeSuggestedActions(raw.suggestedActions, !isCampaignActive && status !== "completed");
  const validDifficulty: Difficulty[] = ["easy", "medium", "hard", "insane"];
  const validRollMode: RollMode[] = ["light", "standard", "heavy", "all"];
  const normalized: Campaign = {
    id: String(raw.id || createId("campaign")),
    title: String(raw.title || "Untitled Adventure"),
    joinCode: String(raw.joinCode || createJoinCode()).toUpperCase(),
    status,
    hostStartedAt: raw.hostStartedAt,
    hostActiveAt: raw.hostActiveAt,
    partyLeaderId: raw.partyLeaderId || players[0]?.id,
    players,
    startingStory: String(raw.startingStory || raw.memory || ""),
    storyCharacters: Array.isArray(raw.storyCharacters) ? raw.storyCharacters.map(normalizeStoryCharacter) : [],
    currentScene,
    overview: String(raw.overview || currentScene),
    displayEvents: normalizeDisplayEvents(raw.displayEvents, currentScene, now),
    suggestedActions,
    playerActions: normalizePlayerActions(raw.playerActions, players, suggestedActions, !isCampaignActive && status !== "completed"),
    partyActions: normalizeOptionalSuggestedActions(raw.partyActions),
    turnState: normalizeTurnState((raw as any).turnState),
    pendingActions: normalizePendingActions((raw as any).pendingActions),
    locations: normalizeLocations((raw as any).locations),
    focusedLocationId: typeof (raw as any).focusedLocationId === "string" ? (raw as any).focusedLocationId : undefined,
    memory: String(raw.memory || ""),
    images: Array.isArray(raw.images) ? raw.images : [],
    portraits: Array.isArray(raw.portraits) ? raw.portraits : [],
    currentImageUrl: raw.currentImageUrl,
    backdropScene: raw.backdropScene ? String(raw.backdropScene) : undefined,
    ambience: normalizeAmbience(raw.ambience),
    effects: normalizeEffects(raw.effects),
    dmStatus: raw.dmStatus ? String(raw.dmStatus) : undefined,
    dmPhase: raw.dmPhase && typeof raw.dmPhase === "string" ? raw.dmPhase : undefined,
    presenting: normalizePresenting((raw as any).presenting),
    storySummary: typeof raw.storySummary === "string" ? raw.storySummary.slice(0, 20_000) : undefined,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    campaignType: normalizeCampaignType(raw),
    musicTheme: MUSIC_THEMES.includes(raw.musicTheme as MusicTheme) ? raw.musicTheme : undefined,
    isRandomized: !!raw.isRandomized,
    campaignLength: raw.campaignLength || "auto",
    rulesMode: raw.rulesMode === "full" ? "full" : "casual",
    difficulty: validDifficulty.includes(raw.difficulty as Difficulty) ? (raw.difficulty as Difficulty) : "medium",
    rollMode: validRollMode.includes(raw.rollMode as RollMode) ? (raw.rollMode as RollMode) : "standard",
    ending: normalizeEnding(raw.ending),
    storyline: raw.storyline,
    questLog: raw.questLog,
    showQuestOnTV: raw.showQuestOnTV !== undefined ? !!raw.showQuestOnTV : true,
    showQuestOnController: raw.showQuestOnController !== undefined ? !!raw.showQuestOnController : true,
    showPartyInventories: raw.showPartyInventories !== undefined ? !!raw.showPartyInventories : false,
    showPartyAbilities: raw.showPartyAbilities !== undefined ? !!raw.showPartyAbilities : false,
    showNpcInventories: raw.showNpcInventories !== undefined ? !!raw.showNpcInventories : false,
    showNpcAbilities: raw.showNpcAbilities !== undefined ? !!raw.showNpcAbilities : false,
    createdAt: String(raw.createdAt || now),
    updatedAt: String(raw.updatedAt || now)
  };
  ensureLocations(normalized);
  return normalized;
}

const AMBIENCE_MOODS: AmbienceMood[] = ["calm", "tense", "adrenaline", "battle", "boss", "mystery", "dread", "triumph", "wonder", "somber", "outro"];
const EFFECT_KINDS: StageEffectKind[] = ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"];
const ENDING_KINDS: EndingKind[] = ["victory", "defeat", "bittersweet", "escape", "draw", "cliffhanger"];

function normalizeEndingStats(raw: unknown): CampaignEnding["stats"] {
  if (!Array.isArray(raw)) return undefined;
  const stats = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      label: String(item.label || "").trim(),
      value: String(item.value ?? "").trim()
    }))
    .filter((item) => item.label && item.value)
    .slice(0, 8);
  return stats.length ? stats : undefined;
}

function normalizeEndingCast(raw: unknown): EndingCastMember[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cast = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const member: EndingCastMember = {
        playerId: typeof item.playerId === "string" && item.playerId.trim() ? item.playerId.trim() : undefined,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined,
        title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : undefined,
        fate: typeof item.fate === "string" && item.fate.trim() ? item.fate.trim() : undefined,
        stats: normalizeEndingStats(item.stats)?.slice(0, 4)
      };
      return member;
    })
    // Keep an entry only if it can be matched to a player and carries something.
    .filter((m) => (m.playerId || m.name) && (m.title || m.fate || m.stats))
    .slice(0, 12);
  return cast.length ? cast : undefined;
}

function normalizeEnding(raw: unknown): CampaignEnding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Partial<CampaignEnding>;
  const kind = ENDING_KINDS.includes(item.kind as EndingKind) ? (item.kind as EndingKind) : "bittersweet";
  const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : "The End";
  const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "The saga closes.";
  return {
    kind,
    title,
    summary,
    endedAt: String(item.endedAt || new Date().toISOString()),
    highlights: Array.isArray(item.highlights)
      ? item.highlights.map(String).map((h) => h.trim()).filter(Boolean).slice(0, 12)
      : undefined,
    stats: normalizeEndingStats(item.stats),
    cast: normalizeEndingCast(item.cast)
  };
}

function normalizeAmbience(raw: unknown): Ambience | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Partial<Ambience>;
  const mood = AMBIENCE_MOODS.includes(item.mood as AmbienceMood) ? (item.mood as AmbienceMood) : "calm";
  const intensity = Math.max(0, Math.min(1, Number(item.intensity ?? 0.5)));
  return {
    mood,
    intensity: Number.isFinite(intensity) ? intensity : 0.5,
    note: typeof item.note === "string" ? item.note : undefined,
    updatedAt: String(item.updatedAt || new Date().toISOString())
  };
}

function normalizeEffects(raw: unknown): StageEffect[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const repeatRaw = Number(item.repeat ?? 1);
      const delayRaw = Number(item.delayMs ?? 0);
      return {
        id: String(item.id || createId("fx")),
        kind: EFFECT_KINDS.includes(item.kind as StageEffectKind) ? (item.kind as StageEffectKind) : "embers",
        strength: Math.max(0, Math.min(1, Number(item.strength ?? 0.6))) || 0.6,
        repeat: Number.isFinite(repeatRaw) ? Math.max(1, Math.min(8, Math.round(repeatRaw))) : undefined,
        delayMs: Number.isFinite(delayRaw) ? Math.max(0, Math.min(5000, Math.round(delayRaw))) : undefined,
        createdAt: String(item.createdAt || new Date().toISOString())
      };
    })
    .slice(-12);
}

/**
 * Validate a beat-linked effect (DisplayEvent.effect) from untrusted model
 * output. Returns undefined when the kind is missing/invalid so a bad payload
 * simply drops the effect rather than firing a random one.
 */
export function normalizeBeatEffect(raw: unknown): import("./types").BeatEffect | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const item = raw as Record<string, unknown>;
  if (!EFFECT_KINDS.includes(item.kind as StageEffectKind)) return undefined;
  const strengthRaw = Number(item.strength ?? 0.6);
  const repeatRaw = Number(item.repeat ?? 1);
  const delayRaw = Number(item.delayMs ?? 0);
  return {
    kind: item.kind as StageEffectKind,
    strength: Number.isFinite(strengthRaw) ? Math.max(0, Math.min(1, strengthRaw)) : 0.6,
    repeat: Number.isFinite(repeatRaw) ? Math.max(1, Math.min(8, Math.round(repeatRaw))) : undefined,
    delayMs: Number.isFinite(delayRaw) ? Math.max(0, Math.min(5000, Math.round(delayRaw))) : undefined
  };
}

export function pushStageEffect(
  campaign: Campaign,
  kind: StageEffectKind,
  strength: number,
  opts?: { repeat?: number; delayMs?: number }
) {
  if (!campaign.effects) campaign.effects = [];
  const repeat = opts?.repeat != null && Number.isFinite(opts.repeat)
    ? Math.max(1, Math.min(8, Math.round(opts.repeat)))
    : undefined;
  const delayMs = opts?.delayMs != null && Number.isFinite(opts.delayMs)
    ? Math.max(0, Math.min(5000, Math.round(opts.delayMs)))
    : undefined;
  campaign.effects.push({
    id: createId("fx"),
    kind,
    strength: Math.max(0, Math.min(1, strength)),
    repeat,
    delayMs,
    createdAt: new Date().toISOString()
  });
  campaign.effects = campaign.effects.slice(-12);
}

/** Seal the campaign with a win/loss/draw/cliffhanger/bittersweet/escape ending and clear controller actions. */
export function endCampaign(
  campaign: Campaign,
  payload: { kind: string; title: string; summary: string; highlights?: string[]; stats?: Array<{ label: string; value: string }>; cast?: unknown }
) {
  const kind = ENDING_KINDS.includes(payload.kind as EndingKind) ? (payload.kind as EndingKind) : "bittersweet";
  const title = (payload.title || "The End").trim() || "The End";
  const summary = (payload.summary || "The saga closes.").trim() || "The saga closes.";
  const highlights = Array.isArray(payload.highlights)
    ? payload.highlights.map(String).map((h) => h.trim()).filter(Boolean).slice(0, 12)
    : undefined;
  const stats = normalizeEndingStats(payload.stats);
  const cast = normalizeEndingCast(payload.cast);
  const endedAt = new Date().toISOString();
  campaign.status = "completed";
  campaign.ending = { kind, title, summary, endedAt, highlights, stats, cast };
  campaign.ambience = {
    mood: "outro",
    intensity: 0.7,
    note: title,
    updatedAt: endedAt
  };
  campaign.suggestedActions = [];
  campaign.partyActions = [];
  campaign.playerActions = {};
  campaign.turnState = { mode: "exploration" };
  campaign.pendingActions = {};
  for (const player of campaign.players) {
    campaign.playerActions[player.id] = [];
  }
  safePushDisplayEvent(campaign, {
    type: "system",
    speaker: "SYSTEM",
    content: `The saga ends - ${kind.toUpperCase()}: ${title}`
  });
}

function normalizeCampaignType(raw: Partial<Campaign>): CampaignType {
  if (raw.campaignType === "dnd" || raw.campaignType === "tabletop") return raw.campaignType;
  return raw.rulesMode === "full" ? "dnd" : "tabletop";
}

function normalizeStoryCharacter(char: any): StoryCharacter {
  return {
    id: String(char.id || createId("character")),
    name: String(char.name || "NPC"),
    description: String(char.description || ""),
    claimedByPlayerId: char.claimedByPlayerId,
    portraitUrl: char.portraitUrl,
    status: char.status,
    inventory: Array.isArray(char.inventory) ? char.inventory.map(String) : [],
    abilities: Array.isArray(char.abilities) ? char.abilities.map(String) : [],
    stats: Array.isArray(char.stats) ? char.stats.map((s: any) => ({
      name: String(s.name || "Stat"),
      value: Number(s.value ?? 0),
      maxValue: Number(s.maxValue ?? 10),
      color: s.color ? String(s.color) : undefined
    })) : [],
    color: char.color ? String(char.color) : undefined,
    isGroup: char.isGroup === true || undefined,
    count: Number.isFinite(Number(char.count)) ? Math.max(0, Math.round(Number(char.count))) : undefined,
    maxCount: Number.isFinite(Number(char.maxCount)) ? Math.max(0, Math.round(Number(char.maxCount))) : undefined,
    conditions: Array.isArray(char.conditions) ? char.conditions.map(String) : undefined,
    canAct: typeof char.canAct === "boolean" ? char.canAct : undefined,
    locationId: char.locationId ? String(char.locationId) : undefined
  };
}

function normalizePlayer(player: Partial<Player>, now: string): Player {
  return {
    id: String(player.id || createId("player")),
    name: String(player.name || "Player"),
    characterName: player.characterName,
    background: player.background,
    personality: player.personality,
    portraitUrl: player.portraitUrl,
    portraitPrompt: player.portraitPrompt,
    status: player.status,
    joinedAt: player.joinedAt || now,
    inventory: Array.isArray(player.inventory) ? player.inventory : [],
    abilities: Array.isArray(player.abilities) ? player.abilities : [],
    notes: String(player.notes || ""),
    stats: Array.isArray(player.stats) ? player.stats.map(s => ({
      name: String(s.name || "Stat"),
      value: Number(s.value ?? 0),
      maxValue: Number(s.maxValue ?? 10),
      color: s.color ? String(s.color) : undefined
    })) : [
      { name: "HP", value: 20, maxValue: 20, color: "red" }
    ],
    color: player.color ? String(player.color) : undefined,
    conditions: Array.isArray(player.conditions) ? player.conditions.map(String) : undefined,
    canAct: typeof player.canAct === "boolean" ? player.canAct : undefined,
    lastSeenAt: Number.isFinite(Number(player.lastSeenAt)) ? Number(player.lastSeenAt) : undefined,
    away: typeof player.away === "boolean" ? player.away : undefined,
    wovenOut: typeof player.wovenOut === "boolean" ? player.wovenOut : undefined,
    locationId: player.locationId ? String(player.locationId) : undefined
  };
}

function normalizeDisplayEvents(events: unknown[] | undefined, fallbackScene: string, now: string): DisplayEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [{ id: createId("event"), type: "scene", speaker: "Narrator", content: fallbackScene, createdAt: now }];
  }

  return events.map((event) => {
    const item = event as Partial<DisplayEvent>;
    const type = ["narration", "dialogue", "playerAction", "dice", "scene", "system"].includes(String(item.type)) ? item.type : "narration";
    return {
      id: String(item.id || createId("event")),
      type: type as DisplayEvent["type"],
      speaker: item.speaker,
      playerId: item.playerId,
      content: item.content,
      dice: item.dice,
      itemUsed: item.itemUsed,
      abilityUsed: item.abilityUsed,
      effect: item.effect ? normalizeBeatEffect(item.effect) : undefined,
      createdAt: String(item.createdAt || now)
    };
  }).slice(-80);
}

function normalizePlayerActions(rawActions: unknown, players: Player[], fallback: SuggestedAction[], useFallback = true) {
  const result: Record<string, SuggestedAction[]> = {};
  const input = rawActions && typeof rawActions === "object" ? rawActions as Record<string, unknown> : {};
  for (const player of players) {
    const playerInput = input[player.id] as unknown[] | undefined;
    if (playerInput !== undefined) {
      result[player.id] = normalizeSuggestedActions(playerInput, useFallback);
    } else {
      result[player.id] = useFallback ? fallback : [];
    }
  }
  return result;
}

function normalizeSuggestedActions(actions: unknown[] | undefined, useFallback = true): SuggestedAction[] {
  if (!Array.isArray(actions) || actions.length === 0) return useFallback ? defaultSuggestedActions() : [];
  return actions.map((action) => {
    if (typeof action === "string") return { title: action, prompt: action };
    const item = action as Partial<SuggestedAction>;
    return { title: String(item.title || item.prompt || "Act"), prompt: String(item.prompt || item.title || "Act") };
  }).slice(0, 6);
}

function normalizeOptionalSuggestedActions(actions: unknown[] | undefined): SuggestedAction[] {
  if (!Array.isArray(actions) || actions.length === 0) return [];
  return normalizeSuggestedActions(actions, false);
}

function normalizeTurnState(raw: any): TurnState | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const mode = raw.mode === "combat" ? "combat" : "exploration";
  return {
    mode,
    order: Array.isArray(raw.order) ? raw.order.map(String) : undefined,
    activeId: typeof raw.activeId === "string" ? raw.activeId : undefined,
    round: Number.isFinite(Number(raw.round)) ? Math.max(0, Math.round(Number(raw.round))) : undefined,
    deadlineAt: typeof raw.deadlineAt === "string" ? raw.deadlineAt : undefined
  };
}

/**
 * Presence gate is stale-checked at read time rather than here: a raw shape
 * is trusted structurally, but callers should still ignore an old updatedAt
 * (see PRESENTING_STALE_MS) so a closed/crashed TV can never permanently lock
 * the controllers.
 */
function normalizePresenting(raw: any): Campaign["presenting"] {
  if (!raw || typeof raw !== "object") return undefined;
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt)) return undefined;
  return { active: !!raw.active, updatedAt };
}

export const DEFAULT_LOCATION_ID = "loc_default";

function normalizeSceneObjects(raw: any): SceneObject[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o): SceneObject | null => {
      if (typeof o === "string") return { name: o.trim() };
      if (!o || typeof o !== "object") return null;
      const name = String(o.name || "").trim();
      if (!name) return null;
      return {
        name,
        note: typeof o.note === "string" ? o.note : undefined,
        takeable: typeof o.takeable === "boolean" ? o.takeable : undefined,
        kind: ["item", "container", "interactable", "obstacle", "clue", "furniture", "other"].includes(o.kind) ? o.kind : undefined,
        zoneId: typeof o.zoneId === "string" ? o.zoneId : undefined,
        traits: Array.isArray(o.traits) ? o.traits.map(String).filter(Boolean).slice(0, 12) : undefined,
        state: o.state && typeof o.state === "object" && !Array.isArray(o.state) ? o.state : undefined
      };
    })
    .filter((o): o is SceneObject => !!o)
    .slice(0, 30);
}

function normalizeLocations(raw: any): Location[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Location[] = [];
  for (const l of raw) {
    if (!l || typeof l !== "object") continue;
    const id = String(l.id || "").trim();
    if (!id) continue;
    out.push({
      id,
      name: String(l.name || "A place").trim(),
      description: typeof l.description === "string" ? l.description : undefined,
      objects: normalizeSceneObjects(l.objects),
      cover: Array.isArray(l.cover) ? l.cover.map(String).filter(Boolean).slice(0, 20) : [],
      exits: Array.isArray(l.exits) ? l.exits.map(String).filter(Boolean).slice(0, 20) : [],
      zones: Array.isArray(l.zones) ? l.zones.map((z: any) => ({
        id: String(z.id || "").trim(),
        name: String(z.name || "").trim(),
        description: typeof z.description === "string" ? z.description : undefined,
        adjacentZoneIds: Array.isArray(z.adjacentZoneIds) ? z.adjacentZoneIds.map(String).filter(Boolean) : []
      })).filter((z: any) => z.id && z.name).slice(0, 20) : undefined,
      connections: Array.isArray(l.connections) ? l.connections.map((c: any) => ({
        destinationId: String(c.destinationId || "").trim(),
        label: typeof c.label === "string" ? c.label : undefined,
        travelTime: typeof c.travelTime === "string" ? c.travelTime : undefined,
        communication: ["open", "shouting", "blocked"].includes(c.communication) ? c.communication : undefined
      })).filter((c: any) => c.destinationId).slice(0, 20) : undefined,
      hazards: Array.isArray(l.hazards) ? l.hazards.map(String).filter(Boolean).slice(0, 20) : undefined,
      imageId: typeof l.imageId === "string" ? l.imageId : undefined,
      backdropScene: typeof l.backdropScene === "string" ? l.backdropScene : undefined,
      ambience: normalizeAmbience(l.ambience),
      turnState: normalizeTurnState(l.turnState),
      pendingActions: normalizePendingActions(l.pendingActions),
      createdAt: String(l.createdAt || new Date().toISOString())
    });
  }
  return out.length ? out : undefined;
}

/**
 * Guarantee the campaign has ≥1 location and that every player/NPC and the
 * focus point to a real one. Idempotent — the default location keeps a stable
 * id, so calling this on every load doesn't churn ids. Migrates legacy saves
 * (single implicit scene) into the locations model.
 */
export function ensureLocations(campaign: Campaign): Campaign {
  if (!Array.isArray(campaign.locations)) campaign.locations = [];
  if (campaign.locations.length === 0) {
    const imageId = campaign.currentImageUrl
      ? (campaign.images || []).find((img) => img.url === campaign.currentImageUrl)?.id
      : undefined;
    campaign.locations.push({
      id: DEFAULT_LOCATION_ID,
      name: campaign.currentScene || "The scene",
      description: campaign.overview || undefined,
      objects: [],
      cover: [],
      exits: [],
      imageId,
      backdropScene: campaign.backdropScene,
      ambience: campaign.ambience,
      turnState: campaign.turnState || { mode: "exploration" },
      pendingActions: campaign.pendingActions,
      createdAt: campaign.createdAt || new Date().toISOString()
    });
  }
  const ids = new Set(campaign.locations.map((l) => l.id));
  const fallback = campaign.locations[0].id;
  if (!campaign.focusedLocationId || !ids.has(campaign.focusedLocationId)) {
    campaign.focusedLocationId = fallback;
  }
  for (const p of campaign.players) {
    if (!p.locationId || !ids.has(p.locationId)) p.locationId = fallback;
  }
  for (const c of campaign.storyCharacters) {
    if (!c.locationId || !ids.has(c.locationId)) c.locationId = fallback;
  }
  return campaign;
}

/** The location the TV is currently showing. Always returns one (ensures first). */
export function getFocusedLocation(campaign: Campaign): Location {
  ensureLocations(campaign);
  return (
    campaign.locations!.find((l) => l.id === campaign.focusedLocationId) || campaign.locations![0]
  );
}

/**
 * Cut the TV to a location: point focus at it and restore its backdrop, scene
 * text, and ambience so the shared screen shows that group's world. Also mirrors
 * the location's turn state up to the campaign (for the TV/host watchers).
 */
export function applyFocus(campaign: Campaign, loc: Location) {
  ensureLocations(campaign);
  campaign.focusedLocationId = loc.id;
  if (loc.name) campaign.currentScene = loc.name;
  if (typeof loc.description === "string" && loc.description.trim()) campaign.overview = loc.description;
  if (loc.imageId) {
    const img = (campaign.images || []).find((i) => i.id === loc.imageId);
    if (img) campaign.currentImageUrl = img.url;
  }
  if (loc.ambience) campaign.ambience = loc.ambience;
  campaign.backdropScene = loc.backdropScene;
  // Mirror the focused location's live turn state up to the campaign.
  campaign.turnState = loc.turnState;
  campaign.pendingActions = loc.pendingActions;
}

/**
 * Save whatever backdrop/ambience the campaign currently shows back INTO the
 * focused location, so when the DM later cuts away and returns, applyFocus can
 * restore it instantly (no repaint). Call after a turn's backdrop reconcile.
 */
export function persistFocusedLocation(campaign: Campaign) {
  ensureLocations(campaign);
  const loc =
    campaign.locations!.find((l) => l.id === campaign.focusedLocationId) || campaign.locations![0];
  if (!loc) return;
  if (campaign.currentImageUrl) {
    const img = (campaign.images || []).find((i) => i.url === campaign.currentImageUrl);
    if (img) loc.imageId = img.id;
  }
  if (typeof campaign.backdropScene === "string") loc.backdropScene = campaign.backdropScene;
  if (campaign.ambience) loc.ambience = campaign.ambience;
}

/** The location a given player is in (falls back to the focused one). */
export function getPlayerLocation(campaign: Campaign, playerId: string): Location {
  ensureLocations(campaign);
  const player = campaign.players.find((p) => p.id === playerId);
  return (
    campaign.locations!.find((l) => l.id === player?.locationId) || getFocusedLocation(campaign)
  );
}

function normalizePendingActions(raw: any): Record<string, PendingAction> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, PendingAction> = {};
  for (const [pid, val] of Object.entries(raw)) {
    const v = val as any;
    if (!v || typeof v !== "object" || typeof v.action !== "string") continue;
    out[pid] = {
      action: v.action,
      display: typeof v.display === "string" ? v.display : undefined,
      actionId: typeof v.actionId === "string" ? v.actionId : undefined,
      partyActionId: typeof v.partyActionId === "string" ? v.partyActionId : undefined,
      lockedAt: typeof v.lockedAt === "string" ? v.lockedAt : new Date().toISOString()
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export async function readCampaignTextFile(campaignId: string, filePath: string) {
  const safePath = safeCampaignRelativePath(filePath);
  const fullPath = path.join(campaignDir(campaignId), safePath);
  const root = campaignDir(campaignId);
  if (!fullPath.startsWith(root)) throw new Error("Unsafe campaign file path");
  return readFile(fullPath, "utf8");
}

export async function writeCampaignTextFile(campaignId: string, filePath: string, content: string) {
  const safePath = safeCampaignRelativePath(filePath);
  const fullPath = path.join(campaignDir(campaignId), safePath);
  const root = campaignDir(campaignId);
  if (!fullPath.startsWith(root)) throw new Error("Unsafe campaign file path");
  await mkdir(path.dirname(fullPath), { recursive: true });
  const output = safePath.toLowerCase() === "quest_log.md" ? sanitizeQuestLog(content) : content;
  await writeFile(fullPath, output, "utf8");
}

function sanitizeQuestLog(content: string) {
  return content
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*]\s*)?\*{0,2}(?:victory|defeat|win|lose|loss)\s+conditions?\*{0,2}\s*:/i.test(line))
    .join("\n")
    .trim();
}

export async function logCampaignDebug(campaignId: string, message: string) {
  try {
    const dir = campaignDir(campaignId);
    await mkdir(dir, { recursive: true });
    const logPath = path.join(dir, "debug.log");
    const timestamp = new Date().toISOString();
    await appendFile(logPath, `[${timestamp}] ${message}\n`, "utf8");
  } catch (err) {
    console.error("Failed to write campaign debug log:", err);
  }
}

export async function downloadAndSaveImage(
  campaignId: string,
  url: string,
  category: "players" | "npcs" | "backgrounds",
  subId?: string
): Promise<string> {
  if (!url || url.startsWith("/api/campaigns") || url.startsWith("data:") || url.startsWith("/")) {
    return url;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const cleanCampaignId = campaignId.replace(/[^a-zA-Z0-9_-]/g, "");
    const campaignDirName = path.join(dataRoot, cleanCampaignId);
    
    const relativeDir = subId ? path.join(category, subId.replace(/[^a-zA-Z0-9_-]/g, "")) : category;
    const destDir = path.join(campaignDirName, relativeDir);
    await mkdir(destDir, { recursive: true });

    const filename = subId ? `${subId.replace(/[^a-zA-Z0-9_-]/g, "")}.png` : `${createId("img")}.png`;
    const fullPath = path.join(destDir, filename);
    await writeFile(fullPath, buffer);

    const assetRelativePath = subId ? `${category}/${subId}/${filename}` : `${category}/${filename}`;
    return `/api/campaigns/${campaignId}/assets?path=${encodeURIComponent(assetRelativePath)}`;
  } catch (error) {
    console.error("Failed to download and save image locally, using original URL:", error);
    return url;
  }
}

export async function deleteCampaign(id: string) {
  const dir = campaignDir(id);
  await rm(dir, { recursive: true, force: true });
}
