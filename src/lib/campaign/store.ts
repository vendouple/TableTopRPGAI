import { mkdir, readFile, readdir, writeFile, appendFile, rm } from "fs/promises";
import path from "path";
import { Ambience, AmbienceMood, Campaign, CampaignSummary, CampaignType, ChatMessage, DisplayEvent, Player, StageEffect, StageEffectKind, StoryCharacter, SuggestedAction } from "./types";
import { createId, createJoinCode } from "@/lib/utils/ids";
import { classifyMusicTheme, MUSIC_THEMES, MusicTheme } from "./musicTheme";

const dataRoot = path.join(process.cwd(), "data", "campaigns");

const activeHosts: Map<string, number> = ((globalThis as any).activeHosts ??= new Map<string, number>());

export function recordHostHeartbeat(campaignId: string) {
  activeHosts.set(campaignId, Date.now());
}

export function isHostHeartbeatActive(campaignId: string): boolean {
  const lastActive = activeHosts.get(campaignId);
  return lastActive ? (Date.now() - lastActive < 15000) : false;
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
            rulesMode: campaign.rulesMode
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
  campaignType?: CampaignType
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

  // Theme the score from whatever premise we have now. For sealed-envelope
  // campaigns the premise is empty, so this stays undefined and the DM's
  // opening turn fills it in once the world exists (see runDungeonMaster).
  campaign.musicTheme = classifyMusicTheme(campaign) || undefined;

  await mkdir(campaignDir(campaign.id), { recursive: true });
  await saveCampaign(campaign);
  await writeCampaignTextFile(campaign.id, "notes.md", `# ${campaign.title}\n\n${campaign.memory}\n`);
  return campaign;
}

export async function getCampaign(id: string): Promise<Campaign> {
  const draft = activeDrafts.get(id);
  if (draft) {
    return JSON.parse(JSON.stringify(draft)) as Campaign;
  }
  const raw = await readFile(campaignFile(id), "utf8");
  const campaign = normalizeCampaign(JSON.parse(raw) as Partial<Campaign> & { suggestedActions?: unknown[]; playerActions?: unknown; partyActions?: unknown[]; displayEvents?: unknown[] });
  try {
    campaign.questLog = await readCampaignTextFile(id, "quest_log.md");
  } catch {
    // Ignore if quest_log.md does not exist yet
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
      await writeFile(campaignFile(campaign.id), JSON.stringify(diskCampaign, null, 2), "utf8");
    } catch (err) {
      await mkdir(campaignDir(campaign.id), { recursive: true });
      await writeFile(campaignFile(campaign.id), JSON.stringify(campaign, null, 2), "utf8");
    }
    return;
  }

  await mkdir(campaignDir(campaign.id), { recursive: true });
  await writeFile(campaignFile(campaign.id), JSON.stringify(campaign, null, 2), "utf8");
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
    createdAt: event.createdAt || new Date().toISOString()
  });

  campaign.displayEvents = campaign.displayEvents.slice(-80);
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
  const isCampaignActive = raw.status === "active";
  const suggestedActions = normalizeSuggestedActions(raw.suggestedActions, !isCampaignActive);
  return {
    id: String(raw.id || createId("campaign")),
    title: String(raw.title || "Untitled Adventure"),
    joinCode: String(raw.joinCode || createJoinCode()).toUpperCase(),
    status: isCampaignActive ? "active" : "lobby",
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
    playerActions: normalizePlayerActions(raw.playerActions, players, suggestedActions, !isCampaignActive),
    partyActions: normalizeOptionalSuggestedActions(raw.partyActions),
    memory: String(raw.memory || ""),
    images: Array.isArray(raw.images) ? raw.images : [],
    portraits: Array.isArray(raw.portraits) ? raw.portraits : [],
    currentImageUrl: raw.currentImageUrl,
    ambience: normalizeAmbience(raw.ambience),
    effects: normalizeEffects(raw.effects),
    dmStatus: raw.dmStatus ? String(raw.dmStatus) : undefined,
    dmPhase: raw.dmPhase && typeof raw.dmPhase === "string" ? raw.dmPhase : undefined,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    campaignType: normalizeCampaignType(raw),
    musicTheme: MUSIC_THEMES.includes(raw.musicTheme as MusicTheme) ? raw.musicTheme : undefined,
    isRandomized: !!raw.isRandomized,
    campaignLength: raw.campaignLength || "auto",
    rulesMode: raw.rulesMode === "full" ? "full" : "casual",
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
}

const AMBIENCE_MOODS: AmbienceMood[] = ["calm", "tense", "battle", "mystery", "dread", "triumph", "wonder", "somber"];
const EFFECT_KINDS: StageEffectKind[] = ["shake", "flash", "embers", "fog", "rain", "snow", "darkness", "heartbeat"];

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
    .map((item) => ({
      id: String(item.id || createId("fx")),
      kind: EFFECT_KINDS.includes(item.kind as StageEffectKind) ? (item.kind as StageEffectKind) : "embers",
      strength: Math.max(0, Math.min(1, Number(item.strength ?? 0.6))) || 0.6,
      createdAt: String(item.createdAt || new Date().toISOString())
    }))
    .slice(-12);
}

export function pushStageEffect(campaign: Campaign, kind: StageEffectKind, strength: number) {
  if (!campaign.effects) campaign.effects = [];
  campaign.effects.push({
    id: createId("fx"),
    kind,
    strength: Math.max(0, Math.min(1, strength)),
    createdAt: new Date().toISOString()
  });
  campaign.effects = campaign.effects.slice(-12);
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
    color: char.color ? String(char.color) : undefined
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
    color: player.color ? String(player.color) : undefined
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
