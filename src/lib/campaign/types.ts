export type Role = "system" | "user" | "assistant" | "tool";
export type CampaignType = "tabletop" | "dnd";

/** How often the DM should call for d20 checks. */
export type RollMode = "light" | "standard" | "heavy" | "all";

/** Campaign challenge tuning — shifts DCs, damage willingness, enemy competence. */
export type Difficulty = "easy" | "medium" | "hard" | "insane";

/**
 * How the saga closed (or is closing).
 *   victory     – the party won
 *   defeat      – the party lost / died / failed
 *   bittersweet – mixed result, gains paid for in losses
 *   escape      – survived by fleeing; the threat remains
 *   draw        – stalemate; neither side prevailed
 *   cliffhanger – the story stops mid-breath, deliberately unresolved
 */
export type EndingKind = "victory" | "defeat" | "bittersweet" | "escape" | "draw" | "cliffhanger";

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
  /**
   * Structured conditions and the enforced action gate. `status` remains a
   * free-text flavor line; `canAct === false` (dead/incapacitated/stunned)
   * hard-disables this player's controller for the turn. Undefined = able.
   */
  conditions?: string[];
  canAct?: boolean;
  /** Presence (Phase 5): last time this player's controller polled, ms epoch. */
  lastSeenAt?: number;
  /** True once the player explicitly left (or timed out and was woven out). */
  away?: boolean;
  /**
   * True once a departure DM turn has written this hero out of the scene
   * (disconnect timeout). Cleared when they rejoin, so the return weave runs
   * exactly once per absence — never twice for the same disconnect.
   */
  wovenOut?: boolean;
  /** Which Location this player is currently in (party can split). */
  locationId?: string;
  /** Narrative zone within the current location. */
  zoneId?: string;
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
  /**
   * Group/mob support: when isGroup is true this NPC card represents a pool of
   * faceless rank-and-file (e.g. "Gang Members"), NOT a named individual.
   * `count` is how many are still standing; `maxCount` the size at first
   * encounter. Named/role NPCs (leader, lieutenant) are always their own
   * non-group card. The TV/controller show "×count" + "count left".
   */
  isGroup?: boolean;
  count?: number;
  maxCount?: number;
  /**
   * Structured combat conditions (Phase 3). Free-text `status` stays for
   * flavor; `canAct` is the enforced gate. A dead/incapacitated/stunned
   * combatant cannot act on its turn.
   */
  conditions?: string[];
  canAct?: boolean;
  /** Which Location this NPC/enemy is currently in. */
  locationId?: string;
  /** Narrative zone within the current location. */
  zoneId?: string;
};

export type SuggestedAction = {
  title: string;
  prompt: string;
};

/**
 * One player's locked-in choice during an exploration round (simultaneous
 * lock-in). Cleared when the round resolves.
 */
export type PendingAction = {
  action: string;
  display?: string;
  actionId?: string;
  /** Set when the player opted into a shared "together" action (its index). */
  partyActionId?: string;
  lockedAt: string;
};

/**
 * Turn state for the two-mode turn system (#1):
 *   exploration – simultaneous lock-in: everyone picks, then one combined
 *                 resolution. No per-player freeze; controllers say "waiting".
 *   combat      – sequential initiative: activeId acts, resolves, next, then
 *                 the enemies act, then loop. Others are locked to "not your turn".
 */
export type TurnState = {
  mode: "exploration" | "combat";
  /** Combat only: initiative order of player ids. */
  order?: string[];
  /** Combat only: whose turn it is now (a player id), or "enemies" for the NPC phase. */
  activeId?: string;
  /** Combat only: 1-based round counter. */
  round?: number;
  /** ISO deadline for the current turn/round; past it, idle/absent actors are skipped. */
  deadlineAt?: string;
};

/** A physical object present in a location (loot, cover prop, interactable). */
export type SceneObject = {
  name: string;
  note?: string;
  /** True when a player can pick this up into their inventory. */
  takeable?: boolean;
  /** Broad role; use "other" plus traits/state for unusual things. */
  kind?: "item" | "container" | "interactable" | "obstacle" | "clue" | "furniture" | "other";
  /** Narrative zone containing this object. */
  zoneId?: string;
  /** Flexible capabilities such as locked, readable, blocks-sight, or flammable. */
  traits?: string[];
  /** Small persistent facts such as locked=true, charges=2, or contents="medkit". */
  state?: Record<string, string | number | boolean>;
};

export type LocationZone = {
  id: string;
  name: string;
  description?: string;
  /** Zones reachable in one normal move. */
  adjacentZoneIds: string[];
};

