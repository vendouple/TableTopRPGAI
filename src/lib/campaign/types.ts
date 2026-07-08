export type Role = "system" | "user" | "assistant" | "tool";
export type CampaignType = "tabletop" | "dnd";

/**
 * High-level loading phase the host PC uses to drive the timeline UI.
 * The DM/server writes this so the loading bar stays in lockstep with what
 * is actually happening (no more "painting image" while we are forging stats).
 *
 *   signal     – contacting Aqua / spinning up the DM
 *   world      – writing world lore / opening narrative
 *   scene      – composing the opening playable beat
 *   image      – painting a cinematic background or portrait
 *   sheet      – forging stats / inventory / abilities
 *   integrate  – splicing a player into the live timeline
 *   live       – about to hand control back to the table
 */
export type DmPhase =
  | "signal"
  | "world"
  | "scene"
  | "image"
  | "sheet"
  | "integrate"
  | "live";

export type PlayerStat = {
  name: string;
  value: number;
  maxValue: number;
  color?: string;
};

export type Player = {
  id: string;
  name: string;
  characterName?: string;
  background?: string;
  personality?: string;
  portraitUrl?: string;
  portraitPrompt?: string;
  status?: string;
  joinedAt?: string;
  inventory: string[];
  abilities: string[];
  notes: string;
  stats: PlayerStat[];
  color?: string;
};

export type StoryCharacter = {
  id: string;
  name: string;
  description: string;
  claimedByPlayerId?: string;
  portraitUrl?: string;
  status?: string;
  stats?: PlayerStat[];
  inventory?: string[];
  abilities?: string[];
  color?: string;
};

export type SuggestedAction = {
  title: string;
  prompt: string;
};

export type MessageSegment = {
  speaker: "narrator" | "npc" | "system" | "player";
  name?: string;
  content: string;
};

export type DiceEvent = {
  notation: string;
  reason: string;
  rolls: number[];
  modifier: number;
  total: number;
  d20Mode?: "normal" | "advantage" | "disadvantage";
};

export type DisplayEvent = {
  id: string;
  type: "narration" | "dialogue" | "playerAction" | "dice" | "scene" | "system";
  speaker?: string;
  playerId?: string;
  content?: string;
  dice?: DiceEvent;
  itemUsed?: string;
  abilityUsed?: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: Role;
  name?: string;
  content: string;
  segments?: MessageSegment[];
  createdAt: string;
};

/**
 * Mood palette the DM can set with the set_ambience tool. The host TV maps
 * each mood to a particle palette, fog density, color grade, and music bias.
 */
export type AmbienceMood =
  | "calm"
  | "tense"
  | "battle"
  | "mystery"
  | "dread"
  | "triumph"
  | "wonder"
  | "somber";

export type Ambience = {
  mood: AmbienceMood;
  /** 0..1 — how strongly the TV leans into the mood (particles, grade, pulse). */
  intensity: number;
  /** Optional flavor note, e.g. "rain hammers the tin roof". */
  note?: string;
  updatedAt: string;
};

export type StageEffectKind =
  | "shake"
  | "flash"
  | "embers"
  | "fog"
  | "rain"
  | "snow"
  | "darkness"
  | "heartbeat";

/** One-shot cinematic effect queued by the DM via trigger_effect. */
export type StageEffect = {
  id: string;
  kind: StageEffectKind;
  /** 0..1 strength. */
  strength: number;
  createdAt: string;
};

export type SceneImage = {
  id: string;
  url: string;
  prompt: string;
  createdAt: string;
};

export type PortraitImage = {
  id: string;
  url: string;
  prompt: string;
  characterName: string;
  createdAt: string;
};

export type Campaign = {
  id: string;
  title: string;
  joinCode: string;
  status: "lobby" | "active";
  hostStartedAt?: string;
  hostActiveAt?: string;
  partyLeaderId?: string;
  players: Player[];
  startingStory: string;
  storyCharacters: StoryCharacter[];
  currentScene: string;
  overview: string;
  displayEvents: DisplayEvent[];
  suggestedActions: SuggestedAction[];
  playerActions: Record<string, SuggestedAction[]>;
  partyActions: SuggestedAction[];
  memory: string;
  images: SceneImage[];
  portraits: PortraitImage[];
  currentImageUrl?: string;
  ambience?: Ambience;
  effects?: StageEffect[];
  dmStatus?: string;
  dmPhase?: DmPhase;
  messages: ChatMessage[];
  campaignType?: CampaignType;
  isRandomized?: boolean;
  campaignLength?: "auto" | "short" | "medium" | "long" | "extra_long" | "infinite";
  rulesMode?: "casual" | "full";
  questLog?: string;
  showQuestOnTV?: boolean;
  showQuestOnController?: boolean;
  showPartyInventories?: boolean;
  showPartyAbilities?: boolean;
  showNpcInventories?: boolean;
  showNpcAbilities?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CampaignSummary = Pick<Campaign, "id" | "title" | "joinCode" | "status" | "updatedAt" | "hostActiveAt" | "campaignType" | "isRandomized" | "campaignLength" | "rulesMode"> & {
  playerCount: number;
  isHostActive?: boolean;
};