export type LocationConnection = {
  destinationId: string;
  label?: string;
  /** Approximate journey cost, e.g. "1 turn", "5 minutes", or "several hours". */
  travelTime?: string;
  /** Whether ordinary voices carry between the locations. */
  communication?: "open" | "shouting" | "blocked";
};

/**
 * A tracked place in the world (Tier 1 grounding + Tier 2 split-party). Holds
 * the authoritative contents of the scene so the DM can't fabricate items/cover
 * and so multiple environments persist at once. Each location also carries its
 * own backdrop, ambience, and per-group turn state (the party can split).
 */
export type Location = {
  id: string;
  name: string;
  description?: string;
  /** What is physically here — the ONLY items/props that exist in this scene. */
  objects: SceneObject[];
  /** Named cover / terrain features usable in combat. */
  cover: string[];
  /** Where the party can go from here. */
  exits: string[];
  /** Narrative combat/exploration positions within this place. */
  zones?: LocationZone[];
  /** Structured links to other tracked locations. */
  connections?: LocationConnection[];
  hazards?: string[];
  /** Backdrop image id (from campaign.images) that depicts this place. */
  imageId?: string;
  /** Scene text the backdrop depicts (per-location analog of backdropScene). */
  backdropScene?: string;
  ambience?: Ambience;
  /** Per-location turn state + exploration lock-ins for the group present here. */
  turnState?: TurnState;
  pendingActions?: Record<string, PendingAction>;
  createdAt: string;
};

export type MessageSegment = {
  speaker: "narrator" | "npc" | "system" | "player";
  name?: string;
  content: string;
};

/**
 * Server-judged d20 result spectrum. Not binary — margin vs DC matters.
 *   critical-success  – natural 20
 *   strong-success    – beat DC by 5+
 *   success           – meet/beat DC by 0–4
 *   partial-success   – miss by 1–4 (progress with a cost) — only when difficulty allows
 *   failure           – miss by 1–4 (or any miss when partials are off)
 *   hard-failure      – miss by 5+
 *   critical-failure  – natural 1
 */
export type DiceOutcome =
  | "critical-success"
  | "strong-success"
  | "success"
  | "partial-success"
  | "failure"
  | "hard-failure"
  | "critical-failure";

export type DiceEvent = {
  notation: string;
  reason: string;
  rolls: number[];
  modifier: number;
  total: number;
  d20Mode?: "normal" | "advantage" | "disadvantage";
  /** Difficulty class the check was judged against (server-side). */
  dc?: number;
  /** How far the total sits from the DC (total - dc). Positive = over. */
  margin?: number;
  /** Server-judged result of the check — the narrator cannot fudge this. */
  outcome?: DiceOutcome;
  /** True when this roll is for an NPC/enemy (not a player). */
  isNpc?: boolean;
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
  /**
   * A cinematic effect LINKED to this beat: it fires the moment this beat is
   * performed on the TV (not at turn start), so a spell discharge, thunderclap,
   * or heartbeat lands exactly on the line that earns it. Unlinked effects (fired
   * immediately) still travel via campaign.effects.
   */
  effect?: BeatEffect;
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
 * "outro" is reserved for the closing credits after the campaign ends.
 */
export type AmbienceMood =
  | "calm"
  | "tense"
  | "adrenaline"
  | "battle"
  | "boss"
  | "mystery"
  | "dread"
  | "triumph"
  | "wonder"
  | "somber"
  | "outro";

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

/** Cinematic effect queued by the DM via trigger_effect. Supports repeats. */
export type StageEffect = {
  id: string;
  kind: StageEffectKind;
  /** 0..1 strength. */
  strength: number;
  /** How many times to fire (default 1). */
  repeat?: number;
  /** Delay in ms between repeats (default 0). */
  delayMs?: number;
  createdAt: string;
};

/**
 * A stage effect attached to a single story beat (DisplayEvent.effect). Same
 * knobs as StageEffect but without id/createdAt — it fires when the beat plays,
 * not the moment it lands in state.
 */
export type BeatEffect = {
  kind: StageEffectKind;
  /** 0..1 strength. Default 0.6. */
  strength?: number;
  /** How many times to fire (1-8). Default 1. */
  repeat?: number;
  /** Delay in ms between repeats (0-5000). Default 0. */
  delayMs?: number;
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

/** One line of the outro's stats board, e.g. { label: "Dragons Slain", value: "1" }. */
export type EndingStat = {
  label: string;
  value: string;
};

/**
 * One hero's credit line on the outro reel. The DM fills these so the credits
 * read like a film's cast crawl — each player gets an epithet, a fate/what they
 * did, and optional personal tallies. Matched back to a live Player by id or
 * name so the outro can also show their real final HP/portrait.
 */
export type EndingCastMember = {
  /** Player id (preferred) to match a live Player. */
  playerId?: string;
  /** Character or player name — a fallback match when no id is given. */
  name?: string;
  /** Epithet / title earned, e.g. "The Salt-Blind Prophet". */
  title?: string;
  /** 1-2 sentence fate: what they did across the saga and how they ended. */
  fate?: string;
  /** Optional personal tallies for their credit card (deeds, kills, lies). */
  stats?: EndingStat[];
};

/** Snapshot shown on the TV outro cinematic after the campaign ends. */
export type CampaignEnding = {
  kind: EndingKind;
  /** Short title, e.g. "The Fat Man Falls" or "Veridia Burns". */
  title: string;
  /** 1–3 sentence epilogue. */
  summary: string;
  /** When the ending was sealed. */
  endedAt: string;
  /** Optional highlight lines for the credits (key moments, final fates). */
  highlights?: string[];
  /** Optional campaign statistics for the outro's stats board. */
  stats?: EndingStat[];
  /** Optional per-player credit lines for the outro's cast reel. */
  cast?: EndingCastMember[];
};

export type Campaign = {
  id: string;
  title: string;
  joinCode: string;
  /** lobby → active → completed (after win/loss credits). */
  status: "lobby" | "active" | "completed";
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
  /**
   * Two-mode turn system (#1). Now stored PER-LOCATION (see `locations`); these
   * top-level fields are kept only for back-compat with old saves and mirror the
   * focused location's live turn state.
   */
  turnState?: TurnState;
  pendingActions?: Record<string, PendingAction>;
  /** Tracked places in the world. Always ≥1 (a default location is synthesized). */
  locations?: Location[];
  /** The location the TV is currently showing (intercut focus for split parties). */
  focusedLocationId?: string;
  memory: string;
  images: SceneImage[];
  portraits: PortraitImage[];
  currentImageUrl?: string;
  /**
   * The scene text the current backdrop depicts. The server compares this to
   * currentScene after each turn: when the scene has moved materially and the
   * DM didn't repaint, a scene-director pass reuses or paints a fresh backdrop.
   * (The small RP model reliably forgets the backdrop — this is the guarantee.)
   */
  backdropScene?: string;
  ambience?: Ambience;
  effects?: StageEffect[];
  dmStatus?: string;
  dmPhase?: DmPhase;
  /**
   * True while the TV is still typing out/holding this turn's beats. Broadcast
   * by the host so controllers can stay locked past the moment the server
   * finishes generating — narration can take much longer to PLAY than to
   * produce. Stale (old updatedAt) is treated as false so a closed TV can never
   * permanently lock the table.
   */
  presenting?: { active: boolean; updatedAt: number };
  /**
   * Running summary of everything BEFORE the recent transcript window, kept
   * current by the housekeeping pass (see runHousekeeping in aqua/chat.ts) so
   * the RP model retains long-term continuity without the full transcript
   * ballooning its context every turn. Empty until enough history piles up.
   */
  storySummary?: string;
  messages: ChatMessage[];
  campaignType?: CampaignType;
  /**
   * Score instrumentation flavor for this campaign (e.g. "fantasy", "scifi",
   * "modern"). Chosen once at campaign start; biases which music shelf plays.
   * Undefined → the neutral mood roots. See lib/campaign/musicTheme.ts.
   */
  musicTheme?: string;
  isRandomized?: boolean;
  campaignLength?: "auto" | "short" | "medium" | "long" | "extra_long" | "infinite";
  rulesMode?: "casual" | "full";
  /** Challenge tuning. Default medium. */
  difficulty?: Difficulty;
  /** How often d20 checks fire. Default standard (risk-gated). */
  rollMode?: RollMode;
  /** Filled when the campaign reaches a win/loss/bittersweet close. */
  ending?: CampaignEnding;
  /**
   * The DM's private story plan, mirrored from storyline.md in the campaign's
   * safe storage. High-level chapter arc, the intended ending, where the party
   * is now, and any deviations. Re-read from disk each turn (like questLog) so
   * it stays anchored in context without spending a read_campaign_file call.
   */
  storyline?: string;
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

export type CampaignSummary = Pick<
  Campaign,
  | "id"
  | "title"
  | "joinCode"
  | "status"
  | "updatedAt"
  | "hostActiveAt"
  | "campaignType"
  | "isRandomized"
  | "campaignLength"
  | "rulesMode"
  | "difficulty"
  | "rollMode"
> & {
  playerCount: number;
  isHostActive?: boolean;
  endingKind?: EndingKind;
};
